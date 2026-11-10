import { createHmac, randomUUID } from "node:crypto";
import type { Deps } from "../app.js";
import { withContext, type Db } from "../db/pool.js";
import { ApiError, badRequest, conflict, forbidden, notFound } from "./errors.js";
import { blockedRecipients, loadPolicy, setLifecycle, sha256, type EnvDoc } from "./external-actions.js";
import { canonical } from "./policy.js";
import type { SignatureMailKind } from "./signature-email.js";
import { normalizeSignatureImage, readPersonalSignature, type SignatureAppearance } from "./signature-image.js";
import { MAX_SIGNATURE_BYTES, MAX_SIGNATURE_PAGES, signaturePdf, writeSignatureEvidence } from "./signature-evidence.js";
import { hasRole, isAdmin, type TenantContext } from "./tenant.js";
import { auditAs, emit, type WorkflowRunner } from "./workflow-runner.js";

export const SIGN_CONSENT = "I reviewed the documents in this envelope, agree to use electronic records and signatures, and intend to sign them.";
export const SIGNABLE_STATES = ["SENT", "DELIVERED"];

export interface Signer { name: string; email: string }
export interface NativeEnvelope {
  id: string;
  organization_id: string;
  run_id: string | null;
  created_by: string;
  state: string;
  provider: string;
  subject: string | null;
  documents: EnvDoc[];
  signers: Signer[];
  sent_at: Date;
  sent_by: string;
  evidence: Record<string, string | undefined>;
}

interface InvitationKey { organization_id: string; envelope_id: string; id: string }
interface Invitation extends InvitationKey {
  signer_email: string; opened_at: Date | null; expires_at: Date; token_hash: string; delivery_kind: SignatureMailKind; attempts: number;
}
export type SignatureDecision =
  | { decision: "sign"; typed_name: string; consent: true; appearance?: SignatureAppearance }
  | { decision: "decline"; reason?: string };

export function signatureBinding(env: Pick<NativeEnvelope, "id" | "subject" | "documents" | "signers">) {
  return sha256(canonical({
    id: env.id, subject: env.subject,
    documents: env.documents.map(({ version_id, sha256 }) => ({ version_id, sha256 })),
    signers: env.signers,
  }));
}

export function canApproveManual(t: TenantContext, env: NativeEnvelope) {
  return env.provider === "native" && env.state === "DRAFT" && !env.run_id && env.created_by !== t.userId && (isAdmin(t) || hasRole(t, "signatory"));
}

export async function snapshotSignatureDocs(
  deps: Deps, orgId: string, envelopeId: string,
  files: { document_id: string; version_id: string; title: string; filename: string; s3_key: string; checksum_sha256: string | null; size_bytes?: string }[],
) {
  let bytesTotal = 0;
  let pages = 0;
  const docs: EnvDoc[] = [];
  const copies: Buffer[] = [];
  for (const file of files) {
    if (Number(file.size_bytes) > MAX_SIGNATURE_BYTES - bytesTotal) throw badRequest("signature envelopes support up to 20 MB of PDFs");
    const bytes = await deps.storage.get(file.s3_key);
    if (!bytes) throw conflict("a document is unavailable");
    bytesTotal += bytes.length;
    if (bytesTotal > MAX_SIGNATURE_BYTES) throw badRequest("signature envelopes support up to 20 MB of PDFs");
    const hash = sha256(bytes);
    if (file.checksum_sha256 && hash !== file.checksum_sha256) throw conflict("a document does not match its recorded checksum");
    pages += (await signaturePdf(bytes)).getPageCount();
    if (pages > MAX_SIGNATURE_PAGES) throw badRequest("signature envelopes support up to 400 PDF pages");
    const key = `tenants/${orgId}/signatures/${envelopeId}/source/${file.version_id}-${hash}.pdf`;
    docs.push({ document_id: file.document_id, version_id: file.version_id, title: file.title, filename: file.filename, sha256: hash, s3_key: key });
    copies.push(bytes);
  }
  for (const [index, doc] of docs.entries()) await deps.storage.put(doc.s3_key, copies[index]!, "application/pdf");
  return docs;
}

function inviteToken(deps: Deps, id: string) {
  return createHmac("sha256", deps.cfg.INTERNAL_SERVICE_SECRET).update(`ragsis-signature-invitation-v1:${id}`).digest("base64url");
}

function inviteUrl(deps: Deps, token: string) {
  return `${deps.cfg.PUBLIC_BASE_URL.replace(/\/$/, "")}/sign#${token}`;
}

