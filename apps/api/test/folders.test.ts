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

/** ADR-031 (carpetas + sugerencia por contenido) y ADR-030 (subida y transcripción de audio) en la API. */

const ROOT = path.resolve(import.meta.dirname, "../../..");
const env = Object.fromEntries(
  readFileSync(path.join(ROOT, ".env"), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const PORT = process.env.POSTGRES_HOST_PORT ?? "55432";
const DB = "ragsis_folders_test";
const MODEL = "local-hash-1024@v1";

const storage = { presignPut: async () => "https://s3.test/put", presignGet: async () => "https://s3.test/get", head: async () => null, delete: async () => undefined, put: async () => undefined, get: async () => null } as Storage;
const queue: Queue = { send: async () => undefined };

let app: FastifyInstance;
let pool: pg.Pool;
let owner: pg.Client;

const call = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as "GET", url, payload: payload as object, headers: { authorization: `Bearer ${token}` } });

async function login(email: string): Promise<string> {
  const r = await app.inject({ method: "POST", url: "/v1/auth/dev-login", payload: { email } });
  expect(r.statusCode).toBe(200);
  const token = r.json().token as string;
  await call(token, "GET", "/v1/me");
  return token;
}

/** Vector unitario de 1024 dimensiones con peso en unos pocos ejes: controla la similitud entre documentos. */
function vec(weights: Record<number, number>): string {
  const v = new Array<number>(1024).fill(0);
  for (const [i, w] of Object.entries(weights)) v[Number(i)] = w;
  const norm = Math.hypot(...v) || 1;
  return `[${v.map((x) => x / norm).join(",")}]`;
}

async function setup(tag: string) {
  const alice = await login(`alice@${tag}.test`);
  const bob = await login(`bob@${tag}.test`);
  const o = (await call(alice, "POST", "/v1/organizations", { name: `Org ${tag}` })).json();
  const org = o.id as string;
  const ws = o.default_workspace_id as string;
  const bobId = (await call(alice, "POST", `/v1/organizations/${org}/members`, { email: `bob@${tag}.test`, role: "member" })).json().user_id as string;
  await call(alice, "POST", `/v1/organizations/${org}/workspaces/${ws}/members`, { user_id: bobId, role: "reader" });
  const aliceId = (await call(alice, "GET", "/v1/me")).json().user.id as string;
  const base = `/v1/organizations/${org}`;

  const folder = async (name: string, parent?: string | null, token = alice) =>
    call(token, "POST", `${base}/folders`, { workspace_id: ws, name, ...(parent ? { parent_id: parent } : {}) });

  /** Documento ya indexado (lo que dejaría el worker): versión vigente, un chunk y su vector resumen. */
  const indexed = async (title: string, weights: Record<number, number>, opts: { text?: string; acl?: string[]; folder?: string; contentType?: string; filename?: string } = {}) => {
    const s = (await call(alice, "POST", `${base}/documents/uploads`, {
      workspace_id: ws, filename: opts.filename ?? `${title}.md`, content_type: opts.contentType ?? "text/markdown", size_bytes: 10, title,
      ...(opts.acl ? { acl: opts.acl } : {}), ...(opts.folder ? { folder_id: opts.folder } : {}),
    })).json();
    const chunk = randomUUID();
    await owner.query("UPDATE document_versions SET status='indexed', is_current=true, embedding_model=$2, indexed_at=now() WHERE id=$1", [s.version_id, MODEL]);
    await owner.query("UPDATE documents SET current_version_id=$2 WHERE id=$1", [s.document_id, s.version_id]);
    await owner.query(
      `INSERT INTO chunks (id, organization_id, workspace_id, document_id, version_id, ordinal, text, token_count, index_state)
       VALUES ($1,$2,$3,$4,$5,0,$6,10,'active')`,
      [chunk, org, ws, s.document_id, s.version_id, opts.text ?? title],
    );
    await owner.query("INSERT INTO document_centroids (document_id, organization_id, model_version, embedding, chunk_count) VALUES ($1,$2,$3,$4::vector,1)",
      [s.document_id, org, MODEL, vec(weights)]);
    return { id: s.document_id as string, version: s.version_id as string, chunk };
  };
  const suggestions = async (token = alice) =>
    ((r) => (r.statusCode === 200 ? r.json().suggestions : (console.error(r.body), undefined)))(await call(token, "GET", `${base}/documents/folder-suggestions?workspace_id=${ws}`)) as
      { document_id: string; folder_id: string; folder_name: string; score: number; reason: string }[];
  const move = (ids: string[], folderId: string | null, token = alice) =>
    call(token, "POST", `${base}/documents/move`, { document_ids: ids, folder_id: folderId });
  const list = async (query: string, token = alice) =>
    (await call(token, "GET", `${base}/documents?workspace_id=${ws}${query}`)).json().documents as { id: string; folder_id: string | null }[];
  return { alice, bob, aliceId, org, ws, base, folder, indexed, suggestions, move, list };
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
    INTERNAL_SERVICE_SECRET: "folders-test-internal-secret-0123456789abcdef",
    AUTH_MODE: "dev",
    JWT_DEV_SECRET: "dev-secret-for-tests-0123456789abcdefghij",
    RAGSIS_ENV: "test",
  });
  pool = createPool(cfg.DATABASE_URL);
  app = await buildApp({ cfg, pool, storage, queue });
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await owner?.end();
});

