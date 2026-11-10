import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { jwtVerify } from "jose";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createPool } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import type { Queue, Storage } from "../src/lib/aws.js";
import type { RagClient } from "../src/routes/query.js";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const env = Object.fromEntries(
  readFileSync(path.join(ROOT, ".env"), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const PORT = process.env.POSTGRES_HOST_PORT ?? "55432";
const DB = "ragsis_api_test";
const SECRET = "api-test-internal-secret-0123456789abcdef";

class FakeStorage implements Storage {
  objects = new Map<string, number>();
  async presignPut(key: string) {
    return `http://s3.local/${key}?sig=1`;
  }
  async presignGet(key: string) {
    return `http://s3.local/${key}?get=1`;
  }
  async head(key: string) {
    const size = this.objects.get(key);
    return size === undefined ? null : { size };
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  async put(key: string, body: Buffer) {
    this.objects.set(key, body.length);
  }
  async get() {
    return null;
  }
}

class FakeQueue implements Queue {
  messages: Record<string, unknown>[] = [];
  async send(body: Record<string, unknown>) {
    this.messages.push(body);
  }
}

class FakeRag implements RagClient {
  lastClaims: Record<string, unknown> | null = null;
  async query(token: string, body: Record<string, unknown>) {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(SECRET), { audience: "ragsis-rag", issuer: "ragsis-api" });
    this.lastClaims = payload as Record<string, unknown>;
    return { status: 200, body: { trace_id: "qry_" + "0".repeat(24), answer: `eco: ${body.question}`, abstained: false, citations: [] } };
  }
}

let app: FastifyInstance;
let pool: pg.Pool;
const storage = new FakeStorage();
const queue = new FakeQueue();
const rag = new FakeRag();

async function login(email: string): Promise<string> {
  const r = await app.inject({ method: "POST", url: "/v1/auth/dev-login", payload: { email } });
  expect(r.statusCode).toBe(200);
  return r.json().token;
}

const call = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as "GET", url, payload: payload as object, headers: { authorization: `Bearer ${token}` } });

async function workspaceHasDocuments(token: string, org: string, ws: string) {
  const result = await call(token, "GET", `/v1/organizations/${org}/workspaces`);
  expect(result.statusCode).toBe(200);
  return result.json().workspaces.find((workspace: { id: string }) => workspace.id === ws)?.has_documents;
}

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: `postgres://ragsis_owner:${env.POSTGRES_PASSWORD}@127.0.0.1:${PORT}/ragsis` });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${DB}`);
  await admin.end();
  await migrate(`postgres://ragsis_owner:${env.POSTGRES_PASSWORD}@127.0.0.1:${PORT}/${DB}`, path.join(ROOT, "db/migrations"));
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
});

describe("auth y tenancy", () => {
  it("rechaza sin token y con token inválido", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/me" })).statusCode).toBe(401);
    expect((await call("garbage", "GET", "/v1/me")).statusCode).toBe(401);
  });

  it("crea organización y la resuelve solo por membresía", async () => {
    const alice = await login("alice@acme.test");
    const bob = await login("bob@globex.test");
    const org = await call(alice, "POST", "/v1/organizations", { name: "ACME Legal" });
    expect(org.statusCode).toBe(201);
    const { id } = org.json();
    const me = await call(alice, "GET", "/v1/me");
    expect(me.json().organizations.map((o: { id: string }) => o.id)).toContain(id);
    // Bob no es miembro: 404 (no se revela existencia).
    expect((await call(bob, "GET", `/v1/organizations/${id}`)).statusCode).toBe(404);
    expect((await call(bob, "GET", `/v1/organizations/${id}/workspaces`)).statusCode).toBe(404);
    expect((await call(bob, "GET", `/v1/organizations/not-a-uuid`)).statusCode).toBe(404);
  });
});

