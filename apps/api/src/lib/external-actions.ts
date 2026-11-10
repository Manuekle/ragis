/**
 * Acciones externas de workflows y eventos del proveedor de firma (hito F, ADR-023).
 *
 * Las ejecuta el orquestador, nunca un agente, y solo después de un paso humano:
 *  - create_signature_draft: sobre DRAFT con los documentos APPROVED por la revisión humana y los firmantes del run.
 *  - send_signature_envelope: solo justo después de un APPROVAL_GATE cuyo binding nombra ESE sobre (mismos firmantes y
 *    documentos), aprobado hace menos de `approval_max_age_hours`, con las versiones aún vigentes.
 *  - share_document: enlace con caducidad y revocación para destinatarios de dominios permitidos; DLP por clasificación.
 * Idempotentes: clave por (run, nodo); un reintento reutiliza el sobre o los enlaces ya creados.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Deps } from "../app.js";
import { withContext, type Db } from "../db/pool.js";
import { LocalProvider, type ProviderEvent } from "./esign.js";
import { ApiError } from "./errors.js";
import { canonical } from "./policy.js";
import { dispatchNativeEnvelope, snapshotSignatureDocs } from "./signature-native.js";
import { resolveTenant, tx, type TenantContext } from "./tenant.js";
import type { Graph, Node } from "./workflow-dsl.js";
import { auditAs, emit, failRun, type WorkflowRunner } from "./workflow-runner.js";

const sha = (v: unknown) => createHash("sha256").update(canonical(v)).digest("hex");
export const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

export interface ExternalPolicy {
  allowed_domains: string[];
  share_max_days: number;
  approval_max_age_hours: number;
  require_mfa_for_signature: boolean;
}

export const DEFAULT_POLICY: ExternalPolicy = { allowed_domains: [], share_max_days: 7, approval_max_age_hours: 24, require_mfa_for_signature: false };

export async function loadPolicy(db: Db, orgId: string): Promise<ExternalPolicy> {
  const r = await db.query("SELECT allowed_domains, share_max_days, approval_max_age_hours, require_mfa_for_signature FROM external_policies WHERE organization_id=$1", [orgId]);
  return r.rows[0] ?? DEFAULT_POLICY;
}

export const normalizeEmails = (list: string[] | undefined) => [...new Set((list ?? []).map((e) => e.trim().toLowerCase()))].sort();

/** Dominios no permitidos (allowlist exacta o subdominio). Allowlist vacía ⇒ nada sale. */
export function blockedRecipients(policy: Pick<ExternalPolicy, "allowed_domains">, emails: string[]): string[] {
  const allowed = policy.allowed_domains.map((d) => d.toLowerCase());
  return emails.filter((e) => {
    const domain = e.split("@")[1] ?? "";
    return !allowed.some((d) => domain === d || domain.endsWith(`.${d}`));
  });
}

async function currentVersionsChanged(db: Db, docs: { document_id: string; version_id: string }[]): Promise<number> {
  if (!docs.length) return 0;
  const cur = (await db.query("SELECT document_id, current_version_id, status FROM app.current_versions($1::uuid[])", [docs.map((d) => d.document_id)])).rows;
  return docs.filter((d) => {
    const c = cur.find((r) => r.document_id === d.document_id);
    return !c || c.status !== "active" || c.current_version_id !== d.version_id;
  }).length;
}

async function setLifecycle(db: Db, orgId: string, docs: { document_id: string; version_id: string }[], state: string, approvalId?: string) {
  for (const d of docs) {
    await db.query(
      `INSERT INTO document_lifecycle (version_id, organization_id, document_id, state, approval_id) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (version_id) DO UPDATE SET state=EXCLUDED.state, approval_id=COALESCE(EXCLUDED.approval_id, document_lifecycle.approval_id), updated_at=now()
       WHERE (EXCLUDED.state <> 'SIGNATURE_PENDING' OR document_lifecycle.state NOT IN ('SIGNED','DISTRIBUTED','ARCHIVED'))
         AND (EXCLUDED.state <> 'SIGNED' OR document_lifecycle.state NOT IN ('DISTRIBUTED','ARCHIVED'))`,
      [d.version_id, orgId, d.document_id, state, approvalId ?? null],
    );
  }
}
export { setLifecycle };