describe("carpetas", () => {
  it("crea, anida, renombra y rechaza nombres repetidos, ciclos y profundidad excesiva", async () => {
    const { alice, base, ws, folder } = await setup("tree");
    const legal = (await folder("Legal")).json();
    expect(legal).toMatchObject({ name: "Legal", parent_id: null, document_count: 0 });
    const contratos = (await folder("  Contratos ", legal.id)).json();
    expect(contratos).toMatchObject({ name: "Contratos", parent_id: legal.id });

    expect((await folder("legal")).statusCode).toBe(409); // mismo nombre sin distinguir mayúsculas
    expect((await folder("Legal", legal.id)).statusCode).toBe(201); // mismo nombre en otro nivel: permitido
    expect((await folder("a/b")).statusCode).toBe(400);
    expect((await folder("x", randomUUID())).statusCode).toBe(400);

    const renamed = await call(alice, "PATCH", `${base}/folders/${contratos.id}`, { name: "Contratos 2026" });
    expect(renamed.json().name).toBe("Contratos 2026");
    // Meter una carpeta dentro de su propia descendiente.
    expect((await call(alice, "PATCH", `${base}/folders/${legal.id}`, { parent_id: contratos.id })).statusCode).toBe(400);
    expect((await call(alice, "PATCH", `${base}/folders/${legal.id}`, {})).statusCode).toBe(400);

    let parent = contratos.id as string;
    for (let depth = 3; depth <= 6; depth++) {
      const r = await folder(`Nivel ${depth}`, parent);
      expect(r.statusCode).toBe(201);
      parent = r.json().id;
    }
    expect((await folder("Nivel 7", parent)).statusCode).toBe(400);

    const tree = (await call(alice, "GET", `${base}/folders?workspace_id=${ws}`)).json();
    expect(tree.folders.length).toBe(7);
    expect(tree.unfiled_count).toBe(0);
  });

  it("un lector ve las carpetas pero no las crea, renombra, borra ni mueve documentos", async () => {
    const { alice, bob, base, ws, folder, indexed, move } = await setup("roles");
    const f = (await folder("Finanzas")).json();
    const doc = await indexed("Presupuesto", { 1: 1 });
    expect((await call(bob, "GET", `${base}/folders?workspace_id=${ws}`)).json().folders).toHaveLength(1);
    expect((await folder("Otra", null, bob)).statusCode).toBe(403);
    expect((await call(bob, "PATCH", `${base}/folders/${f.id}`, { name: "x" })).statusCode).toBe(403);
    expect((await call(bob, "DELETE", `${base}/folders/${f.id}`)).statusCode).toBe(403);
    expect((await move([doc.id], f.id, bob)).statusCode).toBe(403);
    expect((await move([doc.id], f.id, alice)).json()).toMatchObject({ moved: 1 });
  });

  it("mueve documentos, filtra por carpeta y cuenta solo lo que cada quien puede ver", async () => {
    const { alice, bob, aliceId, base, ws, folder, indexed, move, list } = await setup("move");
    const f = (await folder("Legal")).json();
    const pub = await indexed("Contrato público", { 1: 1 });
    const secret = await indexed("Contrato reservado", { 1: 1 }, { acl: [`user:${aliceId}`] });
    const other = await indexed("Manual", { 2: 1 });
    expect((await move([pub.id, secret.id, randomUUID()], f.id)).json()).toEqual({ moved: 2, folder_id: f.id });

    expect((await list(`&folder_id=${f.id}`)).map((d) => d.id).sort()).toEqual([pub.id, secret.id].sort());
    expect((await list("&folder_id=none")).map((d) => d.id)).toEqual([other.id]);
    expect((await list("")).length).toBe(3);

    const count = async (token: string) =>
      (await call(token, "GET", `${base}/folders?workspace_id=${ws}`)).json().folders[0].document_count;
    expect(await count(alice)).toBe(2);
    expect(await count(bob)).toBe(1); // el reservado no se cuenta ni se lista para Bob
    expect((await list(`&folder_id=${f.id}`, bob)).map((d) => d.id)).toEqual([pub.id]);

    // Mover no toca los permisos del documento.
    const acl = await owner.query("SELECT principal FROM document_acl WHERE document_id=$1", [secret.id]);
    expect(acl.rows.map((r) => r.principal)).toEqual([`user:${aliceId}`]);

    expect((await move([pub.id], null)).json()).toEqual({ moved: 1, folder_id: null });
    expect((await list("&folder_id=none")).length).toBe(2);
    expect((await move([pub.id], randomUUID())).statusCode).toBe(404);
  });

  it("borrar una carpeta borra sus subcarpetas y deja los documentos sin carpeta", async () => {
    const { alice, base, ws, folder, indexed, list } = await setup("delete");
    const top = (await folder("Proyectos")).json();
    const sub = (await folder("Fénix", top.id)).json();
    const doc = await indexed("Plan Fénix", { 3: 1 }, { folder: sub.id });
    expect((await list(`&folder_id=${sub.id}`)).map((d) => d.id)).toEqual([doc.id]);

    expect((await call(alice, "DELETE", `${base}/folders/${top.id}`)).statusCode).toBe(204);
    const tree = (await call(alice, "GET", `${base}/folders?workspace_id=${ws}`)).json();
    expect(tree).toMatchObject({ folders: [], unfiled_count: 1 });
    expect((await list("&folder_id=none")).map((d) => d.id)).toEqual([doc.id]);
    expect((await call(alice, "DELETE", `${base}/folders/${top.id}`)).statusCode).toBe(404);
  });

  it("no acepta subir a una carpeta inexistente o de otra organización", async () => {
    const a = await setup("upa");
    const b = await setup("upb");
    const foreign = (await b.folder("Ajena")).json();
    const up = (folderId: string) =>
      call(a.alice, "POST", `${a.base}/documents/uploads`, { workspace_id: a.ws, filename: "a.md", content_type: "text/markdown", size_bytes: 5, folder_id: folderId });
    expect((await up(randomUUID())).statusCode).toBe(400);
    expect((await up(foreign.id)).statusCode).toBe(400);
    expect((await call(a.alice, "GET", `${a.base}/folders?workspace_id=${a.ws}`)).json().folders).toEqual([]);
    expect((await call(a.alice, "PATCH", `${a.base}/folders/${foreign.id}`, { name: "x" })).statusCode).toBe(404);
  });
});

