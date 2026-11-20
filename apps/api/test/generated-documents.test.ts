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
import type { RagClient, RenderedFile } from "../src/routes/query.js";

/**
 * Documents generated from the chat (ADR-034): the API reads the verified Markdown under RLS, re-checks that every
 * cited document is still visible, and only then asks the rag-engine to convert it. These tests cover that boundary;
 * the conversion itself is tested in tests/python/test_documents.py.
 */

const ROOT = path.resolve(import.meta.dirname, "../../..");
const env = Object.fromEntries(
  readFileSync(path.join(ROOT, ".env"), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const PORT = process.env.POSTGRES_HOST_PORT ?? "55432";
const DB = "ragsis_generated_docs_test";
const SECRET = "generated-docs-test-internal-secret-0123456789";

const storage = { presignPut: async () => "", presignGet: async () => "", head: async () => null, delete: async () => undefined, put: async () => undefined, get: async () => null } as Storage;
const queue: Queue = { send: async () => undefined };

const MIME: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv; charset=utf-8",
  md: "text/markdown; charset=utf-8",
};

/** Records what the API sends to the rag-engine and answers like it: bytes plus a suggested filename. */
class FakeRag implements RagClient {
  renders: Record<string, unknown>[] = [];
  queries: Record<string, unknown>[] = [];
  renderStatus = 200;
  filename: string | null = "plan-de-teletrabajo.pdf";
  async query(_token: string, body: Record<string, unknown>) {
    this.queries.push(body);
    return {
      status: 200,
      body: {
        trace_id: `qry_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
        answer: "Done: I prepared the report.",
        abstained: false,
        citations: [],
        latency_ms: 10,
        document: { id: randomUUID(), title: "Plan", format: "pdf", kind: "report", filename: "plan.pdf", markdown: "# Plan\n\nSecret body [1].\n", outline: [], sections: 0, words: 3, sources: 1, slides: 0, rows: 0, formats: ["pdf", "docx", "pptx", "csv", "md"] },
      },
    };
  }
  async render(_token: string, body: Record<string, unknown>): Promise<RenderedFile> {
    this.renders.push(body);
    const format = String(body.format);
    return { status: this.renderStatus, data: Buffer.from(`%${format.toUpperCase()}% ${body.title}`), contentType: MIME[format], filename: this.filename };
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

/** New org: Alice (owner) and Bob (reader of the default workspace), plus one document both can read. */
async function setup(tag: string) {
  const alice = await login(`alice@${tag}.test`);
  const bob = await login(`bob@${tag}.test`);
  const o = (await call(alice, "POST", "/v1/organizations", { name: `Org ${tag}` })).json();
  const bobId = (await call(alice, "POST", `/v1/organizations/${o.id}/members`, { email: `bob@${tag}.test`, role: "member" })).json().user_id;
  await call(alice, "POST", `/v1/organizations/${o.id}/workspaces/${o.default_workspace_id}/members`, { user_id: bobId, role: "reader" });
  const doc = randomUUID();
  await owner.query("INSERT INTO documents (id, organization_id, workspace_id, title) VALUES ($1,$2,$3,'Remote work policy')", [doc, o.id, o.default_workspace_id]);
  await owner.query("INSERT INTO document_acl (document_id, organization_id, principal) VALUES ($1,$2,$3)", [doc, o.id, `workspace:${o.default_workspace_id}`]);
  const aliceId = (await owner.query("SELECT id FROM users WHERE email=$1", [`alice@${tag}.test`])).rows[0].id as string;
  return { alice, bob, aliceId, org: o.id as string, ws: o.default_workspace_id as string, doc };
}

/** What the rag-engine stores when it writes a file (same transaction as the query trace). */
async function generated(s: Awaited<ReturnType<typeof setup>>, opts: { format?: string; kind?: string; cites?: (string | null)[] } = {}) {
  const id = randomUUID();
  const citations = (opts.cites ?? [s.doc]).map((d, i) => ({ n: i + 1, title: "Remote work policy", filename: "policy.pdf", page: 2, ...(d ? { document_id: d } : {}) }));
  await owner.query(
    `INSERT INTO generated_documents (id, organization_id, user_id, workspace_id, title, format, kind, markdown, citations)
     VALUES ($1,$2,$3,$4,'Remote work plan',$5,$6,$7,$8::jsonb)`,
    [id, s.org, s.aliceId, s.ws, opts.format ?? "pdf", opts.kind ?? "report", "# Remote work plan\n\nUp to three days a week [1].\n", JSON.stringify(citations)],
  );
  return id;
}

const fileUrl = (org: string, id: string, qs = "") => `/v1/organizations/${org}/generated-documents/${id}/file${qs}`;

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

describe("generated documents", () => {
  it("returns the card and Markdown to its author", async () => {
    const s = await setup("meta");
    const id = await generated(s, { format: "pptx", kind: "presentation" });
    const r = await call(s.alice, "GET", `/v1/organizations/${s.org}/generated-documents/${id}`);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ id, title: "Remote work plan", format: "pptx", kind: "presentation", redacted: false });
    expect(r.json().markdown).toContain("Up to three days");
    expect(r.json().citations).toHaveLength(1);
  });

  it("converts on download, in the stored format or any other, and audits each download", async () => {
    const s = await setup("dl");
    const id = await generated(s);
    rag.renders = [];

    const pdf = await call(s.alice, "GET", fileUrl(s.org, id));
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.headers["content-disposition"]).toBe('attachment; filename="plan-de-teletrabajo.pdf"');
    expect(pdf.headers["cache-control"]).toBe("private, no-store");
    expect(pdf.headers["x-content-type-options"]).toBe("nosniff");
    expect(pdf.headers["content-security-policy"]).toContain("sandbox");
    expect(pdf.body).toBe("%PDF% Remote work plan");
    expect(rag.renders[0]).toMatchObject({ format: "pdf", kind: "report", title: "Remote work plan", markdown: expect.stringContaining("[1]") });
    expect(rag.renders[0].citations).toHaveLength(1);

    rag.filename = "plan-de-teletrabajo.docx";
    const docx = await call(s.alice, "GET", fileUrl(s.org, id, "?format=docx&disposition=inline"));
    expect(docx.statusCode).toBe(200);
    expect(docx.headers["content-type"]).toBe(MIME.docx);
    expect(docx.headers["content-disposition"]).toBe('inline; filename="plan-de-teletrabajo.docx"');
    expect(rag.renders[1]).toMatchObject({ format: "docx" });

    rag.filename = "plan-de-teletrabajo.xlsx";
    const xlsx = await call(s.alice, "GET", fileUrl(s.org, id, "?format=xlsx"));
    expect(xlsx.statusCode).toBe(200);
    expect(xlsx.headers["content-type"]).toBe(MIME.xlsx);
    expect(xlsx.headers["content-disposition"]).toBe('attachment; filename="plan-de-teletrabajo.xlsx"');

    const audits = await owner.query("SELECT decision, metadata FROM audit_events WHERE action='generated_document.download' AND resource=$1 ORDER BY id", [`generated_document:${id}`]);
    expect(audits.rows.map((a) => [a.decision, a.metadata.format])).toEqual([["allow", "pdf"], ["allow", "docx"], ["allow", "xlsx"]]);
    rag.filename = "plan-de-teletrabajo.pdf";
  });

  it("never trusts the engine's filename for the header", async () => {
    const s = await setup("name");
    const id = await generated(s, { format: "csv", kind: "table" });
    rag.filename = '../../etc/passwd"; x=".csv';
    const r = await call(s.alice, "GET", fileUrl(s.org, id));
    expect(r.headers["content-disposition"]).toBe('attachment; filename="document.csv"');
    rag.filename = "plan-de-teletrabajo.pdf";
  });

  it("is private to its author: other members and other orgs get 404, and nothing is rendered", async () => {
    const s = await setup("priv");
    const id = await generated(s);
    rag.renders = [];
    expect((await call(s.bob, "GET", `/v1/organizations/${s.org}/generated-documents/${id}`)).statusCode).toBe(404);
    expect((await call(s.bob, "GET", fileUrl(s.org, id))).statusCode).toBe(404);
    const eve = await login("eve@outside-docs.test");
    expect((await call(eve, "GET", fileUrl(s.org, id))).statusCode).toBe(404);
    expect(rag.renders).toHaveLength(0);
  });

  it("withholds the file once a cited document is no longer visible (410, denied in the audit log)", async () => {
    const s = await setup("acl");
    const id = await generated(s);
    await owner.query("DELETE FROM document_acl WHERE document_id=$1", [s.doc]);
    rag.renders = [];

    const meta = (await call(s.alice, "GET", `/v1/organizations/${s.org}/generated-documents/${id}`)).json();
    expect(meta).toMatchObject({ redacted: true, markdown: null, citations: null });
    const r = await call(s.alice, "GET", fileUrl(s.org, id, "?format=docx"));
    expect(r.statusCode).toBe(410);
    expect(r.json().error.code).toBe("source_unavailable");
    expect(rag.renders).toHaveLength(0);
    const deny = await owner.query("SELECT metadata FROM audit_events WHERE action='generated_document.download' AND decision='deny' AND resource=$1", [`generated_document:${id}`]);
    expect(deny.rows[0].metadata).toMatchObject({ reason: "source_unavailable", format: "docx" });

    // A citation without a document id can't be re-checked, so it is treated as not visible.
    const orphan = await generated(s, { cites: [null] });
    expect((await call(s.alice, "GET", fileUrl(s.org, orphan))).statusCode).toBe(410);
  });

  it("rejects unknown formats and reports a failed conversion as 503", async () => {
    const s = await setup("err");
    const id = await generated(s);
    expect((await call(s.alice, "GET", fileUrl(s.org, id, "?format=exe"))).statusCode).toBe(400);
    expect((await call(s.alice, "GET", `/v1/organizations/${s.org}/generated-documents/not-a-uuid/file`)).statusCode).toBe(404);
    rag.renderStatus = 422;
    const r = await call(s.alice, "GET", fileUrl(s.org, id));
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe("render_failed");
    rag.renderStatus = 200;
  });

  it("passes the requested output to the engine and keeps only the card in the history", async () => {
    const s = await setup("hist");
    rag.queries = [];
    const conv = randomUUID();
    const r = await call(s.alice, "POST", `/v1/organizations/${s.org}/workspaces/${s.ws}/query`, { question: "Make a PDF report about remote work", output: "auto", conversation_id: conv });
    expect(r.statusCode).toBe(200);
    expect(rag.queries[0]).toMatchObject({ output: "auto" });
    expect(r.json().document.markdown).toContain("Secret body");
    expect((await call(s.alice, "POST", `/v1/organizations/${s.org}/workspaces/${s.ws}/query`, { question: "x", output: "exe" })).statusCode).toBe(400);

    const turn = (await call(s.alice, "GET", `/v1/organizations/${s.org}/conversations/${conv}`)).json().turns[0];
    expect(turn.result.document).toMatchObject({ title: "Plan", format: "pdf" });
    expect(turn.result.document.markdown).toBeUndefined();
  });
});