/**
 * Detalle de la acción que sigue a un paso humano: entra en el binding (y por tanto en el hash) para que el aprobador
 * autorice exactamente ese sobre o esos destinatarios.
 */
export async function actionDetails(db: Db, orgId: string, run: { id: string; input: RunInput }, next: Node | undefined): Promise<Record<string, unknown> | null> {
  if (next?.type !== "EXTERNAL_ACTION") return null;
  if (next.tool === "send_signature_envelope") {
    const env = (await db.query("SELECT id, provider, external_id, signers, documents FROM signature_envelopes WHERE run_id=$1 AND state='DRAFT' ORDER BY created_at DESC LIMIT 1", [run.id])).rows[0];
    if (!env) return { kind: "send_signature", envelope: null };
    return {
      kind: "send_signature",
      envelope: { id: env.id, provider: env.provider, external_id: env.external_id, signers: env.signers, documents: (env.documents as EnvDoc[]).map(({ document_id, version_id, sha256: h }) => ({ document_id, version_id, sha256: h })) },
    };
  }
  if (next.tool === "share_document" || next.tool === "send_email") {
    const policy = await loadPolicy(db, orgId);
    const signed = (await db.query("SELECT id, evidence FROM signature_envelopes WHERE run_id=$1 AND state='COMPLETED' ORDER BY completed_at DESC LIMIT 1", [run.id])).rows[0];
    const approved = (await db.query("SELECT binding FROM approvals WHERE run_id=$1 AND status='APPROVED' AND jsonb_array_length(binding->'documents') > 0 ORDER BY decided_at DESC LIMIT 1", [run.id])).rows[0];
    return {
      kind: "share",
      recipients: normalizeEmails(run.input.recipients),
      artifact: signed
        ? { kind: "signed", envelope_id: signed.id, sha256: signed.evidence?.signed_sha256 ?? null }
        : { kind: "document", documents: approved?.binding.documents ?? [] },
      expires_days: Math.min(next.expires_days ?? policy.share_max_days, policy.share_max_days),
    };
  }
  return null;
}

export interface RunInput {
  task: string;
  signers?: { name: string; email: string }[];
  recipients?: string[];
}
export interface EnvDoc {
  document_id: string;
  version_id: string;
  title: string;
  filename: string;
  sha256: string;
  s3_key: string;
}
interface StepRow {
  id: string;
  attempt: number;
  node_id: string;
  node_type: string;
}
export interface ExternalPlan {
  run: { id: string; organization_id: string; initiated_by: string; input: RunInput };
  step: StepRow;
  node: Extract<Node, { type: "EXTERNAL_ACTION" }>;
  graph: Graph;
  prior: StepRow[];
}

class StepFailure extends Error {
  constructor(
    readonly code: string,
    readonly detail: string,
    readonly audit?: { action: string; metadata: Record<string, unknown> },
  ) {
    super(code);
  }
}