describe("sugerencia de carpeta", () => {
  it("sugiere por contenido parecido, por nombre, o nada", async () => {
    const { folder, indexed, suggestions, move } = await setup("suggest");
    const legal = (await folder("Legal")).json();
    const viajes = (await folder("Viajes")).json();
    await indexed("Contrato de arrendamiento", { 1: 1, 2: 0.2 }, { folder: legal.id });
    await indexed("Contrato de servicios", { 1: 1, 3: 0.2 }, { folder: legal.id });
    await indexed("Política de viáticos", { 10: 1 }, { folder: viajes.id });
    (await folder("Nómina")).json(); // vacía: solo puede sugerirse por nombre

    const otrosi = await indexed("Otrosí al contrato marco", { 1: 1, 4: 0.3 });
    const nomina = await indexed("Liquidación mensual", { 50: 1 }, { text: "Pago de nómina del mes de marzo y aportes." });
    const suelto = await indexed("Receta de cocina", { 90: 1 });

    const s = await suggestions();
    const of = (id: string) => s.find((x) => x.document_id === id);
    expect(of(otrosi.id)).toMatchObject({ folder_id: legal.id, folder_name: "Legal", reason: "similar_content" });
    expect(of(otrosi.id)!.score).toBeGreaterThan(0.9);
    expect(of(nomina.id)).toMatchObject({ folder_name: "Nómina", reason: "name_match" });
    expect(of(suelto.id)).toBeUndefined();

    // Aceptar la sugerencia = mover; el documento deja de aparecer.
    await move([otrosi.id], legal.id);
    expect((await suggestions()).find((x) => x.document_id === otrosi.id)).toBeUndefined();
  });

  it("una carpeta con un solo documento necesita más parecido", async () => {
    const { folder, indexed, suggestions } = await setup("single");
    const f = (await folder("Informes")).json();
    await indexed("Informe anual", { 1: 1 }, { folder: f.id });
    const medio = await indexed("Resumen trimestral", { 1: 1, 2: 1.6 }); // coseno ≈ 0.53
    const casi = await indexed("Informe semestral", { 1: 1, 2: 0.3 }); // coseno ≈ 0.96
    const s = await suggestions();
    expect(s.find((x) => x.document_id === medio.id)).toBeUndefined();
    expect(s.find((x) => x.document_id === casi.id)).toMatchObject({ folder_id: f.id, reason: "similar_content" });
  });

  it("lo que alguien no puede leer no influye en lo que se le sugiere", async () => {
    const { alice, bob, aliceId, folder, indexed, suggestions } = await setup("acl");
    const f = (await folder("Junta")).json();
    await indexed("Acta reservada 1", { 7: 1 }, { folder: f.id, acl: [`user:${aliceId}`] });
    await indexed("Acta reservada 2", { 7: 1, 8: 0.1 }, { folder: f.id, acl: [`user:${aliceId}`] });
    const nuevo = await indexed("Borrador de decisiones", { 7: 1, 9: 0.1 });
    expect((await suggestions(alice)).find((x) => x.document_id === nuevo.id)).toMatchObject({ folder_id: f.id });
    expect(await suggestions(bob)).toEqual([]);
  });

  it("descartar la sugerencia deja de mostrarla; solo quien puede editar la descarta", async () => {
    const { alice, bob, base, folder, indexed, suggestions } = await setup("dismiss");
    const f = (await folder("Legal")).json();
    await indexed("Contrato A", { 1: 1 }, { folder: f.id });
    await indexed("Contrato B", { 1: 1, 2: 0.1 }, { folder: f.id });
    const doc = await indexed("Contrato C", { 1: 1, 3: 0.1 });
    expect(await suggestions()).toHaveLength(1);
    const url = `${base}/documents/${doc.id}/folder-suggestion/dismiss`;
    expect((await call(bob, "POST", url)).statusCode).toBe(403);
    expect((await call(alice, "POST", url)).statusCode).toBe(204);
    expect(await suggestions()).toEqual([]);
  });
});

