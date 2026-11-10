/**
 * CON-01 (ADR-025): conectores Gmail/Slack/ClickUp contra Postgres real (RLS) y APIs de proveedor emuladas.
 */
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
import { TokenCipher } from "../src/lib/connectors/crypto.js";
import {
  addGmailMessage,
  addSlackChannel,
  addSlackMessage,
  createFakeWorld,
  deleteGmailThread,
  fakeFetch,
  upsertClickUpDoc,
  upsertClickUpTask,
  type FakeWorld,
} from "../src/lib/connectors/fake-apis.js";
import { htmlToText, stripQuoted } from "../src/lib/connectors/render.js";
import type { RagClient } from "../src/routes/query.js";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const env = Object.fromEntries(
  readFileSync(path.join(ROOT, ".env"), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const PORT = process.env.POSTGRES_HOST_PORT ?? "55432";
const DB = "ragsis_connectors_test";
const OWNER_URL = `postgres://ragsis_owner:${env.POSTGRES_PASSWORD}@127.0.0.1:${PORT}`;

class MemStorage implements Storage {
  objects = new Map<string, Buffer>();
  async presignPut(key: string) {
    return `http://s3.local/${key}`;
  }
  async presignGet(key: string) {
    return `http://s3.local/${key}`;
  }
  async head(key: string) {
    const b = this.objects.get(key);
    return b ? { size: b.length } : null;
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  async put(key: string, body: Buffer) {
    this.objects.set(key, body);
  }
  async get(key: string) {
    return this.objects.get(key) ?? null;
  }
}
class MemQueue implements Queue {
  messages: Record<string, unknown>[] = [];
  async send(body: Record<string, unknown>) {
    this.messages.push(body);
  }
}
const rag: RagClient = { query: async () => ({ status: 200, body: {} }) };

let app: FastifyInstance;
let pool: pg.Pool;
let owner: pg.Client;
let world: FakeWorld;
const storage = new MemStorage();
const queue = new MemQueue();

let admin: string;
let member: string;
let memberId: string;
let org: string;
let ws: string;

const call = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as "GET", url, payload: payload as object, headers: { authorization: `Bearer ${token}` } });

async function login(email: string): Promise<string> {
  const r = await app.inject({ method: "POST", url: "/v1/auth/dev-login", payload: { email } });
  return r.json().token;
}

/** Ejecuta el planificador hasta que no quede trabajo inmediato (las pasadas con trabajo pendiente se reprograman a +5 s). */
async function drain(max = 30) {
  for (let i = 0; i < max; i++) {
    // Primera vuelta: "sincronizar ahora" todo lo activo; después solo lo que quedó con trabajo pendiente (+5 s).
    const r = await owner.query(
      `UPDATE connectors SET next_sync_at=now() WHERE status='active' AND ($1 OR next_sync_at < now() + interval '10 seconds') RETURNING id`,
      [i === 0],
    );
    if (!r.rowCount) return;
    await app.connectors.tick();
  }
  throw new Error("connector sync did not converge");
}

async function connect(token: string, provider: string, code = "ok") {
  const a = await call(token, "POST", `/v1/organizations/${org}/connectors/${provider}/authorize`, { workspace_id: ws });
  expect(a.statusCode).toBe(200);
  const url = new URL(a.json().authorize_url);
  const state = url.searchParams.get("state")!;
  const c = await call(token, "POST", "/v1/connectors/oauth/complete", { state, code });
  return { authorize: url, state, complete: c };
}

const docs = async (token: string) =>
  (await call(token, "GET", `/v1/organizations/${org}/documents?workspace_id=${ws}&limit=200`)).json().documents as { id: string; title: string; latest_status: string }[];

async function sourceRows(connectorId: string) {
  return (
    await owner.query(
      `SELECT d.id, d.title, d.status, d.classification, ci.source_id, ci.container, a.principal,
              (SELECT count(*)::int FROM document_versions v WHERE v.document_id = d.id) AS versions
         FROM connector_items ci JOIN documents d ON d.id = ci.document_id
         LEFT JOIN document_acl a ON a.document_id = d.id
        WHERE ci.connector_id = $1 ORDER BY ci.source_id`,
      [connectorId],
    )
  ).rows;
}

beforeAll(async () => {
  const a = new pg.Client({ connectionString: `${OWNER_URL}/ragsis` });
  await a.connect();
  await a.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await a.query(`CREATE DATABASE ${DB}`);
  await a.end();
  await migrate(`${OWNER_URL}/${DB}`, path.join(ROOT, "db/migrations"));
  owner = new pg.Client({ connectionString: `${OWNER_URL}/${DB}` });
  await owner.connect();
  const cfg = loadConfig({
    DATABASE_URL: `postgres://ragsis_app:${env.RAGSIS_APP_DB_PASSWORD}@127.0.0.1:${PORT}/${DB}`,
    INTERNAL_SERVICE_SECRET: "connectors-test-internal-secret-0123456789",
    AUTH_MODE: "dev",
    JWT_DEV_SECRET: "dev-secret-for-tests-0123456789abcdefghij",
    RAGSIS_ENV: "test",
    PUBLIC_BASE_URL: "https://app.ragsis.test",
    GOOGLE_CLIENT_ID: "google-client",
    GOOGLE_CLIENT_SECRET: "google-secret",
    SLACK_CLIENT_ID: "slack-client",
    SLACK_CLIENT_SECRET: "slack-secret",
    CLICKUP_CLIENT_ID: "clickup-client",
    CLICKUP_CLIENT_SECRET: "clickup-secret",
    CONNECTOR_SYNC_ENABLED: "false",
  });
  world = createFakeWorld();
  pool = createPool(cfg.DATABASE_URL);
  app = await buildApp({ cfg, pool, storage, queue, rag, connectorOptions: { world, fetch: fakeFetch(world), maxChangesPerRun: 3 } });

  admin = await login("admin@connectors.test");
  member = await login("member@connectors.test");
  await call(member, "GET", "/v1/me"); // el alta de usuario ocurre en la primera petición autenticada
  const o = (await call(admin, "POST", "/v1/organizations", { name: "Conectores SL" })).json();
  org = o.id;
  ws = o.default_workspace_id;
  memberId = (await call(admin, "POST", `/v1/organizations/${org}/members`, { email: "member@connectors.test", role: "member" })).json().user_id;
  expect((await call(admin, "POST", `/v1/organizations/${org}/workspaces/${ws}/members`, { user_id: memberId, role: "reader" })).statusCode).toBe(204);
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await owner?.end();
});

describe("utilidades", () => {
  it("cifra tokens con AAD ligado al conector", () => {
    const c = new TokenCipher({ INTERNAL_SERVICE_SECRET: "x".repeat(40), CONNECTOR_ENCRYPTION_KEY: undefined });
    const sealed = c.seal({ access_token: "secret-token" }, "org:conn-a");
    expect(sealed).not.toContain("secret-token");
    expect(c.open(sealed, "org:conn-a").access_token).toBe("secret-token");
    expect(() => c.open(sealed, "org:conn-b")).toThrow();
  });

  it("limpia HTML y texto citado de correos", () => {
    expect(htmlToText("<p>Hola&nbsp;<b>Ana</b></p><script>alert(1)</script><a href=\"https://x.test\">aquí</a>")).toBe("Hola Ana\naquí (https://x.test)");
    expect(stripQuoted("Gracias\n\nEl lun, 3 nov 2026 a las 10:00, Ana <a@x.test> escribió:\n> texto viejo")).toBe("Gracias");
  });
});

describe("catálogo y política", () => {
  it("lista proveedores disponibles y permitidos", async () => {
    const r = await call(member, "GET", `/v1/organizations/${org}/connectors`);
    expect(r.statusCode).toBe(200);
    expect(r.json().providers.map((p: { id: string; available: boolean; allowed: boolean }) => [p.id, p.available, p.allowed])).toEqual([
      ["gmail", true, true],
      ["slack", true, true],
      ["clickup", true, true],
    ]);
    expect(r.json().can_manage_company).toBe(false);
  });

  it("solo admins conectan apps de empresa o cambian la política", async () => {
    expect((await call(member, "POST", `/v1/organizations/${org}/connectors/slack/authorize`, { workspace_id: ws })).statusCode).toBe(403);
    expect((await call(member, "PUT", `/v1/organizations/${org}/connectors/policy`, { allowed: [] })).statusCode).toBe(403);
  });
});

describe("Gmail (personal)", () => {
  let connectorId: string;
  let thread: string;

  beforeAll(() => {
    const m = addGmailMessage(world, { from: "Marta <marta@acme.test>", to: "me@test", subject: "Renovación contrato 2027", text: "Importe acordado: 18.400 EUR.", attachment: { filename: "borrador.pdf", mimeType: "application/pdf", data: Buffer.from("%PDF-1.4 fake") } });
    thread = m.threadId;
    addGmailMessage(world, { threadId: thread, from: "Yo <me@test>", to: "marta@acme.test", subject: "Re: Renovación contrato 2027", text: "Perfecto.\n\nOn Mon, Nov 3, 2026 Marta wrote:\n> Importe acordado", labels: ["SENT"] });
    addGmailMessage(world, { from: "Promo <p@shop.test>", to: "me@test", subject: "Oferta", text: "50%", labels: ["INBOX", "CATEGORY_PROMOTIONS"] });
    addGmailMessage(world, { from: "Spam <s@spam.test>", to: "me@test", subject: "Gana dinero", text: "...", labels: ["SPAM"] });
  });

  it("autoriza con PKCE y alcance de solo lectura", async () => {
    const { authorize, complete } = await connect(member, "gmail");
    expect(authorize.host).toBe("accounts.google.com");
    expect(authorize.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.readonly");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("redirect_uri")).toBe("https://app.ragsis.test/connect/callback");
    expect(complete.statusCode).toBe(200);
    expect(complete.json()).toMatchObject({ provider: "gmail", status: "active", organization_id: org });
    connectorId = complete.json().connector_id;
    // El token queda cifrado en BD.
    const cred = (await owner.query("SELECT ciphertext FROM connector_credentials WHERE connector_id=$1", [connectorId])).rows[0];
    expect(cred.ciphertext).toMatch(/^v1\./);
    expect(cred.ciphertext).not.toContain("g-at-1");
  });

  it("el state es de un solo uso y de la misma persona", async () => {
    const a = await call(member, "POST", `/v1/organizations/${org}/connectors/gmail/authorize`, { workspace_id: ws });
    const state = new URL(a.json().authorize_url).searchParams.get("state")!;
    // Otra persona de la organización no puede completar el flujo iniciado por member.
    expect((await call(admin, "POST", "/v1/connectors/oauth/complete", { state, code: "ok" })).json().error.code).toBe("connect_expired");
    expect((await call(member, "POST", "/v1/connectors/oauth/complete", { state, code: "ok" })).statusCode).toBe(200);
    expect((await call(member, "POST", "/v1/connectors/oauth/complete", { state, code: "ok" })).json().error.code).toBe("connect_expired");
  });

  it("sincroniza hilos y adjuntos solo para su dueño", async () => {
    await drain();
    const rows = await sourceRows(connectorId);
    expect(rows.map((r) => r.source_id.split(":")[0]).sort()).toEqual(["att", "thread"]);
    expect(rows.every((r) => r.principal === `user:${memberId}` && r.classification === "confidential")).toBe(true);
    const titles = (await docs(member)).map((d) => d.title);
    expect(titles).toEqual(expect.arrayContaining(["Renovación contrato 2027", "borrador.pdf"]));
    expect(titles).not.toContain("Oferta");
    expect(titles).not.toContain("Gana dinero");
    // El admin del mismo workspace no ve el correo de otra persona ni su conexión.
    expect((await docs(admin)).map((d) => d.title)).not.toContain("Renovación contrato 2027");
    expect((await call(admin, "GET", `/v1/organizations/${org}/connectors`)).json().connectors).toEqual([]);
    expect((await call(admin, "DELETE", `/v1/organizations/${org}/connectors/${connectorId}`)).statusCode).toBe(404);
    // El hilo se indexa sin el texto citado y entra por el pipeline normal.
    const threadRow = rows.find((r) => r.source_id.startsWith("thread:"))!;
    const key = [...storage.objects.keys()].find((k) => k.includes(threadRow.id))!;
    const body = storage.objects.get(key)!.toString("utf8");
    expect(body).toContain("18.400 EUR");
    expect(body).not.toContain("> Importe acordado");
    expect(queue.messages.filter((m) => m.kind === "ingest" && m.document_id === threadRow.id)).toHaveLength(1);
  });

  it("delta: mensaje nuevo crea versión; hilo borrado se retira", async () => {
    addGmailMessage(world, { threadId: thread, from: "Marta <marta@acme.test>", to: "me@test", subject: "Re: Renovación contrato 2027", text: "Firmado." });
    await drain();
    let rows = await sourceRows(connectorId);
    expect(rows.find((r) => r.source_id === `thread:${thread}`)!.versions).toBe(2);
    deleteGmailThread(world, thread);
    await drain();
    rows = await sourceRows(connectorId);
    expect(rows.find((r) => r.source_id === `thread:${thread}`)).toBeUndefined();
    const deleting = (await owner.query("SELECT count(*)::int AS n FROM documents WHERE source_id IS NULL AND status='deleting' AND owner_id=$1", [memberId])).rows[0].n;
    expect(deleting).toBe(2); // hilo + adjunto
    expect(queue.messages.filter((m) => m.kind === "delete")).toHaveLength(2);
  });

  it("historial caducado: recarga completa sin duplicar", async () => {
    addGmailMessage(world, { from: "Banco <b@bank.test>", to: "me@test", subject: "Extracto noviembre", text: "Saldo 12.000 EUR" });
    world.gmail.minHistoryId = world.gmail.historyId;
    await drain();
    world.gmail.minHistoryId = 1;
    const titles = (await sourceRows(connectorId)).map((r) => r.title);
    expect(titles.filter((t) => t === "Extracto noviembre")).toHaveLength(1);
  });

  it("acceso revocado en Google: pide reconectar", async () => {
    world.gmail.revoked = true;
    await owner.query("UPDATE connector_credentials SET expires_at=now() WHERE connector_id=$1", [connectorId]);
    // Fuerza refresco: el access token guardado caduca ya.
    const c = (await owner.query("SELECT organization_id FROM connectors WHERE id=$1", [connectorId])).rows[0];
    const cipher = app.connectors.cipher;
    await owner.query("UPDATE connector_credentials SET ciphertext=$2 WHERE connector_id=$1", [
      connectorId,
      cipher.seal({ access_token: "g-at-old", refresh_token: "g-rt-1", expires_at: Date.now() - 1000 }, `${c.organization_id}:${connectorId}`),
    ]);
    await drain();
    const list = (await call(member, "GET", `/v1/organizations/${org}/connectors`)).json().connectors;
    expect(list[0]).toMatchObject({ status: "error", last_error_code: "reconnect_needed" });
    expect((await call(member, "POST", `/v1/organizations/${org}/connectors/${connectorId}/sync`)).json().error.code).toBe("reconnect_needed");
    // Reconectar reactiva la misma conexión.
    const { complete } = await connect(member, "gmail");
    expect(complete.json()).toMatchObject({ connector_id: connectorId, status: "active" });
  });

  it("desconectar revoca y retira todo del buscador", async () => {
    await drain();
    const before = (await sourceRows(connectorId)).length;
    expect(before).toBeGreaterThan(0);
    const r = await call(member, "DELETE", `/v1/organizations/${org}/connectors/${connectorId}`);
    expect(r.statusCode).toBe(202);
    expect(r.json().removed_items).toBe(before);
    expect(world.gmail.revoked).toBe(true);
    expect((await owner.query("SELECT count(*)::int AS n FROM connectors WHERE id=$1", [connectorId])).rows[0].n).toBe(0);
    expect((await owner.query("SELECT count(*)::int AS n FROM documents WHERE owner_id=$1 AND status='active'", [memberId])).rows[0].n).toBe(0);
  });
});

describe("Slack (empresa)", () => {
  let connectorId: string;

  beforeAll(() => {
    addSlackChannel(world, { id: "C0LEGAL", name: "legal" });
    addSlackChannel(world, { id: "C0RANDOM", name: "random", is_member: true });
    addSlackChannel(world, { id: "G0SOCIOS", name: "socios", is_private: true, is_member: true });
    addSlackChannel(world, { id: "G0HIDDEN", name: "rrhh", is_private: true, is_member: false });
    addSlackMessage(world, "C0LEGAL", { user: "U0ANA", text: "Plazo del recurso 2026/341: viernes. <@U0LUIS> ¿borrador?", replies: [{ user: "U0LUIS", text: "Lo subo hoy." }] });
    addSlackMessage(world, "C0LEGAL", { user: "U0LUIS", text: "Ayer cerramos el acuerdo con Acme.", date: new Date(Date.now() - 86_400_000) });
    addSlackMessage(world, "G0SOCIOS", { user: "U0ANA", text: "Reparto de dividendos en enero." });
    addSlackMessage(world, "C0RANDOM", { user: "U0ANA", text: "¿Café?" });
  });

  it("conectar deja la conexión pendiente de elegir canales", async () => {
    const { authorize, complete } = await connect(admin, "slack");
    expect(authorize.host).toBe("slack.com");
    expect(authorize.searchParams.get("scope")).toContain("channels:history");
    expect(complete.json()).toMatchObject({ provider: "slack", status: "needs_setup" });
    connectorId = complete.json().connector_id;
    expect((await call(admin, "POST", `/v1/organizations/${org}/connectors/${connectorId}/sync`)).json().error.code).toBe("setup_needed");
  });

  it("ofrece canales públicos y solo los privados donde está el bot", async () => {
    expect((await call(member, "GET", `/v1/organizations/${org}/connectors/${connectorId}/options`)).statusCode).toBe(403);
    const r = await call(admin, "GET", `/v1/organizations/${org}/connectors/${connectorId}/options`);
    const ids = r.json().groups[0].options.map((o: { id: string }) => o.id);
    expect(ids).toEqual(expect.arrayContaining(["C0LEGAL", "C0RANDOM", "G0SOCIOS"]));
    expect(ids).not.toContain("G0HIDDEN");
  });

  it("sincroniza un documento por canal y día, visible para el workspace", async () => {
    const put = await call(admin, "PUT", `/v1/organizations/${org}/connectors/${connectorId}`, { settings: { channel_ids: ["C0LEGAL", "G0SOCIOS"] } });
    expect(put.json().status).toBe("active");
    await drain();
    expect(world.slack.channels.get("C0LEGAL")!.is_member).toBe(true); // se unió al canal público
    const rows = await sourceRows(connectorId);
    expect(rows.map((r) => r.container).sort()).toEqual(["ch:C0LEGAL", "ch:C0LEGAL", "ch:G0SOCIOS"]);
    expect(rows.every((r) => r.principal === `workspace:${ws}`)).toBe(true);
    expect(rows.find((r) => r.container === "ch:G0SOCIOS")!.classification).toBe("confidential");
    const today = new Date().toISOString().slice(0, 10);
    const legalToday = rows.find((r) => r.source_id === `day:C0LEGAL:${today}`)!;
    const body = storage.objects.get([...storage.objects.keys()].find((k) => k.includes(legalToday.id))!)!.toString("utf8");
    expect(body).toContain("@Luis Gómez");
    expect(body).toContain("> **Luis Gómez**");
    // El miembro del workspace lo ve.
    expect((await docs(member)).map((d) => d.title)).toContain(`#legal — ${today}`);
  });

  it("quitar un canal lo retira del buscador", async () => {
    await call(admin, "PUT", `/v1/organizations/${org}/connectors/${connectorId}`, { settings: { channel_ids: ["C0LEGAL"] } });
    await drain();
    expect((await sourceRows(connectorId)).some((r) => r.container === "ch:G0SOCIOS")).toBe(false);
  });

  it("un miembro ve la conexión de empresa pero no puede borrarla", async () => {
    const list = (await call(member, "GET", `/v1/organizations/${org}/connectors`)).json().connectors;
    expect(list.find((c: { id: string }) => c.id === connectorId)).toMatchObject({ provider: "slack", account_label: "Demo Workspace", is_mine: false });
    expect((await call(member, "DELETE", `/v1/organizations/${org}/connectors/${connectorId}`)).statusCode).toBe(403);
  });
});

describe("ClickUp (empresa)", () => {
  let connectorId: string;
  let taskId: string;

  beforeAll(() => {
    taskId = upsertClickUpTask(world, { name: "Revisar NDA Acme", description: "Duración 5 años, jurisdicción Madrid.", space: "101", comments: ["Cambios en la cláusula 7."] }).id;
    upsertClickUpTask(world, { name: "Cierre Q4", description: "Conciliar bancos.", space: "101" });
    upsertClickUpTask(world, { name: "Plan de socios", description: "Confidencial.", space: "102" });
    upsertClickUpDoc(world, { name: "Alta de clientes", space: "101", content: "1. KYC\n2. Hoja de encargo" });
    upsertClickUpDoc(world, { name: "Doc privado", space: "102", content: "secreto" });
  });

  it("indexa tareas y docs de espacios no privados por defecto", async () => {
    const { complete } = await connect(admin, "clickup");
    expect(complete.json()).toMatchObject({ provider: "clickup", status: "active" });
    connectorId = complete.json().connector_id;
    await drain();
    const titles = (await sourceRows(connectorId)).map((r) => r.title).sort();
    expect(titles).toEqual(["Alta de clientes", "Cierre Q4", "Revisar NDA Acme"]);
  });

  it("tarea editada crea versión; tarea borrada se retira en la reconciliación", async () => {
    upsertClickUpTask(world, { id: taskId, name: "Revisar NDA Acme", description: "Duración 3 años.", space: "101", updated: Date.now() + 1000 });
    await drain();
    expect((await sourceRows(connectorId)).find((r) => r.source_id === `task:${taskId}`)!.versions).toBe(2);
    world.clickup.tasks.delete(taskId);
    await owner.query("UPDATE connectors SET cursor = cursor - 'last_reconcile' WHERE id=$1", [connectorId]);
    await drain();
    expect((await sourceRows(connectorId)).find((r) => r.source_id === `task:${taskId}`)).toBeUndefined();
  });

  it("los espacios privados requieren selección explícita", async () => {
    await call(admin, "PUT", `/v1/organizations/${org}/connectors/${connectorId}`, { settings: { space_ids: ["101", "102"] } });
    await drain();
    const titles = (await sourceRows(connectorId)).map((r) => r.title);
    expect(titles).toEqual(expect.arrayContaining(["Plan de socios", "Doc privado"]));
  });

  it("desactivar la app en la organización pausa su sincronización", async () => {
    expect((await call(admin, "PUT", `/v1/organizations/${org}/connectors/policy`, { allowed: ["gmail", "slack"] })).statusCode).toBe(200);
    upsertClickUpTask(world, { name: "Tarea nueva", space: "101" });
    await owner.query("UPDATE connectors SET next_sync_at=now() WHERE id=$1", [connectorId]);
    await app.connectors.tick();
    expect((await sourceRows(connectorId)).map((r) => r.title)).not.toContain("Tarea nueva");
    expect((await call(admin, "POST", `/v1/organizations/${org}/connectors/clickup/authorize`, { workspace_id: ws })).json().error.code).toBe("provider_disabled");
    await call(admin, "PUT", `/v1/organizations/${org}/connectors/policy`, { allowed: ["gmail", "slack", "clickup"] });
  });
});