export async function runExternal(runner: WorkflowRunner, deps: Deps, orgId: string, plan: ExternalPlan): Promise<void> {
  const { run, step, node } = plan;
  const sys = <T>(fn: (db: Db) => Promise<T>) => withContext(deps.pool, { organizationId: orgId }, fn);
  const finish = (fn: (db: Db) => Promise<void>) =>
    sys(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext('run:' || $1))", [run.id]);
      const cur = (await db.query("SELECT state FROM workflow_runs WHERE id=$1", [run.id])).rows[0];
      if (!cur || ["COMPLETED", "FAILED", "CANCELLED"].includes(cur.state)) return;
      await fn(db);
    });
  const succeed = (output: Record<string, unknown>, events: [string, string, Record<string, unknown>][], auditAction: string) =>
    finish(async (db) => {
      await db.query("UPDATE run_steps SET state='SUCCEEDED', output=$2::jsonb, finished_at=now() WHERE id=$1", [step.id, JSON.stringify(output)]);
      for (const [type, aggregate, payload] of events) await emit(db, orgId, type, run.id, aggregate, payload);
      await auditAs(db, orgId, null, auditAction, `workflow_run:${run.id}`, "allow", { node_id: node.id, tool: node.tool });
    });

  let t: TenantContext;
  try {
    t = await resolveTenant(deps.pool, run.initiated_by, orgId);
  } catch {
    t = null as never;
  }

  try {
    if (!t) throw new StepFailure("initiator_access_revoked", "the run initiator is no longer an active member");
    if (deps.esign.name === "disabled" && (node.tool === "create_signature_draft" || node.tool === "send_signature_envelope")) {
      throw new StepFailure("esign_disabled", "no eSignature provider is configured (ESIGN_PROVIDER)");
    }
    const policy = await sys((db) => loadPolicy(db, orgId));
    // Aprobación del gate inmediatamente anterior (envío/compartición).
    const gateApproval = async () => {
      const prev = plan.prior.at(-1);
      const a = prev ? (await sys((db) => db.query("SELECT * FROM approvals WHERE step_id=$1", [prev.id]))).rows[0] : undefined;
      if (!a || a.status !== "APPROVED") throw new StepFailure("approval_missing", "no approved gate right before this action");
      if (Date.now() - new Date(a.decided_at).getTime() > policy.approval_max_age_hours * 3600_000) throw new StepFailure("approval_stale", `approval older than ${policy.approval_max_age_hours} h`);
      return a;
    };

    switch (node.tool) {
      case "create_signature_draft": {
        const key = `run:${run.id}:${node.id}`;
        const approved = (await sys((db) => db.query("SELECT id, binding FROM approvals WHERE run_id=$1 AND status='APPROVED' AND jsonb_array_length(binding->'documents') > 0 ORDER BY decided_at DESC LIMIT 1", [run.id]))).rows[0];
        const docs = (approved?.binding.documents ?? []) as { document_id: string; version_id: string }[];
        if (!docs.length) throw new StepFailure("no_approved_documents", "no human-approved document versions in this run");
        const signers = (run.input.signers ?? []).map((s) => ({ name: s.name.trim(), email: s.email.trim().toLowerCase() }));
        if (!signers.length) throw new StepFailure("signers_missing", "the run has no signers");
        if (new Set(signers.map((s) => s.email)).size !== signers.length) throw new StepFailure("duplicate_signers", "each signer needs a unique email");
        if (await sys((db) => currentVersionsChanged(db, docs))) throw new StepFailure("document_changed", "an approved document changed after approval");
        const states = (await sys((db) => db.query("SELECT version_id, state FROM document_lifecycle WHERE version_id = ANY($1::uuid[])", [docs.map((d) => d.version_id)]))).rows;
        if (docs.some((d) => states.find((s) => s.version_id === d.version_id)?.state !== "APPROVED")) throw new StepFailure("document_not_approved", "documents must be APPROVED before a signature draft");

        let env = (await sys((db) => db.query("SELECT * FROM signature_envelopes WHERE idempotency_key=$1", [key]))).rows[0];
        if (!env?.external_id) {
          // Bytes leídos con la ACL del iniciador (RLS): no se firma lo que el iniciador no puede leer.
          const files = await tx(deps.pool, t, async (db) =>
            (
              await db.query(
                `SELECT v.id AS version_id, v.document_id, v.s3_key, v.filename, v.checksum_sha256, v.size_bytes, d.title
                   FROM document_versions v JOIN documents d ON d.id = v.document_id WHERE v.id = ANY($1::uuid[])`,
                [docs.map((d) => d.version_id)],
              )
            ).rows,
          );
          if (files.length !== docs.length) throw new StepFailure("document_not_readable", "the initiator cannot read every approved document");
          const id = env?.id ?? randomUUID();
          const ordered = docs.map((doc) => files.find((file) => file.version_id === doc.version_id)!);
          const envDocs = deps.esign.name === "native" ? await snapshotSignatureDocs(deps, orgId, id, ordered) : await Promise.all(ordered.map(async (f) => {
            const bytes = await deps.storage.get(f.s3_key);
            if (!bytes) throw new StepFailure("document_missing", `object for ${f.filename} not found`);
            const h = sha256(bytes);
            if (f.checksum_sha256 && f.checksum_sha256 !== h) throw new StepFailure("checksum_mismatch", `${f.filename} does not match its recorded checksum`);
            return { document_id: f.document_id, version_id: f.version_id, title: f.title, filename: f.filename, sha256: h, s3_key: f.s3_key };
          }));
          const externalId = deps.esign.name === "local" ? (await deps.esign.createDraft()).externalId : id;
          env = (await sys((db) => db.query(
            `INSERT INTO signature_envelopes (id, organization_id, run_id, provider, external_id, subject, documents, signers, idempotency_key, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10)
             ON CONFLICT (organization_id, idempotency_key) DO UPDATE
               SET external_id=COALESCE(signature_envelopes.external_id,EXCLUDED.external_id) RETURNING *`,
            [id, orgId, run.id, deps.esign.name, externalId, "Signature request", JSON.stringify(envDocs), JSON.stringify(signers), key, run.initiated_by],
          ))).rows[0];
        }
        await succeed(
          { envelope_id: env.id, provider: env.provider, state: "DRAFT", signers: env.signers, documents: (env.documents as EnvDoc[]).map(({ title, version_id, sha256: h }) => ({ title, version_id, sha256: h })) },
          [["SIGNATURE_DRAFT_CREATED", `envelope:${env.id}`, { provider: env.provider, signers: (env.signers as unknown[]).length }]],
          "signature.draft_created",
        );
        return;
      }

      case "send_signature_envelope": {
        const a = await gateApproval();
        const env = (await sys((db) => db.query("SELECT * FROM signature_envelopes WHERE run_id=$1 ORDER BY created_at DESC LIMIT 1", [run.id]))).rows[0];
        if (!env) throw new StepFailure("envelope_missing", "no envelope in this run");
        const bound = a.binding.details?.envelope;
        const docsOf = (list: EnvDoc[]) => list.map(({ document_id, version_id, sha256: h }) => ({ document_id, version_id, sha256: h }));
        if (a.binding.details?.kind !== "send_signature" || !bound || bound.id !== env.id || bound.provider !== env.provider || bound.external_id !== env.external_id || sha(bound.signers) !== sha(env.signers) || sha(bound.documents) !== sha(docsOf(env.documents))) {
          throw new StepFailure("approval_mismatch", "the approval does not match this envelope");
        }
        const changed = await sys(async (db) => {
          await db.query("SELECT pg_advisory_xact_lock(hashtext('run:' || $1))", [run.id]);
          const active = (await db.query("SELECT 1 FROM workflow_runs WHERE id=$1 AND state='RUNNING'", [run.id])).rowCount;
          if (!active) return null;
          const current = (await db.query("SELECT * FROM signature_envelopes WHERE id=$1 FOR UPDATE", [env.id])).rows[0];
          if (["SENT", "DELIVERED", "COMPLETED"].includes(current.state)) return false;
          if (current.state !== "DRAFT" || current.provider !== deps.esign.name) throw new StepFailure("envelope_not_draft", "this envelope cannot be sent with the active provider");
          if (await currentVersionsChanged(db, current.documents)) {
            await db.query("UPDATE signature_envelopes SET state='VOIDED', voided_reason='document_changed', updated_at=now() WHERE id=$1", [env.id]);
            return true;
          }
          if (current.provider === "native") await dispatchNativeEnvelope(deps, db, current, a.decided_by);
          else {
            await db.query("UPDATE signature_envelopes SET state='SENT', sent_by=$2, sent_at=now(), updated_at=now() WHERE id=$1", [env.id, a.decided_by]);
            await setLifecycle(db, orgId, current.documents, "SIGNATURE_PENDING");
          }
          return false;
        });
        if (changed === null) return;
        if (changed) throw new StepFailure("document_changed", "a document changed after the send was approved; envelope voided");
        await succeed(
          { envelope_id: env.id, state: "SENT", approved_by: a.decided_by, action_hash: a.action_hash },
          [["SIGNATURE_SENT", `envelope:${env.id}`, { approved_by: a.decided_by, action_hash: a.action_hash, signers: (env.signers as unknown[]).length }]],
          "signature.sent",
        );
        return;
      }

      case "share_document": {
        const a = await gateApproval();
        const details = a.binding.details;
        const recipients = normalizeEmails(run.input.recipients);
        if (details?.kind !== "share" || sha(details.recipients) !== sha(recipients)) throw new StepFailure("approval_mismatch", "the approval does not match these recipients");
        if (!recipients.length) throw new StepFailure("recipients_missing", "the run has no recipients");
        const blocked = blockedRecipients(policy, recipients);
        if (blocked.length) {
          throw new StepFailure("recipient_not_allowed", `${blocked.length} recipient(s) outside the allowed domains`, {
            action: "share.denied",
            metadata: { reason: "domain_not_allowed", domains: [...new Set(blocked.map((e) => e.split("@")[1]))] },
          });
        }
        const existing = (await sys((db) => db.query("SELECT id, title, expires_at FROM shares WHERE step_id=$1", [step.id]))).rows;
        let created = existing;
        if (!existing.length) {
          type Artifact = { artifact: "document" | "signed"; document_id: string | null; version_id: string | null; envelope_id: string | null; title: string; filename: string; s3_key: string; docs: { document_id: string; version_id: string }[] };
          const artifacts: Artifact[] = [];
          if (details.artifact.kind === "signed") {
            const env = (await sys((db) => db.query("SELECT * FROM signature_envelopes WHERE id=$1 AND state='COMPLETED'", [details.artifact.envelope_id]))).rows[0];
            if (!env?.evidence?.signed_key) throw new StepFailure("signed_artifact_missing", "the signed document is not available");
            if (details.artifact.sha256 !== env.evidence.signed_sha256) throw new StepFailure("approval_mismatch", "the approval does not match the signed document");
            const signedDocs = env.documents as EnvDoc[];
            const classifications = (await sys((db) => db.query("SELECT * FROM app.signature_document_status($1)", [signedDocs.map((doc) => doc.document_id)]))).rows;
            if (classifications.length !== signedDocs.length || classifications.some((doc) => doc.status !== "active" || doc.classification === "restricted")) {
              throw new StepFailure("dlp_restricted", "restricted or unavailable signed documents cannot be shared externally", { action: "share.denied", metadata: { reason: "dlp_restricted" } });
            }
            const title = (env.documents as EnvDoc[]).map((d) => d.title).join(", ");
            artifacts.push({ artifact: "signed", document_id: null, version_id: null, envelope_id: env.id, title: `${title} (signed)`, filename: env.evidence.signed_filename ?? "signed.pdf", s3_key: env.evidence.signed_key, docs: env.documents });
          } else {
            const docs = details.artifact.documents as { document_id: string; version_id: string }[];
            if (!docs.length) throw new StepFailure("no_approved_documents", "nothing approved to share");
            if (await sys((db) => currentVersionsChanged(db, docs))) throw new StepFailure("document_changed", "a document changed after approval");
            const files = await tx(deps.pool, t, async (db) =>
              (await db.query("SELECT v.id, v.document_id, v.s3_key, v.filename, d.title, d.classification FROM document_versions v JOIN documents d ON d.id=v.document_id WHERE v.id = ANY($1::uuid[])", [docs.map((d) => d.version_id)])).rows,
            );
            if (files.length !== docs.length) throw new StepFailure("document_not_readable", "the initiator cannot read every document to share");
            // DLP: lo restringido nunca sale de la organización.
            const restricted = files.filter((f) => f.classification === "restricted");
            if (restricted.length) throw new StepFailure("dlp_restricted", "restricted documents cannot be shared externally", { action: "share.denied", metadata: { reason: "dlp_restricted", documents: restricted.map((f) => f.document_id) } });
            for (const f of files) artifacts.push({ artifact: "document", document_id: f.document_id, version_id: f.id, envelope_id: null, title: f.title, filename: f.filename, s3_key: f.s3_key, docs: [{ document_id: f.document_id, version_id: f.id }] });
          }
          created = await finishShares(sys, orgId, run, step.id, a.decided_by, recipients, details.expires_days, artifacts);
        }
        await succeed(
          { shares: created.map((s: { id: string; title: string; expires_at: string }) => ({ id: s.id, title: s.title, expires_at: s.expires_at })), recipients, approved_by: a.decided_by },
          [
            ...created.map((s: { id: string }) => ["SHARE_CREATED", `share:${s.id}`, { recipients: recipients.length }] as [string, string, Record<string, unknown>]),
            ["DOCUMENT_DISTRIBUTED", run.id, { shares: created.length, approved_by: a.decided_by }],
          ],
          "share.created",
        );
        return;
      }

      default:
        throw new StepFailure("tool_unavailable", `${node.tool} is not executable`);
    }
  } catch (err) {
    if (err instanceof StepFailure || (err instanceof ApiError && err.status < 500)) {
      await finish(async (db) => {
        const detail = err instanceof StepFailure ? err.detail : err.message;
        if (err instanceof StepFailure && err.audit) await auditAs(db, orgId, null, err.audit.action, `workflow_run:${run.id}`, "deny", err.audit.metadata);
        await db.query("UPDATE run_steps SET state='FAILED', error=$2, output=$3::jsonb, finished_at=now() WHERE id=$1", [step.id, err.code, JSON.stringify({ reason: detail })]);
        await failRun(db, { id: run.id, organization_id: orgId }, err.code, detail);
      });
      return;
    }
    // Error del proveedor/red: reintento con backoff; el paso sigue RUNNING y la idempotencia evita duplicados.
    console.error(JSON.stringify({ level: "error", msg: "external action error", run_id: run.id, tool: node.tool, err: String(err) }));
    if (step.attempt < 3) {
      await finish(async (db) => {
        await db.query("UPDATE run_steps SET attempt=attempt+1, error=$2 WHERE id=$1", [step.id, "provider_error"]);
      });
      await new Promise((r) => setTimeout(r, runner.backoffMs * 2 ** (step.attempt - 1)));
      return;
    }
    await finish(async (db) => {
      await db.query("UPDATE run_steps SET state='FAILED', error='provider_error', finished_at=now() WHERE id=$1", [step.id]);
      await failRun(db, { id: run.id, organization_id: orgId }, "provider_error", `${node.tool} failed at the provider`);
    });
  }
}