describe("audio", () => {
  it("acepta grabaciones y sirve la transcripción por tramos solo a quien puede ver el documento", async () => {
    const { alice, bob, aliceId, base, ws, indexed } = await setup("audio");
    const start = await call(alice, "POST", `${base}/documents/uploads`, { workspace_id: ws, filename: "reunion.mp3", content_type: "audio/mpeg", size_bytes: 1000 });
    expect(start.statusCode).toBe(201);
    expect((await call(alice, "POST", `${base}/documents/uploads`, { workspace_id: ws, filename: "clip.mp4", content_type: "video/mp4", size_bytes: 1000 })).statusCode).toBe(400);

    const rec = await indexed("Llamada con el cliente", { 5: 1 }, { contentType: "audio/wav", filename: "llamada.wav", acl: [`user:${aliceId}`] });
    await owner.query("UPDATE document_versions SET duration_seconds=95.5, transcription_language='es-US' WHERE id=$1", [rec.version]);
    await owner.query(`UPDATE chunks SET kind='audio', text='[00:00] Hablante 1: Buenos días.', meta='{"t_start":0,"t_end":41.2,"speakers":["Hablante 1"]}' WHERE id=$1`, [rec.chunk]);
    const second = randomUUID();
    await owner.query(
      `INSERT INTO chunks (id, organization_id, workspace_id, document_id, version_id, ordinal, kind, text, token_count, index_state, meta)
       SELECT $1, organization_id, workspace_id, document_id, version_id, 1, 'audio', '[00:42] Hablante 2: Gracias.', 5, 'active', '{"t_start":42,"t_end":95.5}'
         FROM chunks WHERE id=$2`,
      [second, rec.chunk],
    );

    const url = `${base}/documents/${rec.id}/versions/${rec.version}/transcript`;
    const tr = (await call(alice, "GET", url)).json();
    expect(tr).toMatchObject({ duration_seconds: 95.5, language: "es-US" });
    expect(tr.segments).toEqual([
      { chunk_id: rec.chunk, text: "[00:00] Hablante 1: Buenos días.", t_start: 0, t_end: 41.2, speakers: ["Hablante 1"] },
      { chunk_id: second, text: "[00:42] Hablante 2: Gracias.", t_start: 42, t_end: 95.5, speakers: [] },
    ]);
    expect((await call(bob, "GET", url)).statusCode).toBe(404);

    const listed = (await call(alice, "GET", `${base}/documents?workspace_id=${ws}`)).json().documents.find((d: { id: string }) => d.id === rec.id);
    expect(listed).toMatchObject({ content_type: "audio/wav", duration_seconds: 95.5, folder_id: null });
  });
});
