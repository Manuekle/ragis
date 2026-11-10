import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createPool } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import { startMockOidc, type MockOidc } from "../src/scripts/mock-oidc.js";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const env = Object.fromEntries(
  readFileSync(path.join(ROOT, ".env"), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const PORT = process.env.POSTGRES_HOST_PORT ?? "55432";
const DB = "ragsis_oidc_test";
const CLIENT = "ragsis-web-test";

let idp: MockOidc;
let app: FastifyInstance;
let pool: pg.Pool;

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: `postgres://ragsis_owner:${env.POSTGRES_PASSWORD}@127.0.0.1:${PORT}/ragsis` });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${DB}`);
  await admin.end();
  await migrate(`postgres://ragsis_owner:${env.POSTGRES_PASSWORD}@127.0.0.1:${PORT}/${DB}`, path.join(ROOT, "db/migrations"));
  idp = await startMockOidc({ clientId: CLIENT });
  const cfg = loadConfig({
    DATABASE_URL: `postgres://ragsis_app:${env.RAGSIS_APP_DB_PASSWORD}@127.0.0.1:${PORT}/${DB}`,
    INTERNAL_SERVICE_SECRET: "oidc-test-internal-secret-0123456789abcdef",
    AUTH_MODE: "oidc",
    OIDC_ISSUER: idp.issuer,
    OIDC_AUDIENCE: CLIENT,
    RAGSIS_ENV: "production",
  });
  pool = createPool(cfg.DATABASE_URL);
  const noop = { async presignPut() { return ""; }, async presignGet() { return ""; }, async head() { return null; }, async delete() {} };
  app = await buildApp({ cfg, pool, storage: noop, queue: { async send() {} }, rag: { async query() { return { status: 503, body: {} }; } } });
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await idp?.close();
});

async function pkceLogin(email: string): Promise<string> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const redirect = "http://localhost:3000/api/auth/callback";
  const auth = await fetch(
    `${idp.issuer}/authorize?` +
      new URLSearchParams({ client_id: CLIENT, redirect_uri: redirect, response_type: "code", code_challenge: challenge,
        code_challenge_method: "S256", state: "s1", nonce: "n1", login_hint: email }),
    { redirect: "manual" },
  );
  const code = new URL(auth.headers.get("location")!).searchParams.get("code")!;
  const bad = await fetch(`${idp.issuer}/token`, {
    method: "POST",
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id: CLIENT, code_verifier: "wrong" }),
  });
  expect(bad.status).toBe(400); // PKCE inválido: además consume el código
  const auth2 = await fetch(
    `${idp.issuer}/authorize?` +
      new URLSearchParams({ client_id: CLIENT, redirect_uri: redirect, response_type: "code", code_challenge: challenge,
        code_challenge_method: "S256", state: "s1", nonce: "n1", login_hint: email }),
    { redirect: "manual" },
  );
  const code2 = new URL(auth2.headers.get("location")!).searchParams.get("code")!;
  const tok = await fetch(`${idp.issuer}/token`, {
    method: "POST",
    body: new URLSearchParams({ grant_type: "authorization_code", code: code2, redirect_uri: redirect, client_id: CLIENT, code_verifier: verifier }),
  });
  return (await tok.json()).id_token;
}

const me = (token: string) => app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${token}` } });

describe("AUTH_MODE=oidc", () => {
  it("acepta id_token RS256 del IdP vía JWKS y crea el usuario federado", async () => {
    const idToken = await pkceLogin("ana@empresa.test");
    const r = await me(idToken);
    expect(r.statusCode).toBe(200);
    expect(r.json().user.email).toBe("ana@empresa.test");
  });

  it("rechaza audiencia, issuer, email no verificado y access tokens", async () => {
    const base = { sub: "mock|x", email: "x@empresa.test", email_verified: true, token_use: "id" };
    expect((await me(await idp.sign(base, { audience: "otro-cliente" }))).statusCode).toBe(401);
    expect((await me(await idp.sign(base, { issuer: "https://evil.example" }))).statusCode).toBe(401);
    expect((await me(await idp.sign({ ...base, email_verified: false }))).statusCode).toBe(401);
    expect((await me(await idp.sign({ ...base, token_use: "access" }))).statusCode).toBe(401);
    expect((await me(await idp.sign(base))).statusCode).toBe(200);
  });

  it("no expone dev-login en modo OIDC", async () => {
    const r = await app.inject({ method: "POST", url: "/v1/auth/dev-login", payload: { email: "a@b.test" } });
    expect(r.statusCode).toBe(404);
  });
});
