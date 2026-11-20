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
import type { MemberInvite } from "../src/lib/member-email.js";

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
const sentInvites: MemberInvite[] = [];

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
  app = await buildApp({ cfg, pool, storage, queue, rag, memberMailer: async (invite) => void sentInvites.push(invite) });
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

describe("invitaciones por correo", () => {
  it("quien nunca entró queda invitado y se une al primer inicio de sesión; revocar y permisos", async () => {
    const owner = await login("paula@invita.test");
    const org = (await call(owner, "POST", "/v1/organizations", { name: "Despacho Invita" })).json().id;

    // Nunca inició sesión: invitación (202), correo en el idioma de quien invita, y aparece como pendiente.
    const inv = await call(owner, "POST", `/v1/organizations/${org}/members`, { email: "Nuevo.Asociado@Invita.test", role: "viewer", locale: "es" });
    expect(inv.statusCode, inv.body).toBe(202);
    expect(inv.json()).toMatchObject({ status: "invited", email: "nuevo.asociado@invita.test", role: "viewer", email_sent: true });
    expect(sentInvites.at(-1)).toMatchObject({ to: "nuevo.asociado@invita.test", organization: "Despacho Invita", locale: "es" });
    expect(sentInvites.at(-1)!.signInUrl).toMatch(/\/es\/login$/);
    let pending = (await call(owner, "GET", `/v1/organizations/${org}/invitations`)).json().invitations;
    expect(pending.map((i: { email: string }) => i.email)).toEqual(["nuevo.asociado@invita.test"]);
    // Invitar otra vez actualiza la misma invitación (una abierta por dirección).
    await call(owner, "POST", `/v1/organizations/${org}/members`, { email: "nuevo.asociado@invita.test", role: "member" });
    pending = (await call(owner, "GET", `/v1/organizations/${org}/invitations`)).json().invitations;
    expect(pending).toHaveLength(1);
    expect(pending[0].role).toBe("member");

    // Primer inicio de sesión con esa dirección: ya es miembro con el rol elegido y la invitación se cierra.
    const nuevo = await login("nuevo.asociado@invita.test");
    const me = (await call(nuevo, "GET", "/v1/me")).json();
    expect(me.organizations.find((o: { id: string }) => o.id === org)?.role).toBe("member");
    expect((await call(owner, "GET", `/v1/organizations/${org}/invitations`)).json().invitations).toHaveLength(0);
    const audit = (await call(owner, "GET", `/v1/organizations/${org}/audit`)).json().events.map((e: { action: string }) => e.action);
    expect(audit).toEqual(expect.arrayContaining(["member.invited", "member.invitation_accepted"]));
    // Un miembro que no es admin no ve ni revoca invitaciones.
    expect((await call(nuevo, "GET", `/v1/organizations/${org}/invitations`)).statusCode).toBe(403);

    // Revocada antes de entrar: no da acceso.
    const rev = (await call(owner, "POST", `/v1/organizations/${org}/members`, { email: "revocada@invita.test" })).json();
    expect((await call(owner, "DELETE", `/v1/organizations/${org}/invitations/${rev.invitation_id}`)).statusCode).toBe(204);
    expect((await call(owner, "DELETE", `/v1/organizations/${org}/invitations/${rev.invitation_id}`)).statusCode).toBe(404);
    const revocada = await login("revocada@invita.test");
    expect((await call(revocada, "GET", "/v1/me")).json().organizations.map((o: { id: string }) => o.id)).not.toContain(org);
    expect((await call(revocada, "GET", `/v1/organizations/${org}`)).statusCode).toBe(404);

    // Quien ya inició sesión alguna vez entra al momento (201 con user_id), como antes.
    const added = await call(owner, "POST", `/v1/organizations/${org}/members`, { email: "revocada@invita.test", role: "viewer" });
    expect(added.statusCode).toBe(201);
    expect(added.json()).toMatchObject({ status: "added", role: "viewer" });
  });
});