describe("documentos", () => {
  let token: string;
  let org: string;
  let ws: string;

  beforeAll(async () => {
    token = await login("carla@firm.test");
    const r = (await call(token, "POST", "/v1/organizations", { name: "Firma" })).json();
    org = r.id;
    ws = r.default_workspace_id;
  });

  it("upload prefirmado → complete → job en SQS con solo IDs; idempotente", async () => {
    expect(await workspaceHasDocuments(token, org, ws)).toBe(false);
    const start = await call(token, "POST", `/v1/organizations/${org}/documents/uploads`, {
      workspace_id: ws,
      filename: "politica.md",
      content_type: "text/markdown",
      size_bytes: 120,
      title: "Política",
    });
    expect(start.statusCode).toBe(201);
    const s = start.json();
    expect(s.upload.url).toContain(`tenants/${org}/raw/${s.document_id}/${s.version_id}/`);
    const completeUrl = `/v1/organizations/${org}/documents/${s.document_id}/versions/${s.version_id}/complete`;
    expect((await call(token, "POST", completeUrl)).statusCode).toBe(400); // objeto aún no subido
    storage.objects.set(new URL(s.upload.url).pathname.slice(1), 120);
    const done = await call(token, "POST", completeUrl);
    expect(done.statusCode).toBe(202);
    const msg = queue.messages.at(-1)!;
    expect(Object.keys(msg).sort()).toEqual(["document_id", "job_id", "kind", "organization_id", "v", "version_id"]);
    expect(msg.organization_id).toBe(org);
    const again = await call(token, "POST", completeUrl);
    expect(again.statusCode).toBe(202);
    expect(again.json().job_id).toBe(done.json().job_id);
    expect(queue.messages.filter((m) => m.version_id === s.version_id)).toHaveLength(1);

    const list = await call(token, "GET", `/v1/organizations/${org}/documents?workspace_id=${ws}`);
    expect(list.json().documents[0].latest_status).toBe("uploaded");
    expect(await workspaceHasDocuments(token, org, ws)).toBe(true);
  });

  it("rechaza tipos no permitidos, tamaños sobre el plan y tamaño subido distinto", async () => {
    const bad = await call(token, "POST", `/v1/organizations/${org}/documents/uploads`, {
      workspace_id: ws, filename: "x.exe", content_type: "application/x-msdownload", size_bytes: 10,
    });
    expect(bad.statusCode).toBe(400);
    const big = await call(token, "POST", `/v1/organizations/${org}/documents/uploads`, {
      workspace_id: ws, filename: "big.pdf", content_type: "application/pdf", size_bytes: 10 * 1024 * 1024 * 1024,
    });
    expect(big.statusCode).toBe(400);
    const s = (await call(token, "POST", `/v1/organizations/${org}/documents/uploads`, {
      workspace_id: ws, filename: "a.txt", content_type: "text/plain", size_bytes: 50,
    })).json();
    storage.objects.set(new URL(s.upload.url).pathname.slice(1), 999);
    const r = await call(token, "POST", `/v1/organizations/${org}/documents/${s.document_id}/versions/${s.version_id}/complete`);
    expect(r.statusCode).toBe(400);
  });

  it("ACL por grupo oculta el documento a miembros fuera del grupo; viewer no sube", async () => {
    const dan = await login("dan@firm.test");
    await call(dan, "GET", "/v1/me"); // primer login crea el usuario
    const add = await call(token, "POST", `/v1/organizations/${org}/members`, { email: "dan@firm.test", role: "viewer" });
    expect(add.statusCode).toBe(201);
    const danId = add.json().user_id;
    const restrictedWs = (await call(token, "POST", `/v1/organizations/${org}/workspaces`, { name: "Archivo de socios" })).json().id;
    expect((await call(token, "POST", `/v1/organizations/${org}/workspaces/${restrictedWs}/members`, { user_id: danId, role: "reader" })).statusCode).toBe(204);
    const group = (await call(token, "POST", `/v1/organizations/${org}/groups`, { name: "Socios" })).json().id;
    const secret = (await call(token, "POST", `/v1/organizations/${org}/documents/uploads`, {
      workspace_id: restrictedWs, filename: "socios.md", content_type: "text/markdown", size_bytes: 10, title: "Acta de socios",
      acl: [`group:${group}`],
    })).json();
    const titles = async () =>
      (await call(dan, "GET", `/v1/organizations/${org}/documents?workspace_id=${restrictedWs}`)).json().documents.map((d: { title: string }) => d.title);
    expect(await titles()).not.toContain("Acta de socios");
    expect(await workspaceHasDocuments(dan, org, restrictedWs)).toBe(false);
    expect((await call(dan, "GET", `/v1/organizations/${org}/documents/${secret.document_id}/status`)).statusCode).toBe(404);
    const up = await call(dan, "POST", `/v1/organizations/${org}/documents/uploads`, {
      workspace_id: restrictedWs, filename: "x.md", content_type: "text/markdown", size_bytes: 10,
    });
    expect(up.statusCode).toBe(403);
    expect((await call(dan, "GET", `/v1/organizations/${org}/members`)).statusCode).toBe(403);
    // Al agregarlo al grupo, lo ve.
    await call(token, "POST", `/v1/organizations/${org}/groups/${group}/members`, { user_id: danId });
    expect(await titles()).toContain("Acta de socios");
    expect(await workspaceHasDocuments(dan, org, restrictedWs)).toBe(true);
  });

  it("acepta PPTX, XLSX e imágenes", async () => {
    for (const [filename, content_type] of [
      ["deck.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
      ["datos.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
      ["plano.png", "image/png"],
      ["foto.jpg", "image/jpeg"],
    ]) {
      const r = await call(token, "POST", `/v1/organizations/${org}/documents/uploads`, { workspace_id: ws, filename, content_type, size_bytes: 10 });
      expect(r.statusCode, filename).toBe(201);
    }
  });

  it("URL firmada de figura citada: respeta ACL del documento y el prefijo del tenant", async () => {
    const owner = new pg.Client({ connectionString: `postgres://ragsis_owner:${env.POSTGRES_PASSWORD}@127.0.0.1:${PORT}/${DB}` });
    await owner.connect();
    try {
      const eve = await login("eve@firm.test");
      await call(eve, "GET", "/v1/me");
      const eveId = (await call(token, "POST", `/v1/organizations/${org}/members`, { email: "eve@firm.test", role: "viewer" })).json().user_id;
      await call(token, "POST", `/v1/organizations/${org}/workspaces/${ws}/members`, { user_id: eveId, role: "reader" });
      const group = (await call(token, "POST", `/v1/organizations/${org}/groups`, { name: "Dirección" })).json().id;
      const s = (await call(token, "POST", `/v1/organizations/${org}/documents/uploads`, {
        workspace_id: ws, filename: "informe.pptx", content_type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        size_bytes: 10, title: "Informe de dirección", acl: [`group:${group}`],
      })).json();
      const chunkId = randomUUID();
      const key = `tenants/${org}/assets/${s.document_id}/${s.version_id}/abc.png`;
      await owner.query("UPDATE document_versions SET status='indexed', is_current=true WHERE id=$1", [s.version_id]);
      await owner.query(
        `INSERT INTO chunks (id, organization_id, workspace_id, document_id, version_id, ordinal, kind, text, token_count,
                             index_state, asset_key, bbox, meta)
         VALUES ($1,$2,$3,$4,$5,0,'figure','Figura 1: ventas',3,'active',$6,'{0.1,0.1,0.5,0.6}','{"mime":"image/png"}')`,
        [chunkId, org, ws, s.document_id, s.version_id, key],
      );
      const url = `/v1/organizations/${org}/chunks/${chunkId}/asset`;
      // Fuera del grupo del documento: el fragmento no existe para Eve.
      expect((await call(eve, "GET", url)).statusCode).toBe(404);
      await call(token, "POST", `/v1/organizations/${org}/groups/${group}/members`, { user_id: eveId });
      const ok = await call(eve, "GET", url);
      expect(ok.statusCode).toBe(200);
      expect(ok.json().url).toContain(key);
      // Otro tenant: 404 por membresía.
      const mallory = await login("mallory@other.test");
      expect((await call(mallory, "GET", url)).statusCode).toBe(404);
      expect((await call(eve, "GET", `/v1/organizations/${org}/chunks/not-a-uuid/asset`)).statusCode).toBe(404);
      // La BD impide apuntar un activo fuera del prefijo del tenant.
      await expect(
        owner.query("UPDATE chunks SET asset_key=$2 WHERE id=$1", [chunkId, `tenants/${randomUUID()}/assets/x.png`]),
      ).rejects.toThrow(/chunks_asset_in_tenant/);
    } finally {
      await owner.end();
    }
  });

  it("borrado: invisible al instante y job de purga encolado", async () => {
    const s = (await call(token, "POST", `/v1/organizations/${org}/documents/uploads`, {
      workspace_id: ws, filename: "borrar.md", content_type: "text/markdown", size_bytes: 10, title: "Para borrar",
    })).json();
    const del = await call(token, "DELETE", `/v1/organizations/${org}/documents/${s.document_id}`);
    expect(del.statusCode).toBe(202);
    expect(queue.messages.at(-1)).toMatchObject({ kind: "delete", document_id: s.document_id });
    const list = (await call(token, "GET", `/v1/organizations/${org}/documents?workspace_id=${ws}`)).json();
    expect(list.documents.map((d: { id: string }) => d.id)).not.toContain(s.document_id);
  });
});

describe("consulta", () => {
  it("emite token interno con tenant y principals resueltos en servidor", async () => {
    const eve = await login("eve@corp.test");
    const o = (await call(eve, "POST", "/v1/organizations", { name: "Corp" })).json();
    const r = await call(eve, "POST", `/v1/organizations/${o.id}/workspaces/${o.default_workspace_id}/query`, {
      question: "¿Cuál es el plazo?",
      organization_id: "00000000-0000-0000-0000-000000000000",
    });
    expect(r.statusCode).toBe(200);
    expect(rag.lastClaims?.org).toBe(o.id);
    expect(rag.lastClaims?.ws).toBe(o.default_workspace_id);
    expect(rag.lastClaims?.principals).toContain(`workspace:${o.default_workspace_id}`);
    expect((rag.lastClaims!.exp as number) - (rag.lastClaims!.iat as number)).toBeLessThanOrEqual(60);

    const mallory = await login("mallory@evil.test");
    const m = (await call(mallory, "POST", "/v1/organizations", { name: "Evil" })).json();
    // Workspace ajeno usando su propia org: 404.
    const x = await call(mallory, "POST", `/v1/organizations/${m.id}/workspaces/${o.default_workspace_id}/query`, { question: "hola" });
    expect(x.statusCode).toBe(404);
  });

  it("GraphRAG (RAG-05): override por organización solo para admin y claim `graph` firmado", async () => {
    const own = await login("graph-owner@corp.test");
    const o = (await call(own, "POST", "/v1/organizations", { name: "Graph Corp" })).json();
    const url = `/v1/organizations/${o.id}/workspaces/${o.default_workspace_id}/query`;
    // Plan team: grafo deshabilitado por defecto (ADR-005).
    expect((await call(own, "GET", `/v1/organizations/${o.id}`)).json()).toMatchObject({ graph_mode: "inherit", graph_enabled: false });
    expect((await call(own, "POST", url, { question: "¿quién aprueba?", mode: "local" })).statusCode).toBe(200);
    expect(rag.lastClaims?.graph).toBe(false);

    // Un miembro no admin no puede cambiarlo.
    const mem = await login("graph-member@corp.test");
    await call(mem, "GET", "/v1/me"); // primer login crea el usuario
    const added = await call(own, "POST", `/v1/organizations/${o.id}/members`, { email: "graph-member@corp.test", role: "member" });
    expect(added.statusCode, added.body).toBe(201);
    expect((await call(mem, "PATCH", `/v1/organizations/${o.id}/settings`, { graph_mode: "on" })).statusCode).toBe(403);
    // Valores inválidos o campos extra (p. ej. intentar cambiar el plan) se rechazan.
    expect((await call(own, "PATCH", `/v1/organizations/${o.id}/settings`, { graph_mode: "yes" })).statusCode).toBe(400);
    expect((await call(own, "PATCH", `/v1/organizations/${o.id}/settings`, { graph_mode: "on", plan_id: "private" })).statusCode).toBe(400);

    const ok = await call(own, "PATCH", `/v1/organizations/${o.id}/settings`, { graph_mode: "on" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ graph_mode: "on", graph_enabled: true });
    expect((await call(own, "POST", url, { question: "¿quién aprueba?" })).statusCode).toBe(200);
    expect(rag.lastClaims?.graph).toBe(true);
    // Modo inválido rechazado por la API.
    expect((await call(own, "POST", url, { question: "¿quién aprueba?", mode: "everything" })).statusCode).toBe(400);
  });

  it("aplica rate limit por plan", async () => {
    const u = await login("rate@corp.test");
    const o = (await call(u, "POST", "/v1/organizations", { name: "Rate" })).json();
    const url = `/v1/organizations/${o.id}/workspaces/${o.default_workspace_id}/query`;
    const codes: number[] = [];
    for (let i = 0; i < 32; i++) codes.push((await call(u, "POST", url, { question: `pregunta ${i}` })).statusCode);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
  });
});

describe("claves de servicio (API-01)", () => {
  it("scopes, alcance por workspace, aislamiento de tenant y revocación", async () => {
    const admin = await login("admin@keys.test");
    const o = (await call(admin, "POST", "/v1/organizations", { name: "Keys" })).json();
    const other = (await call(admin, "POST", `/v1/organizations/${o.id}/workspaces`, { name: "Privado" })).json();
    const created = await call(admin, "POST", `/v1/organizations/${o.id}/api-keys`, {
      name: "integración", scopes: ["query", "documents:read"], workspace_ids: [o.default_workspace_id],
    });
    expect(created.statusCode).toBe(201);
    const { token, id } = created.json();
    expect(token).toMatch(/^rsk_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
    const listed = (await call(admin, "GET", `/v1/organizations/${o.id}/api-keys`)).json().api_keys;
    expect(JSON.stringify(listed)).not.toContain(token.split("_")[2]);

    // Consulta permitida en su workspace, con principals del usuario de servicio.
    const q = await call(token, "POST", `/v1/organizations/${o.id}/workspaces/${o.default_workspace_id}/query`, { question: "hola mundo" });
    expect(q.statusCode).toBe(200);
    expect(rag.lastClaims?.principals).toEqual(expect.arrayContaining([`workspace:${o.default_workspace_id}`]));
    expect(rag.lastClaims?.principals).not.toContain(`workspace:${other.id}`);
    // Workspace fuera del alcance de la clave → 404.
    expect((await call(token, "POST", `/v1/organizations/${o.id}/workspaces/${other.id}/query`, { question: "hola" })).statusCode).toBe(404);
    // Sin scope de escritura.
    const up = await call(token, "POST", `/v1/organizations/${o.id}/documents/uploads`, {
      workspace_id: o.default_workspace_id, filename: "a.md", content_type: "text/markdown", size_bytes: 5,
    });
    expect(up.statusCode).toBe(403);
    // Rutas administrativas no aceptan claves.
    expect((await call(token, "GET", `/v1/organizations/${o.id}/members`)).statusCode).toBe(403);
    expect((await call(token, "POST", `/v1/organizations/${o.id}/api-keys`, { name: "x", scopes: ["query"], workspace_ids: [o.default_workspace_id] })).statusCode).toBe(403);
    // Otra organización: inexistente para la clave.
    const foreign = (await call(admin, "POST", "/v1/organizations", { name: "Otra" })).json();
    expect((await call(token, "GET", `/v1/organizations/${foreign.id}/documents?workspace_id=${foreign.default_workspace_id}`)).statusCode).toBe(404);
    // Clave alterada.
    expect((await call(token.slice(0, -1) + (token.endsWith("A") ? "B" : "A"), "POST", `/v1/organizations/${o.id}/workspaces/${o.default_workspace_id}/query`, { question: "x y" })).statusCode).toBe(401);
    // Revocación inmediata.
    expect((await call(admin, "DELETE", `/v1/organizations/${o.id}/api-keys/${id}`)).statusCode).toBe(204);
    expect((await call(token, "POST", `/v1/organizations/${o.id}/workspaces/${o.default_workspace_id}/query`, { question: "hola" })).statusCode).toBe(401);
  });

  it("clave con documents:write puede subir y queda auditada con api_key_id", async () => {
    const admin = await login("admin2@keys.test");
    const o = (await call(admin, "POST", "/v1/organizations", { name: "Keys2" })).json();
    const { token, id } = (await call(admin, "POST", `/v1/organizations/${o.id}/api-keys`, {
      name: "ingesta", scopes: ["documents:write"], workspace_ids: [o.default_workspace_id],
    })).json();
    const up = await call(token, "POST", `/v1/organizations/${o.id}/documents/uploads`, {
      workspace_id: o.default_workspace_id, filename: "a.md", content_type: "text/markdown", size_bytes: 5, title: "Desde clave",
    });
    expect(up.statusCode).toBe(201);
    const list = (await call(token, "GET", `/v1/organizations/${o.id}/documents?workspace_id=${o.default_workspace_id}`)).json();
    expect(list.documents.map((d: { title: string }) => d.title)).toContain("Desde clave");
    expect((await call(token, "POST", `/v1/organizations/${o.id}/workspaces/${o.default_workspace_id}/query`, { question: "hola" })).statusCode).toBe(403);
    const events = (await call(admin, "GET", `/v1/organizations/${o.id}/audit`)).json().events;
    expect(events.find((e: { action: string }) => e.action === "document.upload_started").metadata.api_key_id).toBe(id);
  });
});
