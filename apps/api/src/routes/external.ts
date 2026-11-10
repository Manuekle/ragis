import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../app.js";
import { withContext, type Db } from "../db/pool.js";
import { conflict, forbidden, notFound } from "../lib/errors.js";
import { loadPolicy, localSign, newToken, processSignatureEvent, sha256 } from "../lib/external-actions.js";
import { canApproveManual, restoreNativeLifecycle, SIGN_CONSENT, signatureBinding } from "../lib/signature-native.js";
import { assertUuid, audit, hasRole, isAdmin, tx, type TenantContext } from "../lib/tenant.js";
import { emit, type WorkflowRunner } from "../lib/workflow-runner.js";

const Domain = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?!-)[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/, "domain like example.com");
const PolicyBody = z
  .object({
    allowed_domains: z.array(Domain).max(100),
    share_max_days: z.number().int().min(1).max(30),
    approval_max_age_hours: z.number().int().min(1).max(168),
    require_mfa_for_signature: z.boolean(),
  })
  .strict();
const LocalSignBody = z.object({ decision: z.enum(["sign", "decline"]), typed_name: z.string().trim().min(2).max(120), consent: z.literal(true) }).strict();

/** Quién ve un sobre: admin, auditor, firmante autorizado (signatory), iniciador del run o firmante del sobre. */
export async function canSeeEnvelope(db: Db, t: TenantContext, email: string, env: { run_id: string | null; created_by: string; signers: { email: string }[] }) {
  if (isAdmin(t) || hasRole(t, "auditor") || hasRole(t, "signatory") || env.created_by === t.userId) return true;
  if (env.signers.some((s) => s.email === email.toLowerCase())) return true;
  if (env.run_id) {
    const r = await db.query("SELECT 1 FROM workflow_runs WHERE id=$1 AND initiated_by=$2", [env.run_id, t.userId]);
    return !!r.rowCount;
  }
  return false;
}

