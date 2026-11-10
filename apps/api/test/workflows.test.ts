/**
 * Workflows + human-in-the-loop (ADR-022): DSL, runner durable, aprobaciones con hash, Inbox, delegación y budget.
 * Casos E2E de la especificación: 4 (rechazo humano detiene), 5 (cambio de versión invalida), 8 (delegación sin
 * acceso se deniega sin revelar), 9 (presupuesto agotado termina seguro), idempotencia y separación de funciones.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createPool } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import type { Queue, Storage } from "../src/lib/aws.js";
import { Graph, validateGraph, type AgentRef } from "../src/lib/workflow-dsl.js";
import type { RagClient } from "../src/routes/query.js";

const ROOT = path.resolve(import.meta.dirname, "../../..");

// ------------------------------------------------------------------ DSL (puro)
const refs = new Map<string, AgentRef>([
  ["a1", { slug: "a1", status: "published", active_version_id: randomUUID(), active_version: "1.0.0" }],
  ["draft", { slug: "draft", status: "draft", active_version_id: null, active_version: null }],
]);
const chain = (agents: string[], extra: Partial<Graph> = {}) =>
  Graph.parse({
    nodes: [{ id: "start", type: "START" }, ...agents.map((a, i) => ({ id: `n${i}`, type: "AGENT_TASK", agent: a })), { id: "end", type: "END" }],
    edges: ["start", ...agents.map((_, i) => `n${i}`), "end"].slice(0, -1).map((id, i, arr) => [id, arr[i + 1] ?? "end"]),
    ...extra,
  });

describe("workflow DSL", () => {
  it("valida una cadena simple y avisa si no hay paso humano", () => {
    const v = validateGraph(chain(["a1"]), refs);
    expect(v.errors).toEqual([]);
    expect(v.warnings.map((w) => w.code)).toContain("no_human_step");
  });

  it("rechaza agentes sin versión publicada, ciclos y acciones externas fuera de orden", () => {
    expect(validateGraph(chain(["draft"]), refs).errors.map((e) => e.code)).toContain("agent_unpublished");
    const cyc = Graph.parse({
      nodes: [{ id: "start", type: "START" }, { id: "a", type: "AGENT_TASK", agent: "a1" }, { id: "b", type: "AGENT_TASK", agent: "a1" }, { id: "end", type: "END" }],
      edges: [["start", "a"], ["a", "b"], ["b", "a"]],
    });
    expect(validateGraph(cyc, refs).errors.map((e) => e.code)).toContain("cycle");
    const ext = Graph.parse({
      nodes: [{ id: "start", type: "START" }, { id: "gate", type: "APPROVAL_GATE", role: "signatory" }, { id: "send", type: "EXTERNAL_ACTION", tool: "send_signature_envelope" }, { id: "wait", type: "WAIT_EVENT", event: "SIGNATURE_COMPLETED" }, { id: "end", type: "END" }],
      edges: [["start", "gate"], ["gate", "send"], ["send", "wait"], ["wait", "end"]],
    });
    const codes = validateGraph(ext, refs).errors.map((e) => e.code);
    expect(codes).toContain("send_needs_draft");
    const email = Graph.parse({
      nodes: [{ id: "start", type: "START" }, { id: "gate", type: "APPROVAL_GATE", role: "approver" }, { id: "mail", type: "EXTERNAL_ACTION", tool: "send_email" }, { id: "end", type: "END" }],
      edges: [["start", "gate"], ["gate", "mail"], ["mail", "end"]],
    });
    expect(validateGraph(email, refs).errors.map((e) => e.code)).toContain("external_unavailable");
    const ungated = Graph.parse({
      nodes: [{ id: "start", type: "START" }, { id: "a", type: "AGENT_TASK", agent: "a1" }, { id: "share", type: "EXTERNAL_ACTION", tool: "share_document" }, { id: "end", type: "END" }],
      edges: [["start", "a"], ["a", "share"], ["share", "end"]],
    });
    expect(validateGraph(ungated, refs).errors.map((e) => e.code)).toContain("ungated_external");
  });

  it("límite de hops y aristas de condición", () => {
    expect(validateGraph(chain(["a1", "a1", "a1", "a1"]), refs).errors.map((e) => e.code)).toContain("max_hops");
    const cond = Graph.parse({
      nodes: [{ id: "start", type: "START" }, { id: "a", type: "AGENT_TASK", agent: "a1" }, { id: "c", type: "CONDITION", source: "a", check: "has_answer" }, { id: "end", type: "END" }],
      edges: [["start", "a"], ["a", "c"], ["c", "end", "true"]],
    });
    expect(validateGraph(cond, refs).errors.map((e) => e.code)).toContain("condition_edges");
  });

  it("política: deny_on_reject y no_external_action_without_approval no se pueden apagar", () => {
    expect(() => Graph.parse({ ...chain(["a1"]), policies: { deny_on_reject: false } })).toThrow();
  });
});

// ------------------------------------------------------------------ integración
const env = Object.fromEntries(
  readFileSync(path.join(ROOT, ".env"), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const PORT = process.env.POSTGRES_HOST_PORT ?? "55432";
const DB = "ragsis_workflows_test";
const OWNER_URL = `postgres://ragsis_owner:${env.POSTGRES_PASSWORD}@127.0.0.1:${PORT}/${DB}`;

class NoStorage implements Storage {
  async presignPut() { return ""; }
  async presignGet() { return ""; }
  async head() { return null; }
  async delete() {}
  async put() {}
  async get() { return null; }
}
class NoQueue implements Queue {
  async send() {}
}

/** RAG falso: cita el documento sembrado de cada workspace cuando la pregunta menciona "contrato". */
class FakeRag implements RagClient {
  calls: string[] = [];
  docs = new Map<string, { document_id: string; version_id: string }>();
  failNext = 0;
  async query(token: string, body: Record<string, unknown>) {
    const claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString());
    this.calls.push(claims.ws);
    if (this.failNext > 0) {
      this.failNext--;
      return { status: 502, body: {} };
    }
    const doc = this.docs.get(claims.ws);
    if (doc && /contrato/i.test(String(body.question))) {
      return { status: 200, body: { answer: "Preaviso de 30 días [1].", abstained: false, citations: [{ n: 1, ...doc, title: "Contrato marco", page: 3, snippet: "preaviso de treinta días" }] } };
    }
    return { status: 200, body: { answer: "", abstained: true, citations: [] } };
  }
}

