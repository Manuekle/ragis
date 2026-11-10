/**
 * Firma electrónica y distribución controlada (ADR-023).
 * Casos E2E: 6 (webhook repetido ⇒ estado y evidencia únicos por event_id), 7 (dominio no autorizado ⇒ deny + registro),
 * "SIGNED solo por evento verificado del proveedor", aprobación atada al sobre, MFA, enlaces con caducidad/revocación.
 */
import { createHash, randomUUID, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { PDFDict, PDFDocument, PDFName } from "pdf-lib";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createPool } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import type { Queue, Storage } from "../src/lib/aws.js";
import { LocalProvider } from "../src/lib/esign.js";
import { blockedRecipients } from "../src/lib/external-actions.js";
import { canonical } from "../src/lib/policy.js";
import { RateLimiter } from "../src/lib/ratelimit.js";
import { deliverSignatureInvites } from "../src/lib/signature-native.js";
import type { RagClient } from "../src/routes/query.js";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const env = Object.fromEntries(
  readFileSync(path.join(ROOT, ".env"), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const PORT = process.env.POSTGRES_HOST_PORT ?? "55432";
const DB = "ragsis_signatures_test";
const OWNER_URL = `postgres://ragsis_owner:${env.POSTGRES_PASSWORD}@127.0.0.1:${PORT}/${DB}`;
const WEBHOOK_SECRET = "esign-webhook-secret-for-tests-0123456789abcdef";

describe("reglas puras", () => {
  it("allowlist de dominios: exacto o subdominio; vacía bloquea todo", () => {
    const p = { allowed_domains: ["partner.test"] };
    expect(blockedRecipients(p, ["a@partner.test", "b@legal.partner.test"])).toEqual([]);
    expect(blockedRecipients(p, ["x@evilpartner.test", "y@gmail.com"])).toEqual(["x@evilpartner.test", "y@gmail.com"]);
    expect(blockedRecipients({ allowed_domains: [] }, ["a@partner.test"])).toHaveLength(1);
  });

  it("webhook local: HMAC y frescura", () => {
    const p = new LocalProvider(WEBHOOK_SECRET);
    const ev = { eventId: "e1", externalId: "local_x", status: "COMPLETED" as const, occurredAt: new Date().toISOString() };
    const ok = p.sign(ev);
    expect(p.verify(ok.raw, ok.headers)).toBe(true);
    expect(p.verify(Buffer.from(ok.raw.toString().replace("COMPLETED", "DECLINED")), ok.headers)).toBe(false);
    const old = p.sign(ev, Date.now() - 10 * 60_000);
    expect(p.verify(old.raw, old.headers)).toBe(false);
    expect(new LocalProvider("otro-secreto-de-al-menos-32-caracteres-xx").verify(ok.raw, ok.headers)).toBe(false);
  });
});

class MemStorage implements Storage {
  objects = new Map<string, Buffer>();
  async presignPut(key: string) { return `http://s3.local/${key}?put`; }
  async presignGet(key: string) { return `http://s3.local/${key}?get`; }
  async head(key: string) { const b = this.objects.get(key); return b ? { size: b.length } : null; }
  async delete(key: string) { this.objects.delete(key); }
  async put(key: string, body: Buffer) { this.objects.set(key, body); }
  async get(key: string) { return this.objects.get(key) ?? null; }
}
class NoQueue implements Queue {
  async send() {}
}
class FakeRag implements RagClient {
  docs = new Map<string, { document_id: string; version_id: string }>();
  async query(token: string, body: Record<string, unknown>) {
    const claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString());
    const doc = this.docs.get(claims.ws);
    if (doc && /contrato/i.test(String(body.question))) {
      return { status: 200, body: { answer: "Preaviso de 30 días [1].", abstained: false, citations: [{ n: 1, ...doc, title: "Contrato marco", page: 1, snippet: "treinta días" }] } };
    }
    return { status: 200, body: { answer: "", abstained: true, citations: [] } };
  }
}

let app: FastifyInstance;
let nativeApp: FastifyInstance;
let nativeDeps: Parameters<typeof deliverSignatureInvites>[0];
let pool: pg.Pool;
let owner: pg.Client;
const storage = new MemStorage();
const rag = new FakeRag();
const provider = new LocalProvider(WEBHOOK_SECRET);
const deliveries = new Map<string, string>();
const mailKinds = new Map<string, string>();

async function login(email: string, mfa = false): Promise<string> {
  const token = (await app.inject({ method: "POST", url: "/v1/auth/dev-login", payload: { email, mfa } })).json().token as string;
  await app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${token}` } });
  return token;
}
const call = (token: string, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: method as "GET", url, payload: payload as object, headers: { authorization: `Bearer ${token}`, ...headers } });
const webhook = (raw: Buffer, headers: Record<string, string>) => app.inject({ method: "POST", url: "/v1/webhooks/signatures/local", payload: raw, headers });

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: `postgres://ragsis_owner:${env.POSTGRES_PASSWORD}@127.0.0.1:${PORT}/ragsis` });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${DB}`);
  await admin.end();
  await migrate(OWNER_URL, path.join(ROOT, "db/migrations"));
  owner = new pg.Client({ connectionString: OWNER_URL });
  await owner.connect();
  const cfg = loadConfig({
    DATABASE_URL: `postgres://ragsis_app:${env.RAGSIS_APP_DB_PASSWORD}@127.0.0.1:${PORT}/${DB}`,
    INTERNAL_SERVICE_SECRET: "signature-test-internal-secret-01234567",
    AUTH_MODE: "dev",
    JWT_DEV_SECRET: "dev-secret-for-tests-0123456789abcdefghij",
    RAGSIS_ENV: "test",
    PUBLIC_BASE_URL: "https://app.ragsis.test",
  });
  pool = createPool(cfg.DATABASE_URL);
  app = await buildApp({ cfg, pool, storage, queue: new NoQueue(), rag, esign: provider });
  app.workflows.backoffMs = 1;
  nativeDeps = { cfg, pool, storage, queue: new NoQueue(), rag, limiter: new RateLimiter(), esign: { name: "native" },
    signatureMailer: async (email, url, kind) => { deliveries.set(email, url); mailKinds.set(email, kind); } };
  nativeApp = await buildApp(nativeDeps);
  nativeApp.workflows.backoffMs = 1;
});