async function finishShares(
  sys: <T>(fn: (db: Db) => Promise<T>) => Promise<T>,
  orgId: string,
  run: { id: string; initiated_by: string },
  stepId: string,
  approvedBy: string,
  recipients: string[],
  days: number,
  artifacts: { artifact: string; document_id: string | null; version_id: string | null; envelope_id: string | null; title: string; filename: string; s3_key: string; docs: { document_id: string; version_id: string }[] }[],
) {
  return sys(async (db) => {
    const out: { id: string; title: string; expires_at: string }[] = [];
    for (const x of artifacts) {
      // El token nunca se guarda ni se registra: se entrega rotándolo con "reveal" (iniciador/admin).
      const tokenHash = sha256(randomBytes(32).toString("base64url"));
      const r = await db.query(
        `INSERT INTO shares (organization_id, run_id, step_id, artifact, document_id, version_id, envelope_id, title, filename, s3_key, token_hash, recipients, expires_at, created_by, approved_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now() + make_interval(days => $13), $14, $15) RETURNING id, title, expires_at`,
        [orgId, run.id, stepId, x.artifact, x.document_id, x.version_id, x.envelope_id, x.title, x.filename, x.s3_key, tokenHash, recipients, days, run.initiated_by, approvedBy],
      );
      out.push(r.rows[0]);
      await setLifecycle(db, orgId, x.docs, "DISTRIBUTED");
    }
    return out;
  });
}