export async function externalRoutes(app: FastifyInstance, deps: Deps, runner: WorkflowRunner) {
  const { pool, storage, cfg } = deps;
  const base = "/v1/organizations/:org";

  // ---------------------------------------------------------------- públicas (sin sesión)
  await app.register(async (pub) => {
    // HMAC sobre el cuerpo crudo: este contexto no parsea JSON.
    pub.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: 512 * 1024 }, (_req, body, done) => done(null, body));
    pub.post("/v1/webhooks/signatures/:provider", async (req, reply) => {
      const provider = (req.params as { provider: string }).provider;
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
      const res = await processSignatureEvent(deps, runner, provider, raw, req.headers);
      reply.code(res.status);
      return res.body;
    });
  });

  app.get("/v1/shares/access/:token", async (req, reply) => {
    const token = (req.params as { token: string }).token;
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      reply.code(404);
      return { error: { code: "not_found" } };
    }
    // Sin tenant: la función valida el hash del token, caducidad y revocación y audita el intento.
    const r = (await withContext(pool, {}, (db) => db.query("SELECT status, s3_key, filename FROM app.open_share($1, $2)", [sha256(token), req.ip]))).rows[0];
    if (r.status !== "ok") {
      reply.code(r.status === "not_found" ? 404 : 410);
      return { error: { code: r.status } };
    }
    // URL prefirmada de vida corta: el enlace público nunca expone la clave S3 ni credenciales.
    return reply.redirect(await storage.presignGet(r.s3_key, r.filename, 60, "attachment"), 302);
  });

  // ---------------------------------------------------------------- política externa
  app.get(`${base}/external-policy`, async (req) => {
    const t = req.tenant!;
    return tx(pool, t, async (db) => ({ ...(await loadPolicy(db, t.organizationId)), can_edit: isAdmin(t), esign_provider: deps.esign.name }));
  });

  app.put(`${base}/external-policy`, async (req) => {
    const t = req.tenant!;
    if (!isAdmin(t)) throw forbidden("requires admin");
    const body = PolicyBody.parse(req.body);
    return tx(pool, t, async (db) => {
      const before = await loadPolicy(db, t.organizationId);
      await db.query(
        `INSERT INTO external_policies (organization_id, allowed_domains, share_max_days, approval_max_age_hours, require_mfa_for_signature, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (organization_id) DO UPDATE SET allowed_domains=EXCLUDED.allowed_domains, share_max_days=EXCLUDED.share_max_days,
           approval_max_age_hours=EXCLUDED.approval_max_age_hours, require_mfa_for_signature=EXCLUDED.require_mfa_for_signature,
           updated_by=EXCLUDED.updated_by, updated_at=now()`,
        [t.organizationId, [...new Set(body.allowed_domains)], body.share_max_days, body.approval_max_age_hours, body.require_mfa_for_signature, t.userId],
      );
      await audit(db, t, "external_policy.updated", `organization:${t.organizationId}`, "allow", { from: before, to: body });
      return { ...body, can_edit: true, esign_provider: deps.esign.name };
    });
  });

  // ---------------------------------------------------------------- sobres de firma
  app.get(`${base}/signatures`, async (req) => {
    const t = req.tenant!;
    const email = req.user!.email.toLowerCase();
    return tx(pool, t, async (db) => {
      const all = isAdmin(t) || hasRole(t, "auditor") || hasRole(t, "signatory");
      const rows = (
        await db.query(
          `SELECT e.id, e.run_id, e.provider, e.state, e.subject, e.documents, e.signers, e.created_at, e.sent_at, e.completed_at, e.voided_reason,
                  w.name AS workflow_name,
                  (SELECT count(*)::int FROM signature_responses l WHERE l.envelope_id = e.id AND l.decision = 'signed') AS signed_count,
                  EXISTS (SELECT 1 FROM signature_responses l WHERE l.envelope_id = e.id AND l.signer_email = $3) AS i_responded
             FROM signature_envelopes e
             LEFT JOIN workflow_runs r ON r.id = e.run_id LEFT JOIN workflows w ON w.id = r.workflow_id
            WHERE $1 OR e.created_by = $2 OR r.initiated_by = $2 OR e.signers @> jsonb_build_array(jsonb_build_object('email', $3::text))
            ORDER BY e.created_at DESC LIMIT 100`,
          [all, t.userId, email],
        )
      ).rows;
      return {
        provider: deps.esign.name,
        can_create: deps.esign.name === "native" && t.role !== "viewer",
        envelopes: rows.map((r) => ({
          ...r,
          documents: (r.documents as { title: string; version_id: string; sha256: string }[]).map(({ title, version_id, sha256: h }) => ({ title, version_id, sha256: h })),
          awaiting_me: ["SENT", "DELIVERED"].includes(r.state) && (r.signers as { email: string }[]).some((s) => s.email === email) && !r.i_responded,
        })),
      };
    });
  });

  app.get(`${base}/signatures/:id`, async (req) => {
    const t = req.tenant!;
    const id = assertUuid((req.params as { id: string }).id, "envelope");
    const email = req.user!.email.toLowerCase();
    return tx(pool, t, async (db) => {
      const env = (await db.query("SELECT * FROM signature_envelopes WHERE id=$1", [id])).rows[0];
      if (!env || !(await canSeeEnvelope(db, t, email, env))) throw notFound("envelope");
      const responses = (await db.query("SELECT signer_email, decision, typed_name, signed_at FROM signature_responses WHERE envelope_id=$1 ORDER BY signed_at", [id])).rows;
      const events = (await db.query("SELECT event_id, type, payload, occurred_at FROM outbox_events WHERE aggregate_id=$1 ORDER BY occurred_at", [`envelope:${id}`])).rows;
      const canManage = isAdmin(t) || env.created_by === t.userId;
      const invitations = canManage ? (await db.query(
        "SELECT signer_email, sent_at, opened_at, expires_at, attempts FROM signature_invitations WHERE envelope_id=$1 ORDER BY signer_email",
        [id],
      )).rows : [];
      const { evidence, documents, ...rest } = env;
      return {
        ...rest,
        documents: (documents as { title: string; version_id: string; sha256: string; filename: string }[]).map(({ title, version_id, sha256: h, filename }) => ({ title, version_id, sha256: h, filename })),
        evidence: { signed: !!evidence.signed_key, certificate: !!evidence.certificate_key, signed_sha256: evidence.signed_sha256 ?? null, certificate_sha256: evidence.certificate_sha256 ?? null, stamped: evidence.stamped ?? null, source: evidence.source ?? null },
        responses,
        events,
        invitations,
        awaiting_me: ["SENT", "DELIVERED"].includes(env.state) && (env.signers as { email: string }[]).some((s) => s.email === email) && !responses.some((r) => r.signer_email === email),
        can_void: ["DRAFT", "SENT", "DELIVERED"].includes(env.state) && canManage,
        local_signing: env.provider === "local" && deps.esign.name === "local",
        native_signing: env.provider === "native" && deps.esign.name === "native" && req.user!.emailVerified,
        consent_text: env.provider === "native" ? SIGN_CONSENT : null,
        action_hash: deps.esign.name === "native" && canApproveManual(t, env) ? signatureBinding(env) : null,
      };
    });
  });

  app.post(`${base}/signatures/:id/local-sign`, async (req) => {
    const t = req.tenant!;
    const id = assertUuid((req.params as { id: string }).id, "envelope");
    const body = LocalSignBody.parse(req.body);
    return localSign(deps, runner, t, req.user!, id, body, { ip: req.ip, userAgent: req.headers["user-agent"] });
  });

  app.post(`${base}/signatures/:id/void`, async (req) => {
    const t = req.tenant!;
    const id = assertUuid((req.params as { id: string }).id, "envelope");
    const reason = z.object({ reason: z.string().trim().min(3).max(200) }).strict().parse(req.body).reason;
    const env = await tx(pool, t, async (db) => {
      const env = (await db.query("SELECT * FROM signature_envelopes WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!env) throw notFound("envelope");
      if (!isAdmin(t) && env.created_by !== t.userId) throw forbidden("only the creator or an admin can void");
      if (!["DRAFT", "SENT", "DELIVERED"].includes(env.state)) throw conflict(`envelope is ${env.state}`);
      await db.query("UPDATE signature_envelopes SET state='VOIDED', voided_reason=$2, updated_at=now() WHERE id=$1", [id, reason]);
      if (env.provider === "native" && env.state !== "DRAFT") await restoreNativeLifecycle(db, env);
      await emit(db, t.organizationId, "SIGNATURE_VOIDED", env.run_id ?? id, `envelope:${id}`, { by: t.userId, reason });
      await audit(db, t, "signature.voided", `envelope:${id}`, "allow", { reason });
      return env;
    });
    if (env.run_id) await runner.signal(t.organizationId, env.run_id);
    return { state: "VOIDED" };
  });

  app.get(`${base}/signatures/:id/evidence/:kind`, async (req) => {
    const t = req.tenant!;
    const { id, kind } = req.params as { id: string; kind: string };
    assertUuid(id, "envelope");
    if (kind !== "signed" && kind !== "certificate") throw notFound("evidence");
    return tx(pool, t, async (db) => {
      const env = (await db.query("SELECT * FROM signature_envelopes WHERE id=$1", [id])).rows[0];
      if (!env || !(await canSeeEnvelope(db, t, req.user!.email, env))) throw notFound("envelope");
      const key = kind === "signed" ? env.evidence.signed_key : env.evidence.certificate_key;
      if (!key || env.state !== "COMPLETED") throw notFound("evidence");
      await audit(db, t, "signature.evidence_downloaded", `envelope:${id}`, "allow", { kind });
      const filename = kind === "signed" ? env.evidence.signed_filename ?? "signed.pdf" : env.evidence.certificate_filename ?? String(key).split("/").pop()!;
      return { url: await storage.presignGet(key, filename, cfg.DOWNLOAD_URL_TTL_SECONDS) };
    });
  });

  // ---------------------------------------------------------------- enlaces compartidos
  app.get(`${base}/shares`, async (req) => {
    const t = req.tenant!;
    return tx(pool, t, async (db) => {
      const all = isAdmin(t) || hasRole(t, "auditor") || hasRole(t, "approver");
      const rows = (
        await db.query(
          `SELECT s.id, s.run_id, s.artifact, s.title, s.recipients, s.expires_at, s.revoked_at, s.access_count, s.last_access_at, s.created_at,
                  s.created_by, u.email AS approved_by_email
             FROM shares s LEFT JOIN users u ON u.id = s.approved_by
            WHERE $1 OR s.created_by = $2 ORDER BY s.created_at DESC LIMIT 100`,
          [all, t.userId],
        )
      ).rows;
      return {
        shares: rows.map((s) => ({
          ...s,
          status: s.revoked_at ? "revoked" : new Date(s.expires_at) < new Date() ? "expired" : "active",
          can_manage: isAdmin(t) || s.created_by === t.userId,
        })),
      };
    });
  });

  const manageShare = async (db: Db, t: TenantContext, id: string) => {
    const s = (await db.query("SELECT * FROM shares WHERE id=$1 FOR UPDATE", [id])).rows[0];
    if (!s) throw notFound("share");
    if (!isAdmin(t) && s.created_by !== t.userId) throw forbidden("only the creator or an admin can manage this link");
    return s;
  };

  app.post(`${base}/shares/:id/revoke`, async (req) => {
    const t = req.tenant!;
    const id = assertUuid((req.params as { id: string }).id, "share");
    return tx(pool, t, async (db) => {
      const s = await manageShare(db, t, id);
      if (s.revoked_at) throw conflict("already revoked");
      await db.query("UPDATE shares SET revoked_at=now() WHERE id=$1", [id]);
      await emit(db, t.organizationId, "SHARE_REVOKED", s.run_id ?? id, `share:${id}`, { by: t.userId });
      await audit(db, t, "share.revoked", `share:${id}`);
      return { status: "revoked" };
    });
  });

  // El token no se guarda: revelar rota el token (el enlace anterior deja de funcionar) y lo muestra una vez.
  app.post(`${base}/shares/:id/reveal`, async (req) => {
    const t = req.tenant!;
    const id = assertUuid((req.params as { id: string }).id, "share");
    return tx(pool, t, async (db) => {
      const s = await manageShare(db, t, id);
      if (s.revoked_at) throw conflict("link revoked");
      if (new Date(s.expires_at) < new Date()) throw conflict("link expired");
      const token = newToken();
      await db.query("UPDATE shares SET token_hash=$2 WHERE id=$1", [id, sha256(token)]);
      await audit(db, t, "share.link_revealed", `share:${id}`, "allow", { rotated: true });
      return { url: `${cfg.PUBLIC_BASE_URL.replace(/\/$/, "")}/s/${token}`, expires_at: s.expires_at, recipients: s.recipients };
    });
  });
}
