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
import { countryFromProfile } from "../src/lib/public-sources.js";
import type { RagClient } from "../src/routes/query.js";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const env = Object.fromEntries(
  readFileSync(path.join(ROOT, ".env"), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const PORT = process.env.POSTGRES_HOST_PORT ?? "55432";
const DB = "ragsis_public_sources_test";
const SECRET = "public-sources-test-internal-secret-0123456789";

const storage = { presignPut: async () => "", presignGet: async () => "", head: async () => null, delete: async () => undefined, put: async () => undefined, get: async () => null } as Storage;
const queue: Queue = { send: async () => undefined };

/** Records the signed `pub` claim and answers like the rag-engine would with one public lookup. */
class FakeRag implements RagClient {
  lastPub: unknown = undefined;
  lastBody: Record<string, unknown> = {};
  async publicSourcesStatus() {
    return { available: true, demo: true };
  }
  async query(token: string, body: Record<string, unknown>) {
    this.lastBody = body;
    this.lastPub = decodeJwt(token).pub;
    const pub = this.lastPub as { n: number } | undefined;
    const citations = pub
      ? [{ n: 1, external: true, kind: "public_record", title: "RUES (Colombia) · ACME SAS", source: "RUES", country: "co", url: "https://example.org/rues", snippet: "…", document_id: null, version_id: null, chunk_id: null }]
      : [];
    return {
      status: 200,
      body: {
        trace_id: `qry_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
        answer: pub ? "Según el RUES… [1]" : "I couldn't find enough evidence in the authorized documents to answer.",
        abstained: !pub,
        citations,
        latency_ms: 10,
        public_sources: pub ? { requested: true, lookups: 1, countries: ["co"], sources: ["RUES"], unavailable: null, demo: true } : null,
      },
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
  const token = r.json().token as string;
  await call(token, "GET", "/v1/me");
  return token;
}

async function setup(tag: string) {
  const alice = await login(`alice@${tag}.test`);
  const bob = await login(`bob@${tag}.test`);
  const o = (await call(alice, "POST", "/v1/organizations", { name: `Org ${tag}` })).json();
  const bobId = (await call(alice, "POST", `/v1/organizations/${o.id}/members`, { email: `bob@${tag}.test`, role: "member" })).json().user_id;
  await call(alice, "POST", `/v1/organizations/${o.id}/workspaces/${o.default_workspace_id}/members`, { user_id: bobId, role: "reader" });
  const ask = (token: string, extra: object = {}) =>
    call(token, "POST", `/v1/organizations/${o.id}/workspaces/${o.default_workspace_id}/query`, { question: "¿ACME SAS tiene procesos judiciales?", ...extra });
  const settings = `/v1/organizations/${o.id}/public-sources`;
  return { alice, bob, org: o.id as string, ask, settings };
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

describe("public records (ADR-036)", () => {
  it("is off by default: the question is answered from documents and says why", async () => {
    const { alice, ask, settings } = await setup("pub-off");
    const s = (await call(alice, "GET", settings)).json();
    expect(s).toMatchObject({ available: true, demo: true, enabled: false, monthly_limit: 300, used_this_month: 0, can_manage: true });
    const r = await ask(alice, { public_sources: true });
    expect(r.statusCode).toBe(200);
    expect(rag.lastPub).toBeUndefined();
    expect(r.json().public_sources).toMatchObject({ requested: true, lookups: 0, unavailable: "off" });
  });

  it("only admins change it; the change is audited", async () => {
    const { alice, bob, org, settings } = await setup("pub-admin");
    expect((await call(bob, "PUT", settings, { enabled: true })).statusCode).toBe(403);
    expect((await call(bob, "GET", settings)).json()).toMatchObject({ enabled: false, can_manage: false });
    expect((await call(alice, "PUT", settings, { enabled: true, country: "xx" })).statusCode).toBe(400);
    expect((await call(alice, "PUT", settings, { enabled: true, api_key: "x" })).statusCode).toBe(400);
    const on = (await call(alice, "PUT", settings, { enabled: true, country: "co", monthly_limit: 10 })).json();
    expect(on).toMatchObject({ enabled: true, country: "co", country_setting: "co", monthly_limit: 10, remaining: 10 });
    const audit = await owner.query("SELECT metadata FROM audit_events WHERE organization_id=$1 AND action='organization.public_sources_updated'", [org]);
    expect(audit.rows[0].metadata.to).toMatchObject({ enabled: true, country: "co" });
  });

  it("signs the allowance into the internal token and audits each answer that used it", async () => {
    const { alice, bob, org, ask, settings } = await setup("pub-on");
    await call(alice, "PUT", settings, { enabled: true, country: "co" });
    const r = await ask(bob, { public_sources: true, country: "mx" });
    expect(r.statusCode).toBe(200);
    expect(rag.lastPub).toEqual({ c: "co", w: true, n: 2, o: "mx" });
    // The body to the rag-engine never carries the switch: only the signed claim does.
    expect(rag.lastBody.public_sources).toBeUndefined();
    expect(r.json().citations[0].external).toBe(true);
    const audit = await owner.query("SELECT metadata FROM audit_events WHERE organization_id=$1 AND action='query.public_sources'", [org]);
    expect(audit.rows[0].metadata).toMatchObject({ lookups: 1, sources: ["RUES"], countries: ["co"] });

    // Without the flag nothing is looked up, even with the organization switch on.
    await ask(bob);
    expect(rag.lastPub).toBeUndefined();
    expect((await ask(bob, { public_sources: true, country: "zz" })).statusCode).toBe(400);
  });

  it("restricted data never goes out: it cannot be turned on and is never signed", async () => {
    const { alice, org, ask, settings } = await setup("pub-restricted");
    await call(alice, "PUT", settings, { enabled: true });
    await owner.query("UPDATE organizations SET data_class='restricted' WHERE id=$1", [org]);
    expect((await call(alice, "GET", settings)).json()).toMatchObject({ restricted: true, enabled: false });
    expect((await call(alice, "PUT", settings, { enabled: true })).statusCode).toBe(403);
    const r = await ask(alice, { public_sources: true });
    expect(rag.lastPub).toBeUndefined();
    expect(r.json().public_sources).toMatchObject({ unavailable: "restricted", lookups: 0 });
  });

  it("stops at the monthly limit and caps lookups to what is left", async () => {
    const { alice, org, ask, settings } = await setup("pub-limit");
    await call(alice, "PUT", settings, { enabled: true, monthly_limit: 3 });
    await owner.query("INSERT INTO usage_events (organization_id, kind, quantity) VALUES ($1, 'public_lookups', 2)", [org]);
    await ask(alice, { public_sources: true });
    expect(rag.lastPub).toMatchObject({ n: 1 });
    await owner.query("INSERT INTO usage_events (organization_id, kind, quantity) VALUES ($1, 'public_lookups', 1)", [org]);
    const r = await ask(alice, { public_sources: true });
    expect(rag.lastPub).toBeUndefined();
    expect(r.json().public_sources).toMatchObject({ unavailable: "limit", lookups: 0 });
    expect((await call(alice, "GET", settings)).json()).toMatchObject({ used_this_month: 3, remaining: 0 });
  });

  it("a public record never hides an answer when the conversation is reopened", async () => {
    const { alice, org, ask, settings } = await setup("pub-history");
    await call(alice, "PUT", settings, { enabled: true });
    const id = randomUUID();
    expect((await ask(alice, { public_sources: true, conversation_id: id })).json().conversation_id).toBe(id);
    const conv = (await call(alice, "GET", `/v1/organizations/${org}/conversations/${id}`)).json();
    expect(conv.turns[0].redacted).toBe(false);
    expect(conv.turns[0].result.public_sources).toMatchObject({ lookups: 1 });
  });
});

describe("countryFromProfile", () => {
  it("maps onboarding free text to a supported code", () => {
    expect(countryFromProfile("Colombia")).toBe("co");
    expect(countryFromProfile(" México ")).toBe("mx");
    expect(countryFromProfile("CL")).toBe("cl");
    expect(countryFromProfile("Argentina")).toBeNull();
    expect(countryFromProfile(null)).toBeNull();
  });
});