// ---------------------------------------------------------------- eventos del proveedor
const RANK: Record<string, number> = { DRAFT: 0, SENT: 1, DELIVERED: 2, COMPLETED: 3, DECLINED: 3, VOIDED: 3 };

export async function processSignatureEvent(
  deps: Deps,
  runner: WorkflowRunner,
  providerName: string,
  raw: Buffer,
  headers: Record<string, string | string[] | undefined>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const provider = deps.esign;
  if (provider.name !== "local" || providerName !== provider.name) return { status: 404, body: { error: { code: "not_found" } } };
  // Autenticidad primero: nada se lee ni se escribe con un cuerpo sin firma válida.
  if (!provider.verify(raw, headers)) {
    console.warn(JSON.stringify({ level: "warn", msg: "signature webhook rejected", provider: providerName }));
    return { status: 401, body: { error: { code: "invalid_signature" } } };
  }
  const ev = provider.parse(raw);
  if (!ev) return { status: 400, body: { error: { code: "bad_event" } } };
  const found = (await withContext(deps.pool, {}, (db) => db.query("SELECT organization_id, envelope_id FROM app.envelope_by_external($1,$2)", [provider.name, ev.externalId]))).rows[0];
  if (!found) return { status: 202, body: { ignored: "unknown_envelope" } };
  const orgId = found.organization_id as string;
  const sys = <T>(fn: (db: Db) => Promise<T>) => withContext(deps.pool, { organizationId: orgId }, fn);

  const pre = await sys(async (db) => ({
    dup: !!(await db.query("SELECT 1 FROM webhook_inbox WHERE provider=$1 AND event_id=$2", [provider.name, ev.eventId])).rowCount,
    env: (await db.query("SELECT * FROM signature_envelopes WHERE id=$1", [found.envelope_id])).rows[0],
  }));
  if (pre.dup) return { status: 200, body: { duplicate: true } };

  // Evidencia antes de registrar el evento: si falla, el proveedor reintenta y el evento no queda "consumido".
  let evidence: Record<string, unknown> | null = null;
  if (ev.status === "COMPLETED" && pre.env.state !== "COMPLETED" && RANK[pre.env.state]! < 3) evidence = await collectEvidence(deps, orgId, pre.env, ev);

  const out = await sys(async (db) => {
    const ins = await db.query(
      "INSERT INTO webhook_inbox (provider, event_id, organization_id, envelope_id, status, payload_hash) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING event_id",
      [provider.name, ev.eventId, orgId, found.envelope_id, ev.status, sha256(raw)],
    );
    if (!ins.rowCount) return { duplicate: true as const };
    const env = (await db.query("SELECT * FROM signature_envelopes WHERE id=$1 FOR UPDATE", [found.envelope_id])).rows[0];
    const terminal = RANK[env.state] === 3;
    if (terminal || RANK[ev.status]! <= RANK[env.state]!) {
      await auditAs(db, orgId, null, "signature.event_ignored", `envelope:${env.id}`, "allow", { status: ev.status, current: env.state, event_id: ev.eventId });
      return { applied: false as const, env };
    }
    await db.query(
      `UPDATE signature_envelopes SET state=$2, updated_at=now(), completed_at = CASE WHEN $2='COMPLETED' THEN now() ELSE completed_at END,
         evidence = CASE WHEN $3::jsonb IS NULL THEN evidence ELSE $3::jsonb END WHERE id=$1`,
      [env.id, ev.status, evidence ? JSON.stringify(evidence) : null],
    );
    if (ev.status === "COMPLETED") await setLifecycle(db, orgId, env.documents, "SIGNED");
    if (ev.status === "DECLINED" || ev.status === "VOIDED") await setLifecycle(db, orgId, env.documents, "APPROVED");
    await emit(db, orgId, `SIGNATURE_${ev.status}`, env.run_id ?? env.id, `envelope:${env.id}`, { provider: provider.name, event_id: ev.eventId, occurred_at: ev.occurredAt, ...(evidence ? { signed_sha256: evidence.signed_sha256 } : {}) });
    await auditAs(db, orgId, null, `signature.${ev.status.toLowerCase()}`, `envelope:${env.id}`, "allow", { provider: provider.name, event_id: ev.eventId, verified: true });
    return { applied: true as const, env };
  });
  if ("duplicate" in out) return { status: 200, body: { duplicate: true } };
  if (out.applied && out.env.run_id && ["COMPLETED", "DECLINED", "VOIDED"].includes(ev.status)) await runner.signal(orgId, out.env.run_id);
  return { status: 200, body: { processed: true, applied: out.applied, state: out.applied ? ev.status : out.env.state } };
}