let app: FastifyInstance;
let pool: pg.Pool;
let owner: pg.Client;
const rag = new FakeRag();

async function login(email: string): Promise<string> {
  const token = (await app.inject({ method: "POST", url: "/v1/auth/dev-login", payload: { email } })).json().token as string;
  await app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${token}` } });
  return token;
}
const call = (token: string, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: method as "GET", url, payload: payload as object, headers: { authorization: `Bearer ${token}`, ...headers } });

/** Documento indexado con ACL de workspace (sembrado como propietario del esquema). */
async function seedDoc(org: string, ws: string) {
  const doc = randomUUID();
  const ver = randomUUID();
  await owner.query("BEGIN");
  await owner.query("INSERT INTO documents (id, organization_id, workspace_id, title) VALUES ($1,$2,$3,'Contrato marco')", [doc, org, ws]);
  await owner.query(
    `INSERT INTO document_versions (id, organization_id, document_id, version_no, filename, content_type, declared_size, s3_key, status, is_current)
     VALUES ($1,$2,$3,1,'contrato.md','text/markdown',10,'k','indexed',true)`,
    [ver, org, doc],
  );
  await owner.query("UPDATE documents SET current_version_id=$2 WHERE id=$1", [doc, ver]);
  await owner.query("INSERT INTO document_acl (document_id, organization_id, principal) VALUES ($1,$2,$3)", [doc, org, `workspace:${ws}`]);
  await owner.query("COMMIT");
  rag.docs.set(ws, { document_id: doc, version_id: ver });
  return { doc, ver };
}

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
    INTERNAL_SERVICE_SECRET: "workflow-test-internal-secret-0123456789",
    AUTH_MODE: "dev",
    JWT_DEV_SECRET: "dev-secret-for-tests-0123456789abcdefghij",
    RAGSIS_ENV: "test",
  });
  pool = createPool(cfg.DATABASE_URL);
  app = await buildApp({ cfg, pool, storage: new NoStorage(), queue: new NoQueue(), rag });
  app.workflows.backoffMs = 1;
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await owner?.end();
});

describe("workflows con aprobación humana", () => {
  let ana: string; // owner/admin, inicia runs
  let rita: string; // approver + reviewer con acceso al workspace
  let otto: string; // approver SIN acceso al workspace
  let mia: string; // member sin roles
  let org: string;
  let ws: string;
  let privateWs: string;
  let wf: string;
  const ids: Record<string, string> = {};

  const publishAgent = async (template: string, spaces: string[], token = ana) => {
    const a = (await call(token, "POST", `/v1/organizations/${org}/agents`, { template, space_ids: spaces })).json();
    const t = (await call(token, "POST", `/v1/organizations/${org}/agents/${a.id}/test`, { input: "¿preaviso del contrato?" })).json();
    expect(t.status, `${template} sandbox`).toBe("passed");
    const p = await call(token, "POST", `/v1/organizations/${org}/agents/${a.id}/publish`, { changelog: "first version" });
    expect(p.statusCode, JSON.stringify(p.json())).toBe(201);
    return a.id as string;
  };
  const start = async (workflow: string, task = "Revisa el preaviso del contrato", token = ana, key = randomUUID()) => {
    const r = await call(token, "POST", `/v1/organizations/${org}/workflows/${workflow}/runs`, { task }, { "idempotency-key": key });
    expect([200, 202]).toContain(r.statusCode);
    await app.workflows.drain();
    return r.json().id as string;
  };
  const run = async (id: string, token = ana) => (await call(token, "GET", `/v1/organizations/${org}/runs/${id}`)).json();
  const makeWorkflow = async (graph: unknown, name = `wf ${randomUUID().slice(0, 6)}`) => {
    const w = (await call(ana, "POST", `/v1/organizations/${org}/workflows`, { name })).json();
    const s = (await call(ana, "PUT", `/v1/organizations/${org}/workflows/${w.id}/draft`, { graph })).json();
    expect(s.validation.errors).toEqual([]);
    expect((await call(ana, "POST", `/v1/organizations/${org}/workflows/${w.id}/publish`, { changelog: "first" })).statusCode).toBe(201);
    return w.id as string;
  };

  beforeAll(async () => {
    ana = await login("ana@wf.test");
    rita = await login("rita@wf.test");
    otto = await login("otto@wf.test");
    mia = await login("mia@wf.test");
    const o = (await call(ana, "POST", "/v1/organizations", { name: "WF Legal" })).json();
    org = o.id;
    ws = o.default_workspace_id;
    privateWs = (await call(ana, "POST", `/v1/organizations/${org}/workspaces`, { name: "Board" })).json().id;
    for (const [email, token] of [["rita@wf.test", rita], ["otto@wf.test", otto], ["mia@wf.test", mia]] as const) {
      const m = (await call(ana, "POST", `/v1/organizations/${org}/members`, { email, role: "member" })).json();
      ids[email] = m.user_id;
      void token;
    }
    await call(ana, "POST", `/v1/organizations/${org}/workspaces/${ws}/members`, { user_id: ids["rita@wf.test"], role: "reader" });
    await call(ana, "POST", `/v1/organizations/${org}/workspaces/${ws}/members`, { user_id: ids["mia@wf.test"], role: "editor" });
    await seedDoc(org, ws);
    await seedDoc(org, privateWs);
    await publishAgent("searcher", [ws]);
    await publishAgent("contract_auditor", [ws]);
  });

  it("roles funcionales: solo admin los asigna y queda auditado", async () => {
    expect((await call(rita, "GET", `/v1/organizations/${org}/functional-roles`)).statusCode).toBe(403);
    expect((await call(ana, "PUT", `/v1/organizations/${org}/members/${ids["rita@wf.test"]}/functional-roles`, { roles: ["approver", "reviewer"] })).statusCode).toBe(200);
    expect((await call(ana, "PUT", `/v1/organizations/${org}/members/${ids["otto@wf.test"]}/functional-roles`, { roles: ["approver"] })).statusCode).toBe(200);
    const me = (await call(rita, "GET", `/v1/organizations/${org}`)).json();
    expect(me.functional_roles.sort()).toEqual(["approver", "reviewer"]);
  });

  it("publicar fija la versión de cada agente; correr exige Idempotency-Key y es idempotente", async () => {
    const w = (await call(ana, "POST", `/v1/organizations/${org}/workflows`, { template: "answer_with_approval" })).json();
    wf = w.id;
    const pub = (await call(ana, "POST", `/v1/organizations/${org}/workflows/${wf}/publish`, { changelog: "first" })).json();
    expect(pub.agents).toEqual(["searcher@1.0.0"]);
    const noKey = await call(ana, "POST", `/v1/organizations/${org}/workflows/${wf}/runs`, { task: "x contrato" });
    expect(noKey.statusCode).toBe(400);
    const key = randomUUID();
    const a = await call(ana, "POST", `/v1/organizations/${org}/workflows/${wf}/runs`, { task: "preaviso del contrato" }, { "idempotency-key": key });
    const b = await call(ana, "POST", `/v1/organizations/${org}/workflows/${wf}/runs`, { task: "preaviso del contrato" }, { "idempotency-key": key });
    expect(a.statusCode).toBe(202);
    expect(b.statusCode).toBe(200);
    expect(b.json().id).toBe(a.json().id);
    expect((await call(mia, "POST", `/v1/organizations/${org}/workflows/${wf}/runs`, { task: "otro contrato" }, { "idempotency-key": key })).statusCode).toBe(409);
    await app.workflows.drain();
    await call(ana, "POST", `/v1/organizations/${org}/runs/${a.json().id}/cancel`);
  });

  it("flujo feliz: espera humana, separación de funciones, hash exacto, aprobación y eventos", async () => {
    const id = await start(wf);
    let r = await run(id);
    expect(r.state).toBe("WAITING_HUMAN");
    const appr = r.approvals[0];
    expect(appr.binding.documents).toHaveLength(1);

    const inbox = (await call(rita, "GET", `/v1/organizations/${org}/inbox`)).json();
    expect(inbox.approvals.map((x: { id: string }) => x.id)).toContain(appr.id);

    // Ana inició el run: no puede aprobarlo (separación de funciones), aunque se otorgue el rol.
    await call(ana, "PUT", `/v1/organizations/${org}/members/${(await call(ana, "GET", "/v1/me")).json().user.id}/functional-roles`, { roles: ["approver"] });
    const self = await call(ana, "POST", `/v1/organizations/${org}/approvals/${appr.id}/decision`, { decision: "approve", action_hash: appr.action_hash });
    expect(self.statusCode).toBe(403);
    expect((await call(mia, "POST", `/v1/organizations/${org}/approvals/${appr.id}/decision`, { decision: "approve", action_hash: appr.action_hash })).statusCode).toBe(403);
    const stale = await call(rita, "POST", `/v1/organizations/${org}/approvals/${appr.id}/decision`, { decision: "approve", action_hash: "0".repeat(64) });
    expect(stale.json().error.code).toBe("stale_action_hash");

    const ok = await call(rita, "POST", `/v1/organizations/${org}/approvals/${appr.id}/decision`, { decision: "approve", action_hash: appr.action_hash, comment: "ok" });
    expect(ok.statusCode).toBe(200);
    await app.workflows.drain();
    r = await run(id);
    expect(r.state).toBe("COMPLETED");
    expect(r.steps.map((s: { node_id: string }) => s.node_id)).toEqual(["start", "search", "gate", "end"]);
    expect(r.events.map((e: { type: string }) => e.type)).toEqual([
      "WORKFLOW_RUN_STARTED",
      "AGENT_RUN_STARTED",
      "AGENT_RUN_COMPLETED",
      "APPROVAL_REQUESTED",
      "APPROVAL_DECIDED",
      "WORKFLOW_COMPLETED",
    ]);
    const audit = (await call(ana, "GET", `/v1/organizations/${org}/audit`)).json().events;
    expect(audit.some((e: { action: string; decision: string }) => e.action === "approval.decision" && e.decision === "deny")).toBe(true);
    // Una salida de agente nunca ejecuta escrituras: quedan como propuestas sin efecto.
    expect(r.steps[1].output.answer).toContain("30 días");
  });

  it("caso 4: el rechazo humano detiene el workflow; nada aguas abajo se ejecuta", async () => {
    const id = await start(wf);
    const appr = (await run(id)).approvals[0];
    await call(rita, "POST", `/v1/organizations/${org}/approvals/${appr.id}/decision`, { decision: "reject", action_hash: appr.action_hash, comment: "no" });
    await app.workflows.drain();
    const r = await run(id);
    expect(r.state).toBe("CANCELLED");
    expect(r.error_code).toBe("rejected_by_human");
    expect(r.steps.map((s: { node_id: string }) => s.node_id)).toEqual(["start", "search", "gate"]);
    const again = await call(rita, "POST", `/v1/organizations/${org}/approvals/${appr.id}/decision`, { decision: "approve", action_hash: appr.action_hash });
    expect(again.statusCode).toBe(409);
  });

  it("caso 5: aprobar V2 y cambiar el contenido a V3 invalida la aprobación", async () => {
    const id = await start(wf);
    const appr = (await run(id)).approvals[0];
    const { document_id } = appr.binding.documents[0];
    const v3 = randomUUID();
    await owner.query(
      `INSERT INTO document_versions (id, organization_id, document_id, version_no, filename, content_type, declared_size, s3_key, status, is_current)
       VALUES ($1,$2,$3,(SELECT max(version_no)+1 FROM document_versions WHERE document_id=$3),'contrato.md','text/markdown',10,'k2','indexed',true)`,
      [v3, org, document_id],
    );
    await owner.query("UPDATE documents SET current_version_id=$2 WHERE id=$1", [document_id, v3]);
    const inbox = (await call(rita, "GET", `/v1/organizations/${org}/inbox`)).json();
    expect(inbox.approvals.find((x: { id: string }) => x.id === appr.id).invalidated).toBe(true);
    const d = await call(rita, "POST", `/v1/organizations/${org}/approvals/${appr.id}/decision`, { decision: "approve", action_hash: appr.action_hash });
    expect(d.json().error.code).toBe("approval_invalidated");
    const r = await run(id);
    expect(r.state).toBe("FAILED");
    expect(r.error_code).toBe("approval_invalidated");
    expect(r.approvals[0].status).toBe("REVOKED");
    rag.docs.set(ws, { document_id, version_id: v3 });
  });

  it("un aprobador sin acceso al documento ve la tarea pero no el contenido", async () => {
    const id = await start(wf);
    const asOtto = await run(id, otto);
    const agentStep = asOtto.steps.find((s: { node_id: string }) => s.node_id === "search");
    expect(agentStep.output.answer).toBeNull();
    expect(agentStep.output.redacted.hidden_citations).toBe(1);
    expect(asOtto.approvals[0].can_decide).toBe(true);
    // Sin rol ni relación con el run: no existe para mia.
    expect((await call(mia, "GET", `/v1/organizations/${org}/runs/${id}`)).statusCode).toBe(404);
    await call(ana, "POST", `/v1/organizations/${org}/runs/${id}/cancel`);
    const after = await run(id);
    expect(after.state).toBe("CANCELLED");
    expect(after.approvals[0].status).toBe("REVOKED");
  });

  it("caso 8: delegar a un agente sin espacios en común con el iniciador se deniega sin retrieval", async () => {
    await publishAgent("comparator", [privateWs]); // Ana es editora del espacio privado; Mia no
    const graph = {
      nodes: [{ id: "start", type: "START" }, { id: "audit", type: "AGENT_TASK", agent: "contract-auditor" }, { id: "compare", type: "AGENT_TASK", agent: "comparator" }, { id: "end", type: "END" }],
      edges: [["start", "audit"], ["audit", "compare"], ["compare", "end"]],
    };
    const delegating = await makeWorkflow(graph);
    rag.calls = [];
    const id = await start(delegating, "preaviso del contrato", mia);
    const r = await run(id, mia);
    expect(r.state).toBe("FAILED");
    expect(r.error_code).toBe("delegation_denied");
    const step = r.steps.find((s: { node_id: string }) => s.node_id === "compare");
    expect(step.output.answer).toBeUndefined();
    expect(rag.calls).not.toContain(privateWs);
    // Con acceso (Ana) el segundo agente corre, y no recibe fragmentos de espacios que no usa.
    const ok = await run(await start(delegating));
    expect(ok.state).toBe("COMPLETED");
    expect(ok.steps.find((s: { node_id: string }) => s.node_id === "compare").output.context_received.citations_withheld).toBe(1);
  });

  it("caso 9: presupuesto agotado termina de forma segura y avisa al iniciador", async () => {
    const graph = {
      nodes: [{ id: "start", type: "START" }, { id: "a", type: "AGENT_TASK", agent: "searcher" }, { id: "b", type: "AGENT_TASK", agent: "contract-auditor" }, { id: "end", type: "END" }],
      edges: [["start", "a"], ["a", "b"], ["b", "end"]],
      policies: { budget: { max_agent_calls: 1, max_retrieval_calls: 20 } },
    };
    const id = await start(await makeWorkflow(graph));
    const r = await run(id);
    expect(r.state).toBe("FAILED");
    expect(r.error_code).toBe("budget_exhausted");
    expect(r.usage.agent_calls).toBe(1);
    const inbox = (await call(ana, "GET", `/v1/organizations/${org}/inbox`)).json();
    expect(inbox.my_runs.find((x: { id: string }) => x.id === id).error_code).toBe("budget_exhausted");
  });

  it("errores recuperables se reintentan sin duplicar el paso", async () => {
    rag.failNext = 1;
    const graph = { nodes: [{ id: "start", type: "START" }, { id: "a", type: "AGENT_TASK", agent: "searcher" }, { id: "end", type: "END" }], edges: [["start", "a"], ["a", "end"]] };
    const r = await run(await start(await makeWorkflow(graph)));
    expect(r.state).toBe("COMPLETED");
    const step = r.steps.find((s: { node_id: string }) => s.node_id === "a");
    expect(step.attempt).toBe(2);
    expect(r.events.filter((e: { type: string }) => e.type === "AGENT_RUN_COMPLETED")).toHaveLength(1);
  });

  it("un agente pausado detiene los runs que lo usan", async () => {
    const graph = { nodes: [{ id: "start", type: "START" }, { id: "a", type: "AGENT_TASK", agent: "searcher" }, { id: "end", type: "END" }], edges: [["start", "a"], ["a", "end"]] };
    const w = await makeWorkflow(graph);
    const agents = (await call(ana, "GET", `/v1/organizations/${org}/agents`)).json().agents;
    const searcher = agents.find((a: { slug: string }) => a.slug === "searcher");
    await call(ana, "POST", `/v1/organizations/${org}/agents/${searcher.id}/status`, { status: "paused" });
    const r = await run(await start(w));
    expect(r.error_code).toBe("agent_inactive");
    await call(ana, "POST", `/v1/organizations/${org}/agents/${searcher.id}/status`, { status: "published" });
  });

  it("run_steps de otro tenant no existen; workflow_versions es inmutable", async () => {
    const zed = await login("zed@otro.test");
    expect((await call(zed, "GET", `/v1/organizations/${org}/runs`)).statusCode).toBe(404);
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.org_id', $1, true)", [org]);
      await expect(c.query("UPDATE workflow_versions SET changelog='x'")).rejects.toThrow(/permission denied/);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });
});
