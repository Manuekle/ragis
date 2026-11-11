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
import { conversationTitle } from "../src/routes/conversations.js";
import type { RagClient } from "../src/routes/query.js";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const env = Object.fromEntries(
  readFileSync(path.join(ROOT, ".env"), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const PORT = process.env.POSTGRES_HOST_PORT ?? "55432";
const DB = "ragsis_conversations_test";
const SECRET = "conversations-test-internal-secret-0123456789";

const storage = { presignPut: async () => "", presignGet: async () => "", head: async () => null, delete: async () => undefined, put: async () => undefined, get: async () => null } as Storage;
const queue: Queue = { send: async () => undefined };

/** Eco con citas configurables: `citeDocument` es el documento que «usa» la próxima respuesta. */
class FakeRag implements RagClient {
  citeDocument: string | null = null;
  async query(_token: string, body: Record<string, unknown>) {
    const citations = this.citeDocument
      ? [{ n: 1, document_id: this.citeDocument, version_id: randomUUID(), version_no: 1, title: "Política", filename: "politica.md", section: "", page: null, effective_from: null, snippet: "…", chunk_id: randomUUID() }]
      : [];
    return {
      status: 200,
      body: { trace_id: `qry_${randomUUID().replaceAll("-", "").slice(0, 24)}`, answer: `eco: ${body.question}`, abstained: false, citations, latency_ms: 12, timings: { secret: 1 }, cost_estimate_usd: 0.5 },
    };
  }
}

let app: FastifyInstance;
let pool: pg.Pool;
let owner: pg.Client;
const rag = new FakeRag();

const call = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as "GET", url, payload: payload as object, headers: { authorization: `Bearer ${token}` } });

async function login(email: string): Promise<string> {
  const r = await app.inject({ method: "POST", url: "/v1/auth/dev-login", payload: { email } });
  expect(r.statusCode).toBe(200);
  const token = r.json().token as string;
  await call(token, "GET", "/v1/me"); // crea el usuario
  return token;
}

/** Organización nueva con su dueña (Alice) y un miembro (Bob) en el workspace por defecto. */
async function setup(tag: string) {
  const alice = await login(`alice@${tag}.test`);
  const bob = await login(`bob@${tag}.test`);
  const o = (await call(alice, "POST", "/v1/organizations", { name: `Org ${tag}` })).json();
  const bobId = (await call(alice, "POST", `/v1/organizations/${o.id}/members`, { email: `bob@${tag}.test`, role: "member" })).json().user_id;
  await call(alice, "POST", `/v1/organizations/${o.id}/workspaces/${o.default_workspace_id}/members`, { user_id: bobId, role: "reader" });
  const ask = (token: string, question: string, conversationId?: string, extra: object = {}) =>
    call(token, "POST", `/v1/organizations/${o.id}/workspaces/${o.default_workspace_id}/query`, { question, ...(conversationId ? { conversation_id: conversationId } : {}), ...extra });
  return { alice, bob, org: o.id as string, ws: o.default_workspace_id as string, ask };
}

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: `postgres://ragsis_owner:${env.POSTGRES_PASSWORD}@127.0.0.1:${PORT}/ragsis` });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${DB}`);
  await admin.end();
  const ownerUrl = `postgres://ragsis_owner:${env.POSTGRES_PASSWORD}@127.0.0.1:${PORT}/${DB}`;
  await migrate(ownerUrl, path.join(ROOT, "db/migrations"));
  owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();
  const cfg = loadConfig({
    DATABASE_URL: `postgres://ragsis_app:${env.RAGSIS_APP_DB_PASSWORD}@127.0.0.1:${PORT}/${DB}`,
    INTERNAL_SERVICE_SECRET: SECRET,
    AUTH_MODE: "dev",
    JWT_DEV_SECRET: "dev-secret-for-tests-0123456789abcdefghij",
    RAGSIS_ENV: "test",
  });
  pool = createPool(cfg.DATABASE_URL);
  app = await buildApp({ cfg, pool, storage, queue, rag });
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await owner?.end();
});