async function collectEvidence(deps: Deps, orgId: string, env: { id: string; documents: EnvDoc[]; signers: unknown; external_id: string }, ev: ProviderEvent) {
  const base = `tenants/${orgId}/signatures/${env.id}`;
  // Proveedor local: certificado propio con la ceremonia registrada; el PDF no se estampa (no tiene validez legal).
  const sigs = (await withContext(deps.pool, { organizationId: orgId }, (db) => db.query("SELECT signer_email, typed_name, decision, consent_text, ip, user_agent, signed_at FROM signature_responses WHERE envelope_id=$1 ORDER BY signed_at", [env.id]))).rows;
  const certificate = Buffer.from(
    JSON.stringify(
      {
        provider: "local",
        disclaimer: "Development provider — this is NOT a legally binding electronic signature.",
        envelope_id: env.id,
        external_id: env.external_id,
        documents: env.documents.map(({ title, version_id, sha256: h }) => ({ title, version_id, sha256: h })),
        signers: sigs,
        completed_at: ev.occurredAt,
      },
      null,
      2,
    ),
  );
  await deps.storage.put(`${base}/certificate.json`, certificate, "application/json");
  const first = env.documents[0]!;
  return { signed_key: first.s3_key, signed_filename: first.filename, signed_sha256: first.sha256, certificate_key: `${base}/certificate.json`, certificate_sha256: sha256(certificate), source: "local", stamped: false };
}

