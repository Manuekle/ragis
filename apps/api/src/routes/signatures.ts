import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Deps } from "../app.js";
import { withContext, type Db } from "../db/pool.js";
import { ApiError, badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { loadPolicy } from "../lib/external-actions.js";
import { normalizeSignatureImage, SignatureAppearance, SignatureImageInput } from "../lib/signature-image.js";
import { assertUuid, audit, hasRole, isAdmin, tx } from "../lib/tenant.js";
import {
  canApproveManual, dispatchNativeEnvelope, openNativeEnvelope, recordNativeDecision, renewSignatureInvite, SIGN_CONSENT,
  SIGNABLE_STATES, signalNativeDecision, signatureBinding, snapshotSignatureDocs, withSignatureInvite, type NativeEnvelope,
} from "../lib/signature-native.js";
import { auditAs, emit, type WorkflowRunner } from "../lib/workflow-runner.js";
import { canSeeEnvelope } from "./external.js";

const signer = z.object({ name: z.string().trim().min(2).max(120), email: z.string().trim().toLowerCase().pipe(z.email()) }).strict();
const draft = z.object({
  subject: z.string().trim().min(2).max(160),
  version_ids: z.array(z.uuid()).min(1).max(10).refine((ids) => new Set(ids).size === ids.length, "unique documents required"),
  signers: z.array(signer).min(1).max(10).refine((signers) => new Set(signers.map((s) => s.email)).size === signers.length, "unique signer emails required"),
}).strict();
const decision = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("sign"), typed_name: z.string().trim().min(2).max(120).regex(/^[^\p{Cc}\p{Cf}]+$/u), consent: z.literal(true), appearance: SignatureAppearance.optional() }).strict(),
  z.object({ decision: z.literal("decline"), reason: z.string().trim().max(500).optional() }).strict(),
]);

const meta = (req: FastifyRequest) => ({ ip: req.ip, userAgent: req.headers["user-agent"] });
async function nativeEnvelope(db: Db, id: string, lock = false) {
  const env = (await db.query(
    `SELECT * FROM signature_envelopes WHERE id=$1 AND provider='native'${lock ? " FOR UPDATE" : ""}`, [assertUuid(id, "envelope")],
  )).rows[0] as NativeEnvelope | undefined;
  if (!env) throw notFound("envelope");
  return env;
}

async function documentUrl(deps: Deps, env: NativeEnvelope, version: string) {
  const doc = env.documents.find((d) => d.version_id === version);
  if (!doc) throw notFound("document");
  return { url: await deps.storage.presignGet(doc.s3_key, doc.filename, 60, "inline", "application/pdf") };
}