async function documentStatuses(db: Db, env: NativeEnvelope) {
  return (await db.query("SELECT * FROM app.signature_document_status($1)", [env.documents.map((doc) => doc.document_id)])).rows;
}

async function checkExternalAccess(db: Db, env: NativeEnvelope, emails: string[], docs: Awaited<ReturnType<typeof documentStatuses>>) {
  if (!emails.length) return;
  if (docs.length !== env.documents.length || docs.some((doc) => doc.classification === "restricted" || doc.status !== "active")) {
    throw forbidden("restricted or unavailable documents cannot be sent to external signers");
  }
  if (blockedRecipients(await loadPolicy(db, env.organization_id), emails).length) throw forbidden("an external signer is outside the allowed domains");
}

export async function dispatchNativeEnvelope(deps: Deps, db: Db, env: NativeEnvelope, approvedBy: string) {
  const docs = await documentStatuses(db, env);
  if (env.documents.some((doc) => !docs.some((d) => d.id === doc.document_id && d.current_version_id === doc.version_id && d.status === "active"))) {
    throw conflict("a document changed after the draft was prepared");
  }
  const members = (await db.query(
    `SELECT lower(u.email) AS email FROM memberships m JOIN users u ON u.id=m.user_id
      WHERE m.organization_id=$1 AND m.status='active' AND lower(u.email)=ANY($2::text[])`,
    [env.organization_id, env.signers.map((s) => s.email)],
  )).rows;
  const guests = env.signers.filter((signer) => !members.some((member) => member.email === signer.email));
  await checkExternalAccess(db, env, guests.map((signer) => signer.email), docs);
  if (guests.length && !deps.signatureMailer && deps.cfg.AUTH_MODE !== "dev") {
    throw new ApiError(409, "signature_email_unavailable", "Configure signature email delivery before inviting external signers.");
  }

  for (const guest of guests) {
    const id = randomUUID();
    await db.query(
      `INSERT INTO signature_invitations (id, organization_id, envelope_id, signer_email, token_hash, expires_at)
       VALUES ($1,$2,$3,$4,$5,now() + interval '7 days')`,
      [id, env.organization_id, env.id, guest.email, sha256(inviteToken(deps, id))],
    );
  }
  await db.query("UPDATE signature_envelopes SET state='SENT', sent_by=$2, sent_at=now(), updated_at=now() WHERE id=$1", [env.id, approvedBy]);
  await setLifecycle(db, env.organization_id, env.documents, "SIGNATURE_PENDING");
}

export async function deliverSignatureInvites(deps: Deps) {
  const send = deps.signatureMailer;
  if (!send) return;
  const pending = (await withContext(deps.pool, {}, (db) => db.query("SELECT * FROM app.pending_signature_invites()"))).rows as InvitationKey[];
  for (const candidate of pending) {
    const ctx = { organizationId: candidate.organization_id };
    const invite = await withContext(deps.pool, ctx, async (db) => {
      const env = (await db.query("SELECT * FROM signature_envelopes WHERE id=$1", [candidate.envelope_id])).rows[0] as NativeEnvelope | undefined;
      if (!env || ![...SIGNABLE_STATES, "COMPLETED"].includes(env.state)) return;
      const invite = (await db.query(
        `UPDATE signature_invitations SET attempts=attempts+1, last_attempt_at=now()
         WHERE id=$1 AND delivery_kind=$2 AND sent_at IS NULL AND attempts < 5 AND expires_at > now()
           AND (last_attempt_at IS NULL OR last_attempt_at < now() - interval '2 minutes')
         RETURNING *`, [candidate.id, env.state === "COMPLETED" ? "completed" : "invitation"],
      )).rows[0] as Invitation | undefined;
      if (!invite) return;
      try {
        await checkExternalAccess(db, env, [invite.signer_email], await documentStatuses(db, env));
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        return;
      }
      return invite;
    });
    if (!invite) continue;
    const token = inviteToken(deps, invite.id);
    if (sha256(token) !== invite.token_hash) continue;
    try {
      await send(invite.signer_email, inviteUrl(deps, token), invite.delivery_kind);
    } catch {
      continue;
    }
    await withContext(deps.pool, ctx, (db) => db.query(
      "UPDATE signature_invitations SET sent_at=now() WHERE id=$1 AND delivery_kind=$2 AND attempts=$3",
      [invite.id, invite.delivery_kind, invite.attempts],
    ));
  }
}

