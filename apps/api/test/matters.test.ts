import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { decodeJwt } from "jose";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createPool } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import type { Queue, Storage } from "../src/lib/aws.js";
import type { RagClient } from "../src/routes/query.js";

/** ADR-037: expedientes (registro de la firma, vínculo de documentos sin tocar la ACL) y Preguntar con alcance. */

const ROOT = path.resolve(import.meta.dirname, "../../..");
const env = Object.fromEntries(
  readFileSync(path.join(ROOT, ".env"), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const PORT = process.env.POSTGRES_HOST_PORT ?? "55432";
const DB = "ragsis_matters_test";
const SECRET = "matters-test-internal-secret-0123456789abcdef";

const storage = { presignPut: async () => "https://s3.test/put", presignGet: async () => "https://s3.test/get", head: async () => null, delete: async () => undefined, put: async () => undefined, get: async () => null } as Storage;
const queue: Queue = { send: async () => undefined };

/** Guarda los claims de alcance firmados en el token interno y responde como el rag-engine. */
class FakeRag implements RagClient {
  claims: Record<string, unknown> = {};
  async query(token: string) {
    this.claims = decodeJwt(token);
    return {
      status: 200,
      body: { trace_id: `qry_${randomUUID().replaceAll("-", "").slice(0, 24)}`, answer: "…", abstained: false, citations: [], latency_ms: 5 },
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
  await call(token, "GET", "/v1/me");
  return token;
}

/**
 * Firma con dos espacios: General (alice editora, bob lector) y Litigio (solo alice). Carol es viewer de la organización.
 */
async function setup(tag: string) {
  const alice = await login(`alice@${tag}.test`);
  const bob = await login(`bob@${tag}.test`);
  const carol = await login(`carol@${tag}.test`);
  const o = (await call(alice, "POST", "/v1/organizations", { name: `Firma ${tag}` })).json();
  const org = o.id as string;
  const general = o.default_workspace_id as string;
  const base = `/v1/organizations/${org}`;
  const bobId = (await call(alice, "POST", `${base}/members`, { email: `bob@${tag}.test`, role: "member" })).json().user_id as string;
  const carolId = (await call(alice, "POST", `${base}/members`, { email: `carol@${tag}.test`, role: "viewer" })).json().user_id as string;
  await call(alice, "POST", `${base}/workspaces/${general}/members`, { user_id: bobId, role: "reader" });
  await call(alice, "POST", `${base}/workspaces/${general}/members`, { user_id: carolId, role: "reader" });
  const litigio = (await call(alice, "POST", `${base}/workspaces`, { name: "Litigio constitucional" })).json().id as string;
  const aliceId = (await call(alice, "GET", "/v1/me")).json().user.id as string;

  const doc = async (ws: string, title: string, opts: { acl?: string[]; folder?: string } = {}) => {
    const r = await call(alice, "POST", `${base}/documents/uploads`, {
      workspace_id: ws, filename: `${title}.md`, content_type: "text/markdown", size_bytes: 10, title,
      ...(opts.acl ? { acl: opts.acl } : {}), ...(opts.folder ? { folder_id: opts.folder } : {}),
    });
    expect(r.statusCode).toBe(201);
    return r.json().document_id as string;
  };
  const matter = (token: string, body: object) => call(token, "POST", `${base}/matters`, body);
  const link = (token: string, ids: string[], matterId: string | null) =>
    call(token, "POST", `${base}/documents/matter`, { document_ids: ids, matter_id: matterId });
  const ask = (token: string, ws: string, scope?: object) =>
    call(token, "POST", `${base}/workspaces/${ws}/query`, { question: "¿Qué decidió la Corte?", ...(scope ? { scope } : {}) });
  const memberWorkspaces = async (userId: string) =>
    (await owner.query("SELECT workspace_id FROM workspace_members WHERE user_id=$1 AND organization_id=$2", [userId, org])).rows
      .map((r) => r.workspace_id as string)
      .sort();
  return { alice, bob, carol, org, base, general, litigio, aliceId, bobId, doc, matter, link, ask, memberWorkspaces };
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

describe("expedientes (ADR-037)", () => {
  it("creates, lists, edits and deletes expedientes with the right roles", async () => {
    const { alice, bob, carol, base, aliceId, matter } = await setup("crud");
    const r = await matter(alice, { client_name: "Juan Felipe Parra Rosas", case_number: "D-16.857", court: "Corte Constitucional", stage: "Fallo", owner_id: aliceId });
    expect(r.statusCode).toBe(201);
    const m = r.json();
    expect(m).toMatchObject({ title: "Juan Felipe Parra Rosas — D-16.857", status: "active", document_count: 0, owner: { id: aliceId } });

    // El radicado identifica el proceso: no se repite (sin distinguir mayúsculas ni espacios).
    expect((await matter(bob, { client_name: "Otro", case_number: " d-16.857 " })).statusCode).toBe(409);
    expect((await matter(carol, { client_name: "Viewer" })).statusCode).toBe(403);
    expect((await matter(alice, { client_name: "" })).statusCode).toBe(400);
    expect((await matter(alice, { client_name: "X", owner_id: randomUUID() })).statusCode).toBe(400);
    const gomez = (await matter(bob, { client_name: "Inversiones Gómez SAS", title: "Arrendamiento bodega" })).json();

    const list = (await call(carol, "GET", `${base}/matters`)).json();
    expect(list.can_edit).toBe(false);
    expect(list.matters.map((x: { client_name: string }) => x.client_name)).toEqual(["Inversiones Gómez SAS", "Juan Felipe Parra Rosas"]);
    expect((await call(alice, "GET", `${base}/matters?q=16.857`)).json().matters).toHaveLength(1);

    const p = await call(alice, "PATCH", `${base}/matters/${m.id}`, { stage: "Seguimiento", status: "on_hold", counterparty: "" });
    expect(p.statusCode).toBe(200);
    expect(p.json()).toMatchObject({ stage: "Seguimiento", status: "on_hold", counterparty: null });
    expect((await call(alice, "GET", `${base}/matters?status=on_hold`)).json().matters).toHaveLength(1);

    // Borrar: admin o quien lo creó.
    expect((await call(bob, "DELETE", `${base}/matters/${m.id}`)).statusCode).toBe(403);
    expect((await call(bob, "DELETE", `${base}/matters/${gomez.id}`)).statusCode).toBe(204);
    expect((await call(alice, "DELETE", `${base}/matters/${m.id}`)).statusCode).toBe(204);
    expect((await call(alice, "GET", `${base}/matters/${m.id}`)).statusCode).toBe(404);
  });

  it("links documents across spaces without changing who can read them", async () => {
    const { alice, bob, base, general, litigio, aliceId, doc, matter, link } = await setup("link");
    const sentencia = await doc(general, "Sentencia C-217 de 2026");
    const matriz = await doc(litigio, "Matriz de riesgos");
    const memo = await doc(general, "Memorando de honorarios", { acl: [`user:${aliceId}`] });
    const m = (await matter(alice, { client_name: "Parra Rosas", case_number: "D-16.857" })).json();
    const aclBefore = (await owner.query("SELECT document_id, principal FROM document_acl ORDER BY 1, 2")).rows;

    // Bob es lector en General: no puede vincular.
    expect((await link(bob, [sentencia], m.id)).statusCode).toBe(403);
    const r = await link(alice, [sentencia, matriz, memo], m.id);
    expect(r.json()).toMatchObject({ linked: 3, matter_id: m.id });
    expect((await owner.query("SELECT document_id, principal FROM document_acl ORDER BY 1, 2")).rows).toEqual(aclBefore);
    const audit = await owner.query("SELECT resource, metadata FROM audit_events WHERE action='document.matter_linked' ORDER BY id");
    expect(audit.rows.at(-1)).toMatchObject({ resource: `matter:${m.id}`, metadata: { documents: 3 } });

    // Alice ve los tres, en sus dos espacios; Bob solo lo que su ACL y sus espacios le dejan abrir.
    const forAlice = (await call(alice, "GET", `${base}/matters/${m.id}`)).json();
    expect(forAlice.document_count).toBe(3);
    expect(new Set(forAlice.documents.map((d: { workspace_name: string }) => d.workspace_name))).toEqual(new Set(["General", "Litigio constitucional"]));
    const forBob = (await call(bob, "GET", `${base}/matters/${m.id}`)).json();
    expect(forBob.document_count).toBe(1);
    expect(forBob.documents.map((d: { id: string }) => d.id)).toEqual([sentencia]);
    expect(forBob).toMatchObject({ client_name: "Parra Rosas", case_number: "D-16.857", can_edit: true, can_delete: false });

    // La biblioteca filtra por expediente y muestra cliente y expediente.
    const docs = (await call(alice, "GET", `${base}/documents?workspace_id=${general}&matter_id=${m.id}`)).json().documents;
    expect(docs.map((d: { id: string }) => d.id).sort()).toEqual([sentencia, memo].sort());
    expect(docs[0]).toMatchObject({ matter_id: m.id, matter_title: m.title, matter_client: "Parra Rosas", matter_case_number: "D-16.857" });
    expect((await call(alice, "GET", `${base}/documents?workspace_id=${general}&matter_id=none`)).json().documents).toHaveLength(0);

    // Desvincular y borrar el expediente nunca borra documentos.
    expect((await link(alice, [memo], null)).json()).toMatchObject({ linked: 1 });
    expect((await call(alice, "DELETE", `${base}/matters/${m.id}`)).statusCode).toBe(204);
    const left = await owner.query("SELECT count(*)::int AS n FROM documents WHERE id = ANY($1) AND status='active' AND matter_id IS NULL", [[sentencia, matriz, memo]]);
    expect(left.rows[0].n).toBe(3);
  });

  it("converts a folder (with subfolders) into an expediente and keeps the folder", async () => {
    const { alice, base, general, doc, matter, link } = await setup("folder");
    const parent = (await call(alice, "POST", `${base}/folders`, { workspace_id: general, name: "Expediente D-16.857" })).json().id as string;
    const child = (await call(alice, "POST", `${base}/folders`, { workspace_id: general, name: "Escritos", parent_id: parent })).json().id as string;
    const a = await doc(general, "Sentencia", { folder: parent });
    const b = await doc(general, "Escrito de corrección", { folder: child });
    const c = await doc(general, "Cronología", { folder: parent });
    const other = (await matter(alice, { client_name: "Otro cliente" })).json();
    await link(alice, [c], other.id);

    const r = await call(alice, "POST", `${base}/matters/from-folder`, { folder_id: parent, client_name: "Juan Felipe Parra Rosas", case_number: "D-16.857" });
    expect(r.statusCode).toBe(201);
    const out = r.json();
    expect(out).toMatchObject({ linked: 2, skipped: 1, matter: { title: "Expediente D-16.857", document_count: 2 } });
    const linked = await owner.query("SELECT id, matter_id, folder_id FROM documents WHERE id = ANY($1)", [[a, b, c]]);
    const byId = Object.fromEntries(linked.rows.map((x) => [x.id, x]));
    expect(byId[a].matter_id).toBe(out.matter.id);
    expect(byId[b].matter_id).toBe(out.matter.id);
    expect(byId[c].matter_id).toBe(other.id);
    expect(byId[b].folder_id).toBe(child);
    expect((await call(alice, "GET", `${base}/folders?workspace_id=${general}`)).json().folders).toHaveLength(2);
  });
});

describe("Ask with a scope (ADR-037)", () => {
  it("signs the scope into the internal token as a subset of the person's spaces", async () => {
    const { alice, bob, general, litigio, aliceId, bobId, doc, matter, link, ask, memberWorkspaces } = await setup("scope");
    const m = (await matter(alice, { client_name: "Parra Rosas", case_number: "D-16.857" })).json();
    const sentencia = await doc(general, "Sentencia C-217 de 2026");
    const memo = await doc(general, "Memorando de honorarios", { acl: [`user:${aliceId}`] });
    await link(alice, [sentencia], m.id);

    // Sin alcance: el espacio activo, como siempre.
    const plain = await ask(alice, litigio);
    expect(plain.statusCode).toBe(200);
    expect(rag.claims).toMatchObject({ ws: litigio, wss: [litigio], sc: { k: "space" } });
    expect(plain.json().scope).toMatchObject({ type: "space", label: "Litigio constitucional", workspaces: 1 });

    // Expediente: todos los espacios de quien pregunta, nunca los de otra persona.
    const r = await ask(alice, litigio, { type: "matter", id: m.id });
    expect(r.json().scope).toMatchObject({ type: "matter", id: m.id, label: m.title, client: "Parra Rosas", case_number: "D-16.857" });
    expect([...(rag.claims.wss as string[])].sort()).toEqual(await memberWorkspaces(aliceId));
    expect(rag.claims.sc).toEqual({ k: "matter", m: m.id });
    await ask(bob, general, { type: "matter", id: m.id });
    expect(rag.claims.wss).toEqual(await memberWorkspaces(bobId));
    expect(rag.claims.wss).toEqual([general]);

    // Todos mis espacios.
    await ask(bob, general, { type: "all" });
    expect(rag.claims).toMatchObject({ wss: [general], sc: { k: "all" } });

    // Carpetas: solo del espacio activo, con sus subcarpetas (las resuelve el rag-engine).
    const folder = (await call(alice, "POST", `/v1/organizations/${(rag.claims.org as string)}/folders`, { workspace_id: general, name: "Cliente — Parra Rosas" })).json().id;
    expect((await ask(alice, litigio, { type: "folder", id: folder })).statusCode).toBe(404);
    await ask(alice, general, { type: "folder", id: folder });
    expect(rag.claims).toMatchObject({ wss: [general], sc: { k: "folder", f: folder } });

    // Documentos: solo los que la persona puede leer; si no queda ninguno, 404 sin revelar si existen.
    expect((await ask(bob, general, { type: "documents", ids: [memo] })).statusCode).toBe(404);
    const d = await ask(bob, general, { type: "documents", ids: [memo, sentencia] });
    expect(d.statusCode).toBe(200);
    expect(rag.claims).toMatchObject({ wss: [general], sc: { k: "documents", d: [sentencia] } });
    expect(d.json().scope).toMatchObject({ type: "documents", ids: [sentencia], label: "Sentencia C-217 de 2026" });

    // Un expediente que no existe en la organización.
    expect((await ask(alice, general, { type: "matter", id: randomUUID() })).statusCode).toBe(404);
    expect((await ask(alice, general, { type: "documents", ids: [] })).statusCode).toBe(400);
  });
});