export async function nativeSignatureRoutes(app: FastifyInstance, deps: Deps, runner: WorkflowRunner) {
  const { pool } = deps;
  const base = "/v1/organizations/:org/signatures";
  const enabled = () => {
    if (deps.esign.name !== "native") throw conflict("Ragsis Sign is disabled");
  };
  const envelopeId = (req: FastifyRequest) => (req.params as { id: string }).id;

  app.get("/v1/me/signatures", async (req, reply) => {
    reply.header("cache-control", "no-store");
    return withContext(pool, { userId: req.user!.userId }, async (db) => {
      const { rows } = await db.query<{ id: string; label: string; image: string }>(
        `SELECT id, label, replace(encode(image_png, 'base64'), chr(10), '') AS image
         FROM personal_signatures ORDER BY created_at DESC, id`,
      );
      return { signatures: rows };
    });
  });

  app.post("/v1/me/signatures", async (req, reply) => {
    enabled();
    const user = req.user!;
    if (!user.emailVerified) throw forbidden("a verified email is required to save signatures");
    if (!deps.limiter.take(`personal-signature:${user.userId}`, 15)) throw new ApiError(429, "rate_limited", "Try again in a minute.");
    const body = z.object({ label: z.string().trim().min(1).max(60), image: SignatureImageInput }).strict().parse(req.body);
    const png = await normalizeSignatureImage(body.image);
    const saved = await withContext(pool, { userId: user.userId }, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext('personal-signatures:' || $1))", [user.userId]);
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO personal_signatures (user_id, label, image_png)
         SELECT $1,$2,$3 WHERE (SELECT count(*) FROM personal_signatures) < 6 RETURNING id`,
        [user.userId, body.label, png],
      );
      if (!rows[0]) throw conflict("You can keep up to 6 saved signatures. Remove one to add another.");
      return { id: rows[0].id, label: body.label, image: png.toString("base64") };
    });
    return reply.code(201).header("cache-control", "no-store").send(saved);
  });

  app.delete("/v1/me/signatures/:id", async (req, reply) => {
    const id = assertUuid(envelopeId(req), "saved signature");
    const result = await withContext(pool, { userId: req.user!.userId }, (db) =>
      db.query("DELETE FROM personal_signatures WHERE id=$1", [id]),
    );
    if (!result.rowCount) throw notFound("saved signature");
    return reply.code(204).send();
  });

  app.get(`${base}/eligible-documents`, async (req) => {
    const t = req.tenant!;
    if (t.role === "viewer") throw forbidden();
    return tx(pool, t, async (db) => ({
      documents: (await db.query(
        `SELECT v.id AS version_id, d.title, v.filename FROM documents d JOIN document_versions v ON v.id=d.current_version_id
         WHERE d.status='active' AND v.status='indexed' AND v.content_type='application/pdf'
         ORDER BY d.title, v.id LIMIT 200`,
      )).rows,
    }));
  });

  app.post(base, async (req, reply) => {
    enabled();
    const t = req.tenant!;
    if (t.role === "viewer") throw forbidden();
    const body = draft.parse(req.body);
    const key = z.uuid().parse(req.headers["idempotency-key"]);
    const scopedKey = `manual:${t.userId}:${key}`;
    const result = await tx(pool, t, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [scopedKey]);
      const prior = (await db.query("SELECT id, subject, documents, signers, state FROM signature_envelopes WHERE idempotency_key=$1", [scopedKey])).rows[0] as NativeEnvelope | undefined;
      if (prior) {
        if (prior.subject !== body.subject || prior.documents.length !== body.version_ids.length ||
          prior.documents.some((doc, index) => doc.version_id !== body.version_ids[index]) ||
          prior.signers.length !== body.signers.length || prior.signers.some((s, index) => s.email !== body.signers[index]?.email || s.name !== body.signers[index]?.name)) {
          throw conflict("this request key was used for a different draft");
        }
        return { id: prior.id, state: prior.state, replay: true };
      }
      const rows = (await db.query(
        `SELECT v.id AS version_id, v.document_id, v.s3_key, v.filename, v.checksum_sha256, v.size_bytes, d.title
         FROM document_versions v JOIN documents d ON d.id=v.document_id AND d.current_version_id=v.id
         WHERE d.status='active' AND v.status='indexed' AND v.id=ANY($1::uuid[])`, [body.version_ids],
      )).rows;
      if (rows.length !== body.version_ids.length) throw badRequest("select current PDFs you can access from the Library");
      const id = randomUUID();
      const docs = await snapshotSignatureDocs(deps, t.organizationId, id, body.version_ids.map((vid) => rows.find((row) => row.version_id === vid)!));
      await db.query(
        `INSERT INTO signature_envelopes (id, organization_id, provider, external_id, subject, documents, signers, idempotency_key, created_by)
         VALUES ($1::uuid,$2,'native',$1::uuid::text,$3,$4::jsonb,$5::jsonb,$6,$7)`,
        [id, t.organizationId, body.subject, JSON.stringify(docs), JSON.stringify(body.signers), scopedKey, t.userId],
      );
      await emit(db, t.organizationId, "SIGNATURE_DRAFT_CREATED", id, `envelope:${id}`, { provider: "native", signers: body.signers.length });
      await audit(db, t, "signature.draft_created", `envelope:${id}`);
      return { id, state: "DRAFT", replay: false };
    });
    reply.code(result.replay ? 200 : 201);
    return result;
  });

  app.post(`${base}/:id/send`, async (req) => {
    enabled();
    const t = req.tenant!;
    const body = z.object({ action_hash: z.string().regex(/^[0-9a-f]{64}$/) }).strict().parse(req.body);
    return tx(pool, t, async (db) => {
      const env = await nativeEnvelope(db, envelopeId(req), true);
      if (env.run_id) throw forbidden("use the workflow approval");
      if (env.state !== "DRAFT") throw conflict("this envelope has already been processed");
      if (!canApproveManual(t, env)) throw forbidden("a different signatory or admin must approve this draft");
      if ((await loadPolicy(db, t.organizationId)).require_mfa_for_signature && !req.user!.amr.some((method) => ["mfa", "otp", "hwk", "swk"].includes(method))) {
        throw new ApiError(403, "mfa_required", "approving a signature send requires multi-factor authentication");
      }
      if (body.action_hash !== signatureBinding(env)) throw conflict("the approved contents do not match the envelope");
      await dispatchNativeEnvelope(deps, db, env, t.userId);
      const binding = { approved_by: t.userId, action_hash: body.action_hash };
      await emit(db, t.organizationId, "SIGNATURE_SENT", env.id, `envelope:${env.id}`, binding);
      await audit(db, t, "signature.sent", `envelope:${env.id}`, "allow", binding);
      return { state: "SENT" };
    });
  });

  app.get(`${base}/:id/documents/:version`, async (req) => {
    const t = req.tenant!;
    return tx(pool, t, async (db) => {
      const env = await nativeEnvelope(db, envelopeId(req), true);
      const email = req.user!.email.toLowerCase();
      if (!(await canSeeEnvelope(db, t, email, env))) throw notFound("envelope");
      const version = (req.params as { version: string }).version;
      const isSigner = env.signers.some((s) => s.email === email) && req.user!.emailVerified;
      const approver = env.state === "DRAFT" && hasRole(t, "signatory");
      if ((!isSigner || !["SENT", "DELIVERED", "COMPLETED"].includes(env.state)) && !canApproveManual(t, env) && !approver) {
        if (!(await db.query("SELECT 1 FROM document_versions WHERE id=$1", [assertUuid(version, "document")])).rowCount) throw notFound("document");
      }
      if (isSigner) await openNativeEnvelope(db, env);
      await audit(db, t, "signature.document_opened", `envelope:${env.id}`, "allow", { version_id: version });
      return documentUrl(deps, env, version);
    });
  });

  app.post(`${base}/:id/respond`, async (req) => {
    enabled();
    const t = req.tenant!;
    const user = req.user!;
    if (!user.emailVerified) throw forbidden("a verified email is required to sign");
    const body = decision.parse(req.body);
    const { env, result } = await tx(pool, t, async (db) => {
      const env = await nativeEnvelope(db, envelopeId(req), true);
      const result = await recordNativeDecision(deps, db, env, { email: user.email.toLowerCase(), id: t.userId }, body, meta(req));
      return { env, result };
    });
    await signalNativeDecision(runner, env, result.state);
    return result;
  });

  app.post(`${base}/:id/remind`, async (req) => {
    enabled();
    const t = req.tenant!;
    const { email } = z.object({ email: z.string().trim().toLowerCase().pipe(z.email()) }).strict().parse(req.body);
    return tx(pool, t, async (db) => {
      const env = await nativeEnvelope(db, envelopeId(req), true);
      if (!isAdmin(t) && env.created_by !== t.userId) throw forbidden("only the sender or an admin can resend invitations");
      return renewSignatureInvite(deps, db, env, email, t.userId);
    });
  });

  app.get("/v1/signature-proof/:id", async (req, reply) => {
    reply.header("cache-control", "no-store");
    if (!deps.limiter.take(`signature-proof:${req.ip}`, 120)) throw new ApiError(429, "rate_limited", "Try again in a minute.");
    const id = assertUuid(envelopeId(req), "verification record");
    const record = (await withContext(pool, {}, (db) => db.query("SELECT * FROM app.native_signature_proof($1)", [id]))).rows[0];
    if (!record) throw notFound("verification record");
    return record;
  });

  await app.register(async (guest) => {
    const token = (req: FastifyRequest) => req.headers.authorization?.match(/^Signature ([A-Za-z0-9_-]{43})$/)?.[1] ?? "";
    guest.addHook("onRequest", async (req, reply) => {
      reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer");
      if (!deps.limiter.take(`signature-guest:${req.ip}`, 300)) throw new ApiError(429, "rate_limited", "Try again in a minute.");
    });

    guest.post("/v1/signature-guest/open", async (req) => withSignatureInvite(deps, token(req), async (db, env, invite) => {
      if (!invite.opened_at) {
        await db.query("UPDATE signature_invitations SET opened_at=now() WHERE id=$1", [invite.id]);
        await auditAs(db, env.organization_id, null, "signature.invite_opened", `envelope:${env.id}`, "allow", { signer: invite.signer_email, ip: req.ip });
      }
      await openNativeEnvelope(db, env);
      const responded = (await db.query("SELECT 1 FROM signature_responses WHERE envelope_id=$1 AND signer_email=$2", [env.id, invite.signer_email])).rowCount;
      return {
        subject: env.subject, state: env.state, consent_text: SIGN_CONSENT, email: invite.signer_email,
        awaiting_me: !responded && SIGNABLE_STATES.includes(env.state),
        documents: env.documents.map(({ version_id, title, filename }) => ({ version_id, title, filename })),
      };
    }));

    guest.post("/v1/signature-guest/document", async (req) => {
      const { version_id } = z.object({ version_id: z.uuid() }).strict().parse(req.body);
      return withSignatureInvite(deps, token(req), async (db, env, invite) => {
        const result = await documentUrl(deps, env, version_id);
        await auditAs(db, env.organization_id, null, "signature.document_opened", `envelope:${env.id}`, "allow", { signer: invite.signer_email, version_id });
        return result;
      });
    });

    guest.post("/v1/signature-guest/respond", async (req) => {
      enabled();
      const body = decision.parse(req.body);
      const { env, result } = await withSignatureInvite(deps, token(req), async (db, env, invite) => ({
        env, result: await recordNativeDecision(deps, db, env, { email: invite.signer_email, id: null }, body, meta(req)),
      }));
      await signalNativeDecision(runner, env, result.state);
      return result;
    });

    guest.post("/v1/signature-guest/signed", async (req) => withSignatureInvite(deps, token(req), async (db, env, invite) => {
      if (env.state !== "COMPLETED" || !env.evidence.signed_key) throw notFound("signed document");
      await auditAs(db, env.organization_id, null, "signature.evidence_downloaded", `envelope:${env.id}`, "allow", { signer: invite.signer_email, kind: "signed" });
      return { url: await deps.storage.presignGet(env.evidence.signed_key, "signed.pdf", 60) };
    }));
  });
}