export async function renewSignatureInvite(deps: Deps, db: Db, env: NativeEnvelope, email: string, actor: string) {
  if (!SIGNABLE_STATES.includes(env.state)) throw conflict("this envelope is closed");
  const row = (await db.query(
    `SELECT i.*, EXISTS(SELECT 1 FROM signature_responses r WHERE r.envelope_id=i.envelope_id AND r.signer_email=i.signer_email) AS responded
     FROM signature_invitations i WHERE i.envelope_id=$1 AND i.signer_email=$2 FOR UPDATE`, [env.id, email],
  )).rows[0];
  if (!row) throw notFound("invitation");
  if (row.responded) throw conflict("this signer has already responded");
  const last = row.last_attempt_at ?? row.sent_at;
  if (last && Date.now() - new Date(last).getTime() < 60_000) throw new ApiError(429, "signature_invite_cooldown", "Wait one minute before resending.");
  await checkExternalAccess(db, env, [email], await documentStatuses(db, env));
  const id = randomUUID();
  const token = inviteToken(deps, id);
  const updated = (await db.query(
    `UPDATE signature_invitations SET id=$2, token_hash=$3, expires_at=now() + interval '7 days',
     sent_at=NULL, attempts=0, last_attempt_at=NULL, opened_at=NULL WHERE id=$1 RETURNING expires_at`,
    [row.id, id, sha256(token)],
  )).rows[0];
  await auditAs(db, env.organization_id, actor, "signature.invite_renewed", `envelope:${env.id}`, "allow", { signer: email });
  return { expires_at: updated.expires_at, ...(deps.cfg.AUTH_MODE === "dev" && !deps.signatureMailer ? { development_url: inviteUrl(deps, token) } : {}) };
}

export async function withSignatureInvite<T>(deps: Deps, token: string, fn: (db: Db, env: NativeEnvelope, invite: Invitation) => Promise<T>) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw notFound("signature invitation");
  const hash = sha256(token);
  const candidate = (await withContext(deps.pool, {}, (db) => db.query("SELECT * FROM app.signature_invite_by_hash($1)", [hash]))).rows[0] as InvitationKey | undefined;
  if (!candidate) throw notFound("signature invitation");
  return withContext(deps.pool, { organizationId: candidate.organization_id }, async (db) => {
    const env = (await db.query("SELECT * FROM signature_envelopes WHERE id=$1 AND provider='native' FOR UPDATE", [candidate.envelope_id])).rows[0] as NativeEnvelope | undefined;
    const invite = (await db.query("SELECT * FROM signature_invitations WHERE id=$1 AND token_hash=$2", [candidate.id, hash])).rows[0] as Invitation | undefined;
    if (!invite || !env) throw notFound("signature invitation");
    if (invite.expires_at.getTime() <= Date.now() || !["SENT", "DELIVERED", "COMPLETED"].includes(env.state)) {
      throw new ApiError(410, "signature_invite_closed", "This invitation expired or the envelope is closed.");
    }
    await checkExternalAccess(db, env, [invite.signer_email], await documentStatuses(db, env));
    return fn(db, env, invite);
  });
}

export async function openNativeEnvelope(db: Db, env: NativeEnvelope) {
  if (env.state !== "SENT") return;
  await db.query("UPDATE signature_envelopes SET state='DELIVERED', updated_at=now() WHERE id=$1", [env.id]);
  env.state = "DELIVERED";
  await emit(db, env.organization_id, "SIGNATURE_DELIVERED", env.run_id ?? env.id, `envelope:${env.id}`, { provider: "native" });
}