describe("historial de conversaciones", () => {
  it("guarda cada turno, lo lista y lo reabre en orden", async () => {
    const { alice, org, ask } = await setup("save");
    const id = randomUUID();
    const first = await ask(alice, "¿Cuál es el plazo de reembolso?", id);
    expect(first.statusCode).toBe(200);
    expect(first.json().conversation_id).toBe(id);
    expect((await ask(alice, "¿Y para viajes?", id, { as_of: "2026-01-15" })).json().conversation_id).toBe(id);

    const list = (await call(alice, "GET", `/v1/organizations/${org}/conversations`)).json();
    expect(list.conversations).toHaveLength(1);
    expect(list.conversations[0]).toMatchObject({ id, title: "¿Cuál es el plazo de reembolso?", turns: 2 });
    expect(list.next_before).toBeNull();

    const conv = (await call(alice, "GET", `/v1/organizations/${org}/conversations/${id}`)).json();
    expect(conv.turns.map((t: { question: string }) => t.question)).toEqual(["¿Cuál es el plazo de reembolso?", "¿Y para viajes?"]);
    expect(conv.turns[0].result.answer).toBe("eco: ¿Cuál es el plazo de reembolso?");
    expect(conv.turns[1].as_of).toBe("2026-01-15");
    expect(conv.turns[0].redacted).toBe(false);
    // Solo lo que la pantalla necesita: nada de tiempos ni costes internos.
    expect(conv.turns[0].result.timings).toBeUndefined();
    expect(conv.turns[0].result.cost_estimate_usd).toBeUndefined();
  });

  it("sin conversation_id no guarda nada", async () => {
    const { alice, org, ask } = await setup("nosave");
    const r = await ask(alice, "pregunta suelta");
    expect(r.statusCode).toBe(200);
    expect(r.json().conversation_id).toBeUndefined();
    expect((await call(alice, "GET", `/v1/organizations/${org}/conversations`)).json().conversations).toEqual([]);
  });

  it("es privado: ni otro miembro ni otra organización la ven, y no se puede escribir en ella", async () => {
    const { alice, bob, org, ask } = await setup("priv");
    const id = randomUUID();
    await ask(alice, "dato sensible", id);
    const url = `/v1/organizations/${org}/conversations/${id}`;

    expect((await call(bob, "GET", `/v1/organizations/${org}/conversations`)).json().conversations).toEqual([]);
    expect((await call(bob, "GET", url)).statusCode).toBe(404);
    expect((await call(bob, "PATCH", url, { title: "mía" })).statusCode).toBe(404);
    expect((await call(bob, "DELETE", url)).statusCode).toBe(404);

    // Bob usa el id de Alice: responde, pero el turno NO se guarda ni aparece en la conversación de ella.
    const hijack = await ask(bob, "intento", id);
    expect(hijack.statusCode).toBe(200);
    expect(hijack.json().conversation_id).toBeUndefined();
    const conv = (await call(alice, "GET", url)).json();
    expect(conv.turns).toHaveLength(1);

    const outsider = await login("eve@elsewhere.test");
    expect((await call(outsider, "GET", url)).statusCode).toBe(404);
    expect((await call(outsider, "GET", `/v1/organizations/${org}/conversations`)).statusCode).toBe(404);
  });

  it("renombrar no la mueve en la lista; borrar elimina también sus turnos", async () => {
    const { alice, org, ask } = await setup("edit");
    const a = randomUUID();
    const b = randomUUID();
    await ask(alice, "primera", a);
    await ask(alice, "segunda", b);
    const url = `/v1/organizations/${org}/conversations/${a}`;

    const renamed = await call(alice, "PATCH", url, { title: "  Reembolsos 2026  " });
    expect(renamed.json().title).toBe("Reembolsos 2026");
    const order = (await call(alice, "GET", `/v1/organizations/${org}/conversations`)).json().conversations.map((c: { id: string }) => c.id);
    expect(order).toEqual([b, a]); // la más reciente primero; renombrar no cambia el orden
    expect((await call(alice, "PATCH", url, { title: "   " })).statusCode).toBe(400);
    expect((await call(alice, "PATCH", url, { title: "x".repeat(121) })).statusCode).toBe(400);

    expect((await call(alice, "DELETE", url)).statusCode).toBe(204);
    expect((await call(alice, "GET", url)).statusCode).toBe(404);
    expect((await call(alice, "DELETE", url)).statusCode).toBe(404);
    expect((await owner.query("SELECT count(*)::int AS n FROM conversation_turns WHERE conversation_id=$1", [a])).rows[0].n).toBe(0);
    expect((await owner.query("SELECT count(*)::int AS n FROM audit_events WHERE action='conversation.delete' AND resource=$1", [`conversation:${a}`])).rows[0].n).toBe(1);
  });

  it("oculta los turnos cuyo documento citado ya no es visible (permiso retirado o borrado)", async () => {
    const { alice, bob, org, ws, ask } = await setup("acl");
    const doc = randomUUID();
    await owner.query("INSERT INTO documents (id, organization_id, workspace_id, title) VALUES ($1,$2,$3,'Política')", [doc, org, ws]);
    await owner.query("INSERT INTO document_acl (document_id, organization_id, principal) VALUES ($1,$2,$3)", [doc, org, `workspace:${ws}`]);

    const id = randomUUID();
    await ask(bob, "pregunta sin fuentes", id);
    rag.citeDocument = doc;
    await ask(bob, "pregunta con fuente", id);
    rag.citeDocument = null;
    const url = `/v1/organizations/${org}/conversations/${id}`;

    let turns = (await call(bob, "GET", url)).json().turns;
    expect(turns.map((t: { redacted: boolean }) => t.redacted)).toEqual([false, false]);
    expect(turns[1].result.citations).toHaveLength(1);

    // Le quitan el acceso al documento: el turno con fuentes se oculta; el resto sigue legible.
    await owner.query("DELETE FROM document_acl WHERE document_id=$1", [doc]);
    turns = (await call(bob, "GET", url)).json().turns;
    expect(turns[0]).toMatchObject({ redacted: false, question: "pregunta sin fuentes" });
    expect(turns[1]).toMatchObject({ redacted: true, result: null, question: "pregunta con fuente" });

    // Documento borrado aunque el permiso siga: también oculto.
    await owner.query("INSERT INTO document_acl (document_id, organization_id, principal) VALUES ($1,$2,$3)", [doc, org, `workspace:${ws}`]);
    expect((await call(bob, "GET", url)).json().turns[1].redacted).toBe(false);
    await owner.query("UPDATE documents SET status='deleted' WHERE id=$1", [doc]);
    expect((await call(bob, "GET", url)).json().turns[1].redacted).toBe(true);
    void alice;
  });

  it("pagina con cursor sin repetir ni saltar conversaciones", async () => {
    const { alice, org, ask } = await setup("page");
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (const [i, id] of ids.entries()) await ask(alice, `pregunta ${i}`, id);

    const p1 = (await call(alice, "GET", `/v1/organizations/${org}/conversations?limit=2`)).json();
    expect(p1.conversations.map((c: { id: string }) => c.id)).toEqual([ids[2], ids[1]]);
    expect(p1.next_before).toEqual(expect.any(String));
    const p2 = (await call(alice, "GET", `/v1/organizations/${org}/conversations?limit=2&before=${encodeURIComponent(p1.next_before)}`)).json();
    expect(p2.conversations.map((c: { id: string }) => c.id)).toEqual([ids[0]]);
    expect(p2.next_before).toBeNull();

    expect((await call(alice, "GET", `/v1/organizations/${org}/conversations?before=ayer`)).statusCode).toBe(400);
    expect((await call(alice, "GET", `/v1/organizations/${org}/conversations?limit=1000`)).statusCode).toBe(400);
  });

  it("valida el id y rechaza claves de servicio", async () => {
    const { alice, org, ws, ask } = await setup("keys");
    expect((await ask(alice, "hola mundo", "no-es-uuid")).statusCode).toBe(400);
    expect((await call(alice, "GET", `/v1/organizations/${org}/conversations/no-es-uuid`)).statusCode).toBe(404);

    const key = (await call(alice, "POST", `/v1/organizations/${org}/api-keys`, { name: "int", scopes: ["query"], workspace_ids: [ws] })).json().token as string;
    const withId = await call(key, "POST", `/v1/organizations/${org}/workspaces/${ws}/query`, { question: "hola mundo", conversation_id: randomUUID() });
    expect(withId.statusCode).toBe(400);
    // Sin conversation_id la clave sigue funcionando como antes.
    expect((await call(key, "POST", `/v1/organizations/${org}/workspaces/${ws}/query`, { question: "hola mundo" })).statusCode).toBe(200);
    expect((await call(key, "GET", `/v1/organizations/${org}/conversations`)).statusCode).toBe(403);
  });
});

describe("conversationTitle", () => {
  it("compacta espacios y recorta sin partir caracteres", () => {
    expect(conversationTitle("  ¿Qué\n  dice   la política? ")).toBe("¿Qué dice la política?");
    const long = conversationTitle("😀".repeat(200));
    expect([...long]).toHaveLength(80);
    expect(long.endsWith("…")).toBe(true);
  });
});