/** Ceremonia del proveedor local: firma o rechazo del firmante autenticado; emite el webhook firmado al completarse. */
export async function localSign(
  deps: Deps,
  runner: WorkflowRunner,
  t: TenantContext,
  user: { email: string },
  envelopeId: string,
  body: { decision: "sign" | "decline"; typed_name: string; consent: true },
  meta: { ip?: string; userAgent?: string },
): Promise<{ state: string; remaining: number }> {
  if (!(deps.esign instanceof LocalProvider)) throw Object.assign(new Error("local signing is only available with ESIGN_PROVIDER=local"), { statusCode: 404 });
  const email = user.email.toLowerCase();
  const consent = "I agree to sign electronically and confirm I reviewed the documents listed (development provider, not legally binding).";
  const r = await tx(deps.pool, t, async (db) => {
    const env = (await db.query("SELECT * FROM signature_envelopes WHERE id=$1 FOR UPDATE", [envelopeId])).rows[0];
    if (!env || env.provider !== "local") throw Object.assign(new Error("envelope not found"), { statusCode: 404 });
    const signers = env.signers as { email: string }[];
    if (!signers.some((s) => s.email === email)) throw Object.assign(new Error("you are not a signer of this envelope"), { statusCode: 403 });
    if (!["SENT", "DELIVERED"].includes(env.state)) throw Object.assign(new Error(`envelope is ${env.state}`), { statusCode: 409 });
    const ins = await db.query(
      `INSERT INTO signature_responses (envelope_id, organization_id, signer_email, signed_by, decision, typed_name, consent_text, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
      [env.id, t.organizationId, email, t.userId, body.decision === "sign" ? "signed" : "declined", body.typed_name, consent, meta.ip ?? null, meta.userAgent?.slice(0, 300) ?? null],
    );
    if (!ins.rowCount) throw Object.assign(new Error("you already responded to this envelope"), { statusCode: 409 });
    const done = (await db.query("SELECT signer_email, decision FROM signature_responses WHERE envelope_id=$1", [env.id])).rows;
    await auditAs(db, t.organizationId, t.userId, `signature.local_${body.decision}`, `envelope:${env.id}`, "allow", { signer: email });
    return { env, declined: done.some((d) => d.decision === "declined"), remaining: signers.filter((s) => !done.some((d) => d.signer_email === s.email)).length };
  });
  const status = r.declined ? "DECLINED" : r.remaining === 0 ? "COMPLETED" : null;
  if (status) {
    // Mismo camino que un proveedor real: evento firmado → verificación HMAC → inbox idempotente.
    const signed = deps.esign.sign({ eventId: randomUUID(), externalId: r.env.external_id, status, occurredAt: new Date().toISOString() });
    const res = await processSignatureEvent(deps, runner, "local", signed.raw, signed.headers);
    if (res.status !== 200) throw new Error(`local webhook failed: ${res.status}`);
  }
  return { state: status ?? r.env.state, remaining: r.remaining };
}

export const newToken = () => randomBytes(32).toString("base64url");