export async function recordNativeDecision(
  deps: Deps, db: Db, env: NativeEnvelope, actor: { email: string; id: string | null },
  body: SignatureDecision, meta: { ip: string; userAgent?: string },
) {
  if (!env.signers.some((signer) => signer.email === actor.email)) throw forbidden("you are not a signer of this envelope");
  const name = body.decision === "sign" ? body.typed_name : "";
  const consent = body.decision === "sign" ? SIGN_CONSENT : "";
  const decision = body.decision === "sign" ? "signed" : "declined";
  const appearance = body.decision === "sign" ? body.appearance : undefined;
  const savedId = appearance?.type === "saved" ? appearance.id : null;
  if (savedId && !actor.id) throw forbidden("sign in to use a saved signature");
  const responses = (await db.query(
    `SELECT signer_email, signed_by, identity_method, decision, typed_name, consent_text, signed_at, ip, user_agent, image_png, personal_signature_id
     FROM signature_responses WHERE envelope_id=$1 ORDER BY signed_at, signer_email`, [env.id],
  )).rows;
  const prior = responses.find((r) => r.signer_email === actor.email);
  if (!prior && !SIGNABLE_STATES.includes(env.state)) throw conflict("this envelope is closed");
  const uploaded = appearance?.type === "image" ? await normalizeSignatureImage(appearance.image) : null;
  if (prior) {
    const sameImage = savedId ? prior.personal_signature_id === savedId :
      prior.personal_signature_id === null && (uploaded ? !!prior.image_png && uploaded.equals(prior.image_png) : prior.image_png === null);
    if (prior.decision !== decision || prior.typed_name !== name || prior.signed_by !== actor.id || !sameImage) {
      throw conflict("you already responded to this envelope");
    }
    return { state: env.state, remaining: env.signers.length - responses.length };
  }
  const image = savedId ? await readPersonalSignature(db, actor.id!, savedId) : uploaded;

  await openNativeEnvelope(db, env);
  const method = actor.id ? "account" : "email_link";
  const accepted = (await db.query(
    `INSERT INTO signature_responses (envelope_id, organization_id, signer_email, signed_by, identity_method, decision, typed_name, consent_text, ip, user_agent, image_png, personal_signature_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING signer_email, signed_by, identity_method, decision, typed_name, consent_text, signed_at, ip, user_agent, image_png, personal_signature_id`,
    [env.id, env.organization_id, actor.email, actor.id, method, decision, name, consent, meta.ip, meta.userAgent?.slice(0, 300) ?? null, image, savedId],
  )).rows[0];
  responses.push(accepted);
  const remaining = env.signers.length - responses.length;
  const state = decision === "declined" ? "DECLINED" : remaining === 0 ? "COMPLETED" : env.state;
  await auditAs(db, env.organization_id, actor.id, `signature.signer_${decision}`, `envelope:${env.id}`, "allow", {
    signer: actor.email, identity_method: method, ...(body.decision === "decline" && body.reason ? { reason: body.reason } : {}),
  });
  await emit(db, env.organization_id, `SIGNER_${decision.toUpperCase()}`, env.run_id ?? env.id, `envelope:${env.id}`, { signer: actor.email, identity_method: method });

  if (state === "COMPLETED" || state === "DECLINED") {
    const completedAt = accepted.signed_at.toISOString();
    const evidence = state === "COMPLETED" ? await writeSignatureEvidence(deps, env, responses, completedAt) : null;
    await db.query(
      `UPDATE signature_envelopes SET state=$2, completed_at=$3, evidence=COALESCE($4::jsonb,evidence), updated_at=now() WHERE id=$1`,
      [env.id, state, evidence ? completedAt : null, evidence ? JSON.stringify(evidence) : null],
    );
    if (evidence) {
      await setLifecycle(db, env.organization_id, env.documents, "SIGNED");
      await db.query(
        `UPDATE signature_invitations SET expires_at=now() + interval '7 days', delivery_kind='completed',
           sent_at=NULL, attempts=0, last_attempt_at=NULL WHERE envelope_id=$1`, [env.id],
      );
    } else await restoreNativeLifecycle(db, env);
    await emit(db, env.organization_id, `SIGNATURE_${state}`, env.run_id ?? env.id, `envelope:${env.id}`, { provider: "native", ...(evidence ? { signed_sha256: evidence.signed_sha256 } : {}) });
  }
  return { state, remaining };
}

export async function restoreNativeLifecycle(db: Db, env: NativeEnvelope) {
  await db.query(
    `UPDATE document_lifecycle d SET state='APPROVED', updated_at=now()
     WHERE d.version_id=ANY($1::uuid[]) AND d.state='SIGNATURE_PENDING'
       AND NOT EXISTS (SELECT 1 FROM signature_envelopes e WHERE e.id<>$2 AND e.state IN ('SENT','DELIVERED')
         AND e.documents @> jsonb_build_array(jsonb_build_object('version_id', d.version_id)))`,
    [env.documents.map((doc) => doc.version_id), env.id],
  );
}

export async function signalNativeDecision(runner: WorkflowRunner, env: NativeEnvelope, state: string) {
  if (env.run_id && ["COMPLETED", "DECLINED"].includes(state)) await runner.signal(env.organization_id, env.run_id);
}