describe("quitar y suspender miembros", () => {
  // dev-login only issues a token; the user row exists after the first authenticated request.
  const signedIn = async (email: string) => {
    const token = await login(email);
    await call(token, "GET", "/v1/me");
    return token;
  };

  it("suspender corta el acceso al momento y reactivar lo devuelve con los mismos permisos", async () => {
    const owner = await signedIn("olga@salida.test");
    const org = (await call(owner, "POST", "/v1/organizations", { name: "Despacho Salida" })).json().id;
    const ws = (await call(owner, "GET", `/v1/organizations/${org}/workspaces`)).json().workspaces[0].id;
    const asociado = await signedIn("asociado@salida.test");
    const asociadoId = (await call(owner, "POST", `/v1/organizations/${org}/members`, { email: "asociado@salida.test", role: "member" })).json().user_id;
    await call(owner, "POST", `/v1/organizations/${org}/workspaces/${ws}/members`, { user_id: asociadoId, role: "editor" });
    expect((await call(asociado, "GET", `/v1/organizations/${org}`)).statusCode).toBe(200);

    const sus = await call(owner, "PATCH", `/v1/organizations/${org}/members/${asociadoId}`, { status: "disabled" });
    expect(sus.statusCode, sus.body).toBe(200);
    expect(sus.json()).toEqual({ id: asociadoId, role: "member", status: "disabled" });
    expect((await call(asociado, "GET", `/v1/organizations/${org}`)).statusCode).toBe(404);
    expect((await call(asociado, "GET", `/v1/organizations/${org}/workspaces`)).statusCode).toBe(404);
    expect((await call(asociado, "GET", "/v1/me")).json().organizations.map((o: { id: string }) => o.id)).not.toContain(org);
    const listed = (await call(owner, "GET", `/v1/organizations/${org}/members`)).json().members;
    expect(listed.find((m: { id: string }) => m.id === asociadoId)?.status).toBe("disabled");

    expect((await call(owner, "PATCH", `/v1/organizations/${org}/members/${asociadoId}`, { status: "active" })).statusCode).toBe(200);
    const back = (await call(asociado, "GET", `/v1/organizations/${org}/workspaces`)).json().workspaces;
    expect(back.find((w: { id: string }) => w.id === ws)?.my_role).toBe("editor");
    expect((await call(owner, "PATCH", `/v1/organizations/${org}/members/${asociadoId}`, { status: "removed" })).statusCode).toBe(400);

    const audit = (await call(owner, "GET", `/v1/organizations/${org}/audit`)).json().events;
    const suspended = audit.find((e: { action: string }) => e.action === "member.suspended");
    expect(suspended).toMatchObject({ resource: `user:${asociadoId}`, decision: "allow" });
    expect(suspended.metadata).toMatchObject({ email: "asociado@salida.test", role: "member", from: "active" });
    expect(audit.map((e: { action: string }) => e.action)).toContain("member.reactivated");
  });

  it("quitar a alguien le quita la organización, espacios, grupos y roles; sus documentos se quedan", async () => {
    const owner = await signedIn("rosa@salida.test");
    const org = (await call(owner, "POST", "/v1/organizations", { name: "Despacho Rosa" })).json().id;
    const ws = (await call(owner, "GET", `/v1/organizations/${org}/workspaces`)).json().workspaces[0].id;
    const ex = await signedIn("ex.asociado@salida.test");
    const exId = (await call(owner, "POST", `/v1/organizations/${org}/members`, { email: "ex.asociado@salida.test", role: "member" })).json().user_id;
    await call(owner, "POST", `/v1/organizations/${org}/workspaces/${ws}/members`, { user_id: exId, role: "editor" });
    const group = (await call(owner, "POST", `/v1/organizations/${org}/groups`, { name: "Litigio" })).json().id;
    await call(owner, "POST", `/v1/organizations/${org}/groups/${group}/members`, { user_id: exId });
    const admin = new pg.Client({ connectionString: `postgres://ragsis_owner:${env.POSTGRES_PASSWORD}@127.0.0.1:${PORT}/${DB}` });
    await admin.connect();
    try {
      await admin.query("INSERT INTO functional_roles (organization_id, user_id, role) VALUES ($1, $2, 'reviewer')", [org, exId]);
      // A document they uploaded belongs to the firm and must survive the removal.
      const up = await call(ex, "POST", `/v1/organizations/${org}/documents/uploads`, {
        workspace_id: ws, filename: "demanda.md", content_type: "text/markdown", size_bytes: 100, title: "Demanda",
      });
      expect(up.statusCode, up.body).toBe(201);
      const docId = up.json().document_id as string;
      // A stale invitation to the same address must not bring them back.
      await admin.query(
        "INSERT INTO member_invitations (id, organization_id, email, role, invited_by) VALUES ($1, $2, 'ex.asociado@salida.test', 'member', $3)",
        [randomUUID(), org, exId],
      );

      const del = await call(owner, "DELETE", `/v1/organizations/${org}/members/${exId}`);
      expect(del.statusCode, del.body).toBe(204);
      expect((await call(ex, "GET", `/v1/organizations/${org}`)).statusCode).toBe(404);
      expect((await call(ex, "GET", `/v1/organizations/${org}/documents`)).statusCode).toBe(404);
      expect((await call(owner, "GET", `/v1/organizations/${org}/members`)).json().members.map((m: { id: string }) => m.id)).not.toContain(exId);
      expect((await call(owner, "DELETE", `/v1/organizations/${org}/members/${exId}`)).statusCode).toBe(404);

      const left = async (table: string) => (await admin.query(`SELECT count(*)::int AS n FROM ${table} WHERE organization_id = $1 AND user_id = $2`, [org, exId])).rows[0].n;
      expect(await left("memberships")).toBe(0);
      expect(await left("workspace_members")).toBe(0);
      expect(await left("group_members")).toBe(0);
      expect(await left("functional_roles")).toBe(0);
      expect((await admin.query("SELECT count(*)::int AS n FROM documents WHERE id = $1", [docId])).rows[0].n).toBe(1);
      expect(
        (await admin.query("SELECT count(*)::int AS n FROM member_invitations WHERE organization_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL", [org])).rows[0].n,
      ).toBe(0);

      const removed = (await call(owner, "GET", `/v1/organizations/${org}/audit`)).json().events.find((e: { action: string }) => e.action === "member.removed");
      expect(removed).toMatchObject({ resource: `user:${exId}`, decision: "allow" });
      expect(removed.metadata).toMatchObject({
        email: "ex.asociado@salida.test", role: "member", workspaces: [ws], groups: [group], functional_roles: ["reviewer"], invitations_revoked: 1,
      });
      // Signing in again does not rejoin them.
      const again = await signedIn("ex.asociado@salida.test");
      expect((await call(again, "GET", "/v1/me")).json().organizations.map((o: { id: string }) => o.id)).not.toContain(org);
    } finally {
      await admin.end();
    }
  });

  it("protege a los owners: un admin no los toca y el último owner no se quita, suspende ni degrada", async () => {
    const owner = await signedIn("dueno@salida.test");
    const org = (await call(owner, "POST", "/v1/organizations", { name: "Despacho Dueño" })).json().id;
    const ownerId = (await call(owner, "GET", "/v1/me")).json().user.id;
    const adm = await signedIn("admin@salida.test");
    const admId = (await call(owner, "POST", `/v1/organizations/${org}/members`, { email: "admin@salida.test", role: "admin" })).json().user_id;
    const socio = await signedIn("socio@salida.test");
    const socioId = (await call(owner, "POST", `/v1/organizations/${org}/members`, { email: "socio@salida.test", role: "member" })).json().user_id;
    const miembro = await signedIn("miembro@salida.test");
    const miembroId = (await call(owner, "POST", `/v1/organizations/${org}/members`, { email: "miembro@salida.test", role: "member" })).json().user_id;

    // Only admins remove or suspend; a member gets 403.
    expect((await call(miembro, "DELETE", `/v1/organizations/${org}/members/${socioId}`)).statusCode).toBe(403);
    expect((await call(miembro, "PATCH", `/v1/organizations/${org}/members/${socioId}`, { status: "disabled" })).statusCode).toBe(403);
    // Nobody removes or suspends themselves from here.
    expect((await call(owner, "DELETE", `/v1/organizations/${org}/members/${ownerId}`)).statusCode).toBe(400);
    expect((await call(adm, "PATCH", `/v1/organizations/${org}/members/${admId}`, { status: "disabled" })).statusCode).toBe(400);
    // Unknown member: 404.
    expect((await call(owner, "DELETE", `/v1/organizations/${org}/members/${randomUUID()}`)).statusCode).toBe(404);

    // An admin can't remove, suspend or demote an owner.
    expect((await call(adm, "DELETE", `/v1/organizations/${org}/members/${ownerId}`)).statusCode).toBe(403);
    expect((await call(adm, "PATCH", `/v1/organizations/${org}/members/${ownerId}`, { status: "disabled" })).statusCode).toBe(403);
    expect((await call(adm, "POST", `/v1/organizations/${org}/members`, { email: "dueno@salida.test", role: "viewer" })).statusCode).toBe(403);
    // The last owner can't demote themselves either.
    expect((await call(owner, "POST", `/v1/organizations/${org}/members`, { email: "dueno@salida.test", role: "admin" })).statusCode).toBe(409);
    // An admin can remove another member.
    expect((await call(adm, "DELETE", `/v1/organizations/${org}/members/${miembroId}`)).statusCode).toBe(204);

    // With a second owner, one owner can suspend or remove the other, but never the last active one.
    const admin = new pg.Client({ connectionString: `postgres://ragsis_owner:${env.POSTGRES_PASSWORD}@127.0.0.1:${PORT}/${DB}` });
    await admin.connect();
    try {
      await admin.query("UPDATE memberships SET role = 'owner' WHERE organization_id = $1 AND user_id = $2", [org, socioId]);
    } finally {
      await admin.end();
    }
    expect((await call(owner, "PATCH", `/v1/organizations/${org}/members/${socioId}`, { status: "disabled" })).statusCode).toBe(200);
    // socio is a suspended owner now: removing them leaves `owner` as the active owner, so it is allowed.
    expect((await call(owner, "DELETE", `/v1/organizations/${org}/members/${socioId}`)).statusCode).toBe(204);
    expect((await call(socio, "GET", `/v1/organizations/${org}`)).statusCode).toBe(404);
    const members = (await call(owner, "GET", `/v1/organizations/${org}/members`)).json().members;
    expect(members.filter((m: { role: string; status: string }) => m.role === "owner" && m.status === "active").map((m: { id: string }) => m.id)).toEqual([ownerId]);

    const actions = (await call(owner, "GET", `/v1/organizations/${org}/audit`)).json().events.map((e: { action: string }) => e.action);
    expect(actions.filter((a: string) => a === "member.removed")).toHaveLength(2);
    expect(actions).toContain("member.suspended");
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

  it("«Solo IA privada» (o «En tus servidores») firma `lo` para que Preguntar no use modelos en la nube", async () => {
    const own = await login("private-ai@corp.test");
    const o = (await call(own, "POST", "/v1/organizations", { name: "Private AI Corp" })).json();
    const url = `/v1/organizations/${o.id}/workspaces/${o.default_workspace_id}/query`;
    const profile = (body: object) => call(own, "PUT", `/v1/organizations/${o.id}/onboarding/profile`, body);
    const ask = async () => {
      expect((await call(own, "POST", url, { question: "¿Cuál es el plazo?" })).statusCode).toBe(200);
      return rag.lastClaims?.lo;
    };

    expect(await ask()).toBeUndefined();
    expect((await profile({ llm_policy: "local_only" })).statusCode).toBe(200);
    expect(await ask()).toBe(true);
    expect((await profile({ llm_policy: "cloud_allowed" })).statusCode).toBe(200);
    expect(await ask()).toBeUndefined();
    // «Runs on your own infrastructure. Nothing leaves it.»: la misma regla que ya usan los agentes.
    expect((await profile({ deployment_preference: "on_prem" })).statusCode).toBe(200);
    expect(await ask()).toBe(true);
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