afterAll(async () => {
  await app?.close();
  await nativeApp?.close();
  await pool?.end();
  await owner?.end();
});

describe("firma y distribución", () => {
  let ana: string; // admin, inicia runs
  let rita: string; // reviewer + approver
  let sam: string; // signatory (sin MFA)
  let lucia: string; // firmante
  let org: string;
  let ws: string;
  let wf: string;
  let docId: string;
  let runId: string;
  let envelopeId: string;
  const user: Record<string, string> = {};

  const drain = () => app.workflows.drain();
  const run = async (id: string, token = ana) => (await call(token, "GET", `/v1/organizations/${org}/runs/${id}`)).json();
  const pending = async (id: string) => (await run(id)).approvals.find((a: { status: string }) => a.status === "PENDING");
  const decide = (token: string, a: { id: string; action_hash: string }, decision = "approve") =>
    call(token, "POST", `/v1/organizations/${org}/approvals/${a.id}/decision`, { decision, action_hash: a.action_hash });
  const start = async (workflow: string, body: Record<string, unknown>) => {
    const r = await call(ana, "POST", `/v1/organizations/${org}/workflows/${workflow}/runs`, { task: "Revisa el contrato marco", ...body }, { "idempotency-key": randomUUID() });
    await drain();
    return r;
  };
  const setPolicy = (p: Record<string, unknown>) =>
    call(ana, "PUT", `/v1/organizations/${org}/external-policy`, { allowed_domains: ["partner.test"], share_max_days: 7, approval_max_age_hours: 24, require_mfa_for_signature: false, ...p });

  beforeAll(async () => {
    ana = await login("ana@firma.test");
    rita = await login("rita@firma.test");
    sam = await login("sam@firma.test");
    lucia = await login("lucia@cliente.test");
    const o = (await call(ana, "POST", "/v1/organizations", { name: "Firma Legal" })).json();
    org = o.id;
    ws = o.default_workspace_id;
    for (const email of ["rita@firma.test", "sam@firma.test", "lucia@cliente.test"]) {
      user[email] = (await call(ana, "POST", `/v1/organizations/${org}/members`, { email, role: email.startsWith("lucia") ? "viewer" : "member" })).json().user_id;
    }
    await call(ana, "PUT", `/v1/organizations/${org}/members/${user["rita@firma.test"]}/functional-roles`, { roles: ["reviewer", "approver"] });
    await call(ana, "PUT", `/v1/organizations/${org}/members/${user["sam@firma.test"]}/functional-roles`, { roles: ["signatory"] });

    // Documento indexado con bytes reales en el almacenamiento.
    const bytes = Buffer.from("Contrato marco. Clausula 12: preaviso de treinta (30) dias.");
    docId = randomUUID();
    const ver = randomUUID();
    const key = `tenants/${org}/raw/${docId}/${ver}/contrato.md`;
    storage.objects.set(key, bytes);
    await owner.query("BEGIN");
    await owner.query("INSERT INTO documents (id, organization_id, workspace_id, title, classification) VALUES ($1,$2,$3,'Contrato marco','confidential')", [docId, org, ws]);
    await owner.query(
      `INSERT INTO document_versions (id, organization_id, document_id, version_no, filename, content_type, declared_size, s3_key, status, is_current, checksum_sha256)
       VALUES ($1,$2,$3,1,'contrato.md','text/markdown',$4,$5,'indexed',true,$6)`,
      [ver, org, docId, bytes.length, key, createHash("sha256").update(bytes).digest("hex")],
    );
    await owner.query("UPDATE documents SET current_version_id=$2 WHERE id=$1", [docId, ver]);
    await owner.query("INSERT INTO document_acl (document_id, organization_id, principal) VALUES ($1,$2,$3)", [docId, org, `workspace:${ws}`]);
    await owner.query("COMMIT");
    rag.docs.set(ws, { document_id: docId, version_id: ver });

    const a = (await call(ana, "POST", `/v1/organizations/${org}/agents`, { template: "contract_auditor", space_ids: [ws] })).json();
    expect((await call(ana, "POST", `/v1/organizations/${org}/agents/${a.id}/test`, { input: "preaviso del contrato" })).json().status).toBe("passed");
    expect((await call(ana, "POST", `/v1/organizations/${org}/agents/${a.id}/publish`, { changelog: "first version" })).statusCode).toBe(201);

    wf = (await call(ana, "POST", `/v1/organizations/${org}/workflows`, { template: "contract_signature" })).json().id;
    const pub = await call(ana, "POST", `/v1/organizations/${org}/workflows/${wf}/publish`, { changelog: "first version" });
    expect(pub.statusCode, JSON.stringify(pub.json())).toBe(201);
  });

  it("política externa: solo admin; el run exige firmantes y destinatarios permitidos (caso 7 al iniciar)", async () => {
    expect((await call(rita, "PUT", `/v1/organizations/${org}/external-policy`, { allowed_domains: [], share_max_days: 7, approval_max_age_hours: 24, require_mfa_for_signature: false })).statusCode).toBe(403);
    expect((await setPolicy({})).statusCode).toBe(200);
    expect((await start(wf, { recipients: ["legal@partner.test"] })).statusCode).toBe(400); // sin firmantes
    const denied = await start(wf, { signers: [{ name: "Lucía", email: "lucia@cliente.test" }], recipients: ["x@gmail.com"] });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("recipient_not_allowed");
    const audit = (await call(ana, "GET", `/v1/organizations/${org}/audit`)).json().events;
    expect(audit.find((e: { action: string }) => e.action === "share.denied")).toMatchObject({ decision: "deny", metadata: { domains: ["gmail.com"] } });
  });

  it("revisión humana ⇒ versión APPROVED ⇒ sobre DRAFT; el gate de envío queda atado al sobre", async () => {
    const r = await start(wf, { signers: [{ name: "Lucía", email: "LUCIA@cliente.test" }], recipients: ["legal@partner.test"] });
    expect(r.statusCode).toBe(202);
    runId = r.json().id;
    expect((await decide(rita, await pending(runId))).statusCode).toBe(200);
    await drain();
    const x = await run(runId);
    expect(x.state).toBe("WAITING_HUMAN");
    const draft = x.steps.find((s: { node_id: string }) => s.node_id === "envelope");
    expect(draft.state).toBe("SUCCEEDED");
    envelopeId = draft.output.envelope_id;
    const gate = await pending(runId);
    expect(gate.assigned_role).toBe("signatory");
    expect(gate.binding.details.envelope).toMatchObject({ id: envelopeId, signers: [{ email: "lucia@cliente.test" }] });
    const e = (await call(ana, "GET", `/v1/organizations/${org}/signatures/${envelopeId}`)).json();
    expect(e.state).toBe("DRAFT");
    expect(e.documents[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    const lc = await owner.query("SELECT state FROM document_lifecycle WHERE document_id=$1", [docId]);
    expect(lc.rows[0].state).toBe("APPROVED");
  });

  it("enviar exige el rol signatory y MFA si la política lo pide; luego el run espera al proveedor", async () => {
    await setPolicy({ require_mfa_for_signature: true });
    const gate = await pending(runId);
    expect((await decide(rita, gate)).statusCode).toBe(403); // sin rol
    const noMfa = await decide(sam, gate);
    expect(noMfa.json().error.code).toBe("mfa_required");
    const samMfa = await login("sam@firma.test", true);
    expect((await decide(samMfa, gate)).statusCode).toBe(200);
    await drain();
    const x = await run(runId);
    expect(x.state).toBe("WAITING_EXTERNAL");
    expect((await call(ana, "GET", `/v1/organizations/${org}/signatures/${envelopeId}`)).json().state).toBe("SENT");
    await setPolicy({});
  });

  it("SIGNED solo por evento verificado: firma inválida o vieja no cambia nada", async () => {
    const ext = (await owner.query("SELECT external_id FROM signature_envelopes WHERE id=$1", [envelopeId])).rows[0].external_id;
    const ev = { eventId: randomUUID(), externalId: ext, status: "COMPLETED" as const, occurredAt: new Date().toISOString() };
    const forged = new LocalProvider("attacker-secret-0123456789-0123456789-xx").sign(ev);
    expect((await webhook(forged.raw, forged.headers)).statusCode).toBe(401);
    const stale = provider.sign(ev, Date.now() - 60 * 60_000);
    expect((await webhook(stale.raw, stale.headers)).statusCode).toBe(401);
    expect((await call(ana, "GET", `/v1/organizations/${org}/signatures/${envelopeId}`)).json().state).toBe("SENT");
    // Un no firmante no puede firmar.
    expect((await call(rita, "POST", `/v1/organizations/${org}/signatures/${envelopeId}/local-sign`, { decision: "sign", typed_name: "Rita", consent: true })).statusCode).toBe(403);
  });

  it("la firmante firma ⇒ webhook verificado ⇒ COMPLETED con evidencia ⇒ el run continúa", async () => {
    const s = await call(lucia, "POST", `/v1/organizations/${org}/signatures/${envelopeId}/local-sign`, { decision: "sign", typed_name: "Lucía Pérez", consent: true });
    expect(s.statusCode, JSON.stringify(s.json())).toBe(200);
    expect(s.json().state).toBe("COMPLETED");
    await drain();
    const e = (await call(ana, "GET", `/v1/organizations/${org}/signatures/${envelopeId}`)).json();
    expect(e.state).toBe("COMPLETED");
    expect(e.evidence.certificate).toBe(true);
    const cert = JSON.parse(storage.objects.get(`tenants/${org}/signatures/${envelopeId}/certificate.json`)!.toString());
    expect(cert.signers[0]).toMatchObject({ signer_email: "lucia@cliente.test", typed_name: "Lucía Pérez", decision: "signed" });
    expect(cert.disclaimer).toMatch(/NOT a legally binding/);
    expect((await owner.query("SELECT state FROM document_lifecycle WHERE document_id=$1", [docId])).rows[0].state).toBe("SIGNED");
    const x = await run(runId);
    expect(x.state).toBe("WAITING_HUMAN");
    expect(x.steps.find((st: { node_id: string }) => st.node_id === "signed").state).toBe("SUCCEEDED");
    expect((await call(lucia, "POST", `/v1/organizations/${org}/signatures/${envelopeId}/local-sign`, { decision: "sign", typed_name: "Lucía", consent: true })).statusCode).toBe(409);
  });

  it("caso 6: el proveedor repite el webhook ⇒ un solo efecto por event_id", async () => {
    const ext = (await owner.query("SELECT external_id FROM signature_envelopes WHERE id=$1", [envelopeId])).rows[0].external_id;
    const ev = { eventId: `evt-${randomUUID()}`, externalId: ext, status: "COMPLETED" as const, occurredAt: new Date().toISOString() };
    const a = provider.sign(ev);
    const first = await webhook(a.raw, a.headers);
    const second = await webhook(a.raw, a.headers);
    expect(first.statusCode).toBe(200);
    expect(first.json().applied).toBe(false); // ya COMPLETED: no reescribe evidencia
    expect(second.json()).toEqual({ duplicate: true });
    const inbox = await owner.query("SELECT count(*)::int AS n FROM webhook_inbox WHERE event_id=$1", [ev.eventId]);
    expect(inbox.rows[0].n).toBe(1);
    const completed = await owner.query("SELECT count(*)::int AS n FROM outbox_events WHERE type='SIGNATURE_COMPLETED' AND aggregate_id=$1", [`envelope:${envelopeId}`]);
    expect(completed.rows[0].n).toBe(1);
  });

  it("distribución: aprobación ⇒ enlace del documento firmado; revelar rota el token; revocar corta el acceso", async () => {
    const gate = await pending(runId);
    expect(gate.binding.details).toMatchObject({ kind: "share", recipients: ["legal@partner.test"], artifact: { kind: "signed" }, expires_days: 7 });
    expect((await decide(rita, gate)).statusCode).toBe(200);
    await drain();
    const x = await run(runId);
    expect(x.state).toBe("COMPLETED");
    expect(x.events.map((e: { type: string }) => e.type)).toEqual(expect.arrayContaining(["SIGNATURE_SENT", "SIGNATURE_COMPLETED", "SHARE_CREATED", "DOCUMENT_DISTRIBUTED"]));
    expect((await owner.query("SELECT state FROM document_lifecycle WHERE document_id=$1", [docId])).rows[0].state).toBe("DISTRIBUTED");

    const shares = (await call(ana, "GET", `/v1/organizations/${org}/shares`)).json().shares;
    expect(shares).toHaveLength(1);
    expect(shares[0]).toMatchObject({ artifact: "signed", recipients: ["legal@partner.test"], status: "active" });
    const tokenRow = await owner.query("SELECT token_hash FROM shares WHERE id=$1", [shares[0].id]);
    expect(tokenRow.rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/); // solo hash en BD

    const r1 = (await call(ana, "POST", `/v1/organizations/${org}/shares/${shares[0].id}/reveal`)).json();
    expect(r1.url).toMatch(/^https:\/\/app\.ragsis\.test\/s\/[A-Za-z0-9_-]{43}$/);
    const t1 = r1.url.split("/s/")[1];
    const open = await app.inject({ method: "GET", url: `/v1/shares/access/${t1}` });
    expect(open.statusCode).toBe(302);
    expect(open.headers.location).toContain("http://s3.local/");
    const t2 = (await call(ana, "POST", `/v1/organizations/${org}/shares/${shares[0].id}/reveal`)).json().url.split("/s/")[1];
    expect((await app.inject({ method: "GET", url: `/v1/shares/access/${t1}` })).statusCode).toBe(404); // rotado
    expect((await call(rita, "POST", `/v1/organizations/${org}/shares/${shares[0].id}/revoke`)).statusCode).toBe(403);
    expect((await call(ana, "POST", `/v1/organizations/${org}/shares/${shares[0].id}/revoke`)).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/v1/shares/access/${t2}` })).statusCode).toBe(410);
    const access = await owner.query("SELECT count(*)::int AS n FROM audit_events WHERE action='share.accessed' AND organization_id=$1", [org]);
    expect(access.rows[0].n).toBe(2);
  });

  it("caso 7 en ejecución: si la política se endurece antes de compartir, se deniega y registra", async () => {
    const graph = {
      nodes: [
        { id: "start", type: "START" },
        { id: "audit", type: "AGENT_TASK", agent: "contract-auditor" },
        { id: "approve", type: "HUMAN_REVIEW", role: "reviewer" },
        { id: "gate", type: "APPROVAL_GATE", role: "approver" },
        { id: "share", type: "EXTERNAL_ACTION", tool: "share_document" },
        { id: "end", type: "END" },
      ],
      edges: [["start", "audit"], ["audit", "approve"], ["approve", "gate"], ["gate", "share"], ["share", "end"]],
    };
    const w = (await call(ana, "POST", `/v1/organizations/${org}/workflows`, { name: "Share only" })).json().id;
    await call(ana, "PUT", `/v1/organizations/${org}/workflows/${w}/draft`, { graph });
    expect((await call(ana, "POST", `/v1/organizations/${org}/workflows/${w}/publish`, { changelog: "first version" })).statusCode).toBe(201);
    const id = (await start(w, { recipients: ["legal@partner.test"] })).json().id;
    await decide(rita, await pending(id));
    await drain();
    await setPolicy({ allowed_domains: ["otro.test"] });
    await decide(rita, await pending(id));
    await drain();
    const x = await run(id);
    expect(x.state).toBe("FAILED");
    expect(x.error_code).toBe("recipient_not_allowed");
    const denies = (await call(ana, "GET", `/v1/organizations/${org}/audit`)).json().events.filter((e: { action: string }) => e.action === "share.denied");
    expect(denies[0].metadata).toMatchObject({ reason: "domain_not_allowed", domains: ["partner.test"] });
    expect((await owner.query("SELECT count(*)::int AS n FROM shares WHERE run_id=$1", [id])).rows[0].n).toBe(0);
    await setPolicy({});
  });

  it("anular un sobre enviado termina el run que lo espera", async () => {
    const id = (await start(wf, { signers: [{ name: "Lucía", email: "lucia@cliente.test" }], recipients: ["legal@partner.test"] })).json().id;
    await decide(rita, await pending(id));
    await drain();
    const samMfa = await login("sam@firma.test", true);
    await decide(samMfa, await pending(id));
    await drain();
    expect((await run(id)).state).toBe("WAITING_EXTERNAL");
    const env = (await owner.query("SELECT id FROM signature_envelopes WHERE run_id=$1", [id])).rows[0].id;
    expect((await call(ana, "POST", `/v1/organizations/${org}/signatures/${env}/void`, { reason: "wrong counterparty" })).statusCode).toBe(200);
    const x = await run(id);
    expect(x.state).toBe("FAILED");
    expect(x.error_code).toBe("signature_voided");
  });

  const native = (token: string, method: "GET" | "POST", path: string, payload?: object, headers: Record<string, string> = {}) =>
    nativeApp.inject({ method, url: `/v1/organizations/${org}/${path}`, payload, headers: { authorization: `Bearer ${token}`, ...headers } });

  async function pdfFixture(classification = "confidential") {
    const doc = randomUUID();
    const version = randomUUID();
    const key = `tenants/${org}/raw/${doc}/${version}/contract.pdf`;
    const pdf = await PDFDocument.create();
    pdf.addPage().drawText("Immutable contract");
    const bytes = Buffer.from(await pdf.save());
    storage.objects.set(key, bytes);
    await owner.query("BEGIN");
    await owner.query("INSERT INTO documents (id, organization_id, workspace_id, title, classification) VALUES ($1,$2,$3,'PDF contract',$4)", [doc, org, ws, classification]);
    await owner.query(
      `INSERT INTO document_versions (id, organization_id, document_id, version_no, filename, content_type, declared_size, s3_key, status, is_current, checksum_sha256)
       VALUES ($1,$2,$3,1,'contract.pdf','application/pdf',$4,$5,'indexed',true,$6)`,
      [version, org, doc, bytes.length, key, createHash("sha256").update(bytes).digest("hex")],
    );
    await owner.query("UPDATE documents SET current_version_id=$2 WHERE id=$1", [doc, version]);
    await owner.query("INSERT INTO document_acl (document_id, organization_id, principal) VALUES ($1,$2,$3)", [doc, org, `workspace:${ws}`]);
    await owner.query("COMMIT");
    return { doc, version, key };
  }

  it("firma nativa manual: aprobación separada, invitación rotada, dos firmantes y sello verificable", async () => {
    const fixture = await pdfFixture();
    const headers = { "idempotency-key": randomUUID() };
    const body = {
      subject: "Service contract", version_ids: [fixture.version], signers: [
        { name: "Lucía Pérez", email: "lucia@cliente.test" }, { name: "Guest Signer", email: "native@partner.test" },
      ],
    };
    const created = await native(ana, "POST", "signatures", body, headers);
    expect(created.statusCode, created.body).toBe(201);
    const route = `signatures/${created.json().id}`;
    expect((await native(ana, "POST", "signatures", body, headers)).json()).toMatchObject({ id: created.json().id, replay: true });
    expect((await native(ana, "POST", "signatures", { ...body, subject: "Changed" }, headers)).statusCode).toBe(409);

    const approver = await login("sam@firma.test", true);
    const approval = (await native(approver, "GET", route)).json().action_hash;
    expect(approval).toMatch(/^[a-f0-9]{64}$/);
    expect((await native(ana, "POST", `${route}/send`, { action_hash: approval })).statusCode).toBe(403);
    expect((await native(approver, "POST", `${route}/send`, { action_hash: "0".repeat(64) })).statusCode).toBe(409);
    expect((await native(approver, "POST", `${route}/send`, { action_hash: approval })).statusCode).toBe(200);
    const firstRenewal = await native(ana, "POST", `${route}/remind`, { email: "native@partner.test" });
    expect(firstRenewal.statusCode, firstRenewal.body).toBe(200);
    expect(firstRenewal.json().development_url).toBeUndefined();
    await deliverSignatureInvites(nativeDeps);
    const url = deliveries.get("native@partner.test");
    expect(url).toMatch(/^https:\/\/app\.ragsis\.test\/sign#[A-Za-z0-9_-]{43}$/);
    const guestToken = new URL(url!).hash.slice(1);
    const guest = (action: string, payload?: object, auth = guestToken) =>
      nativeApp.inject({ method: "POST", url: `/v1/signature-guest/${action}`, payload, headers: { authorization: `Signature ${auth}` } });

    expect((await guest("open", undefined, "x".repeat(43))).statusCode).toBe(404);
    expect((await guest("open")).json()).toMatchObject({ state: "DELIVERED", awaiting_me: true, email: "native@partner.test" });
    expect((await guest("document", { version_id: fixture.version })).statusCode).toBe(200);
    expect((await guest("document", { version_id: randomUUID() })).statusCode).toBe(404);
    expect((await native(rita, "POST", `${route}/respond`, { decision: "sign", typed_name: "Rita", consent: true })).statusCode).toBe(403);
    expect((await guest("respond", { decision: "sign", typed_name: "Guest Signer", consent: false })).statusCode).toBe(400);

    // S3 source edits after dispatch cannot change the signing copy.
    storage.objects.set(fixture.key, Buffer.from("changed original"));
    const guestBody = { decision: "sign", typed_name: "Guest Signer", consent: true };
    const results = await Promise.all([
      guest("respond", guestBody),
      native(lucia, "POST", `${route}/respond`, { decision: "sign", typed_name: "Lucía Pérez", consent: true }),
    ]);
    expect(results.map((res) => res.statusCode), results.map((res) => res.body).join("\n")).toEqual([200, 200]);
    expect((await guest("respond", guestBody)).json()).toMatchObject({ state: "COMPLETED", remaining: 0 });
    expect((await guest("signed")).statusCode).toBe(200);
    await deliverSignatureInvites(nativeDeps);
    expect(mailKinds.get("native@partner.test")).toBe("completed");
    const env = (await owner.query("SELECT evidence FROM signature_envelopes WHERE id=$1", [created.json().id])).rows[0];
    const signed = storage.objects.get(env.evidence.signed_key)!;
    const proof = JSON.parse(storage.objects.get(env.evidence.certificate_key)!.toString());
    expect((await PDFDocument.load(signed)).getPageCount()).toBe(2);
    expect(proof.manifest.signers.map((s: { identity_method: string }) => s.identity_method).sort()).toEqual(["account", "email_link"]);
    expect(proof.manifest.signed_sha256).toBe(createHash("sha256").update(signed).digest("hex"));
    expect(verify(null, Buffer.from(canonical(proof.manifest)), proof.public_key, Buffer.from(proof.signature, "base64url"))).toBe(true);
    expect(verify(null, Buffer.from(canonical({ ...proof.manifest, signed_sha256: "altered" })), proof.public_key, Buffer.from(proof.signature, "base64url"))).toBe(false);
    const verification = await nativeApp.inject({ method: "GET", url: `/v1/signature-proof/${created.json().id}` });
    expect(verification.json()).toMatchObject({ signed_sha256: env.evidence.signed_sha256, certificate_sha256: env.evidence.certificate_sha256 });
    expect(verification.json()).not.toHaveProperty("signers");
    expect((await owner.query("SELECT count(*)::int n FROM outbox_events WHERE type='SIGNATURE_COMPLETED' AND aggregate_id=$1", [`envelope:${created.json().id}`])).rows[0].n).toBe(1);
  });

  it("reutiliza firmas privadas y preserva la imagen aceptada aunque se borre de la cuenta", async () => {
    const makeImage = async (color: string, format: "png" | "jpeg") => (await sharp({
      create: { width: 180, height: 36, channels: 3, background: color },
    }).toFormat(format).toBuffer()).toString("base64");
    const png = await makeImage("#102345", "png");
    const jpg = await makeImage("#542618", "jpeg");
    const library = (token: string, method: "GET" | "POST" | "DELETE", id = "", payload?: object) =>
      nativeApp.inject({ method, url: `/v1/me/signatures${id ? `/${id}` : ""}`, payload, headers: { authorization: `Bearer ${token}` } });
    expect((await library(lucia, "POST", "", { label: "Invalid", image: "dGV4dA==" })).statusCode).toBe(400);
    const saved = await library(lucia, "POST", "", { label: "Full signature", image: png });
    expect(saved.statusCode, saved.body).toBe(201);
    const asset = saved.json();
    const mine = await library(lucia, "GET");
    expect(mine.headers["cache-control"]).toBe("no-store");
    expect(mine.json().signatures).toEqual([asset]);
    expect((await library(ana, "GET")).json().signatures).toEqual([]);
    expect((await library(ana, "DELETE", asset.id)).statusCode).toBe(404);

    const { version } = await pdfFixture();
    const guestEmail = "image-guest@partner.test";
    const created = await native(ana, "POST", "signatures", {
      subject: "Sign with images", version_ids: [version],
      signers: [{ name: "Lucía Pérez", email: "lucia@cliente.test" }, { name: "Guest Signer", email: guestEmail }],
    }, { "idempotency-key": randomUUID() });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id;
    const route = `signatures/${id}`;
    const approver = await login("sam@firma.test", true);
    const { action_hash } = (await native(approver, "GET", route)).json();
    expect((await native(approver, "POST", `${route}/send`, { action_hash })).statusCode).toBe(200);
    const other = await library(ana, "POST", "", { label: "Other signature", image: png });
    const body = { decision: "sign", typed_name: "Lucía Pérez", consent: true, appearance: { type: "saved", id: asset.id } };
    expect((await native(lucia, "POST", `${route}/respond`, { ...body, appearance: { type: "saved", id: other.json().id } })).statusCode).toBe(404);
    expect((await native(lucia, "POST", `${route}/respond`, body)).json()).toMatchObject({ remaining: 1 });
    expect((await library(lucia, "DELETE", asset.id)).statusCode).toBe(204);
    expect((await native(lucia, "POST", `${route}/respond`, body)).statusCode).toBe(200);
    expect((await native(lucia, "POST", `${route}/respond`, { ...body, appearance: undefined })).statusCode).toBe(409);

    await deliverSignatureInvites(nativeDeps);
    const token = new URL(deliveries.get(guestEmail)!).hash.slice(1);
    const guest = (appearance: object) => nativeApp.inject({
      method: "POST", url: "/v1/signature-guest/respond", headers: { authorization: `Signature ${token}` },
      payload: { decision: "sign", typed_name: "Guest Signer", consent: true, appearance },
    });
    expect((await guest({ type: "saved", id: other.json().id })).statusCode).toBe(403);
    const complete = await guest({ type: "image", image: jpg });
    expect(complete.statusCode, complete.body).toBe(200);
    expect(complete.json().state).toBe("COMPLETED");

    const { evidence } = (await owner.query("SELECT evidence FROM signature_envelopes WHERE id=$1", [id])).rows[0];
    const pdf = await PDFDocument.load(storage.objects.get(evidence.signed_key)!);
    const marks = pdf.getPage(1).node.Resources()!.lookup(PDFName.of("XObject"), PDFDict);
    expect(marks.keys()).toHaveLength(2);
    const certificate = JSON.parse(storage.objects.get(evidence.certificate_key)!.toString());
    expect(certificate.manifest.signers[0].signature_image_sha256).toBe(createHash("sha256").update(Buffer.from(asset.image, "base64")).digest("hex"));
    expect(certificate.manifest.signers[1].signature_image_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(certificate.manifest.signers[0]).not.toHaveProperty("image_png");
    expect(certificate.manifest.signers[0]).not.toHaveProperty("personal_signature_id");
  });

  it("bloquea PDFs restringidos para invitados y un enlace anulado queda inaccesible", async () => {
    const restricted = await pdfFixture("restricted");
    const normal = await pdfFixture();
    const approver = await login("sam@firma.test", true);
    const guestEmail = "void-test@partner.test";
    for (const fixture of [restricted, normal]) {
      const res = await native(ana, "POST", "signatures", {
        subject: "External request", version_ids: [fixture.version], signers: [{ name: "Guest", email: guestEmail }],
      }, { "idempotency-key": randomUUID() });
      expect(res.statusCode, res.body).toBe(201);
      const route = `signatures/${res.json().id}`;
      const { action_hash } = (await native(approver, "GET", route)).json();
      const sent = await native(approver, "POST", `${route}/send`, { action_hash });
      expect(sent.statusCode, sent.body).toBe(fixture === restricted ? 403 : 200);
      if (fixture === restricted) continue;
      await deliverSignatureInvites(nativeDeps);
      const token = new URL(deliveries.get(guestEmail)!).hash.slice(1);
      const open = (key: string) => nativeApp.inject({ method: "POST", url: "/v1/signature-guest/open", headers: { authorization: `Signature ${key}` } });
      await owner.query("UPDATE signature_invitations SET last_attempt_at=now()-interval '2 minutes' WHERE envelope_id=$1", [res.json().id]);
      expect((await native(ana, "POST", `${route}/remind`, { email: guestEmail })).statusCode).toBe(200);
      expect((await open(token)).statusCode).toBe(404);
      await deliverSignatureInvites(nativeDeps);
      const replacement = new URL(deliveries.get(guestEmail)!).hash.slice(1);
      expect((await open(replacement)).statusCode).toBe(200);
      expect((await native(ana, "POST", `${route}/void`, { reason: "Wrong signer" })).statusCode).toBe(200);
      const guest = await open(replacement);
      expect(guest.statusCode, guest.body).toBe(410);
    }
  });

  it("el workflow nativo reanuda su gate de distribución al completar la firma", async () => {
    const fixture = await pdfFixture();
    rag.docs.set(ws, { document_id: fixture.doc, version_id: fixture.version });
    const samMfa = await login("sam@firma.test", true);
    const created = await native(ana, "POST", `workflows/${wf}/runs`, {
      task: "Revisa el contrato", signers: [{ name: "Lucía", email: "lucia@cliente.test" }], recipients: ["legal@partner.test"],
    }, { "idempotency-key": randomUUID() });
    expect(created.statusCode, created.body).toBe(202);
    const id = created.json().id;
    await nativeApp.workflows.drain();
    const approveNative = async (token: string) => {
      const a = await pending(id);
      const decision = await native(token, "POST", `approvals/${a.id}/decision`, { decision: "approve", action_hash: a.action_hash });
      expect(decision.statusCode, decision.body).toBe(200);
      await nativeApp.workflows.drain();
    };
    await approveNative(rita);
    const gate = await pending(id);
    expect(gate.binding.details.envelope.provider).toBe("native");
    await approveNative(samMfa);
    expect((await run(id)).state).toBe("WAITING_EXTERNAL");
    const signed = await native(lucia, "POST", `signatures/${gate.binding.details.envelope.id}/respond`, { decision: "sign", typed_name: "Lucía Pérez", consent: true });
    expect(signed.json(), signed.body).toMatchObject({ state: "COMPLETED" });
    await nativeApp.workflows.drain();
    expect((await pending(id)).binding.details.artifact.kind).toBe("signed");
    await approveNative(rita);
    expect((await run(id)).state).toBe("COMPLETED");
  });
});
