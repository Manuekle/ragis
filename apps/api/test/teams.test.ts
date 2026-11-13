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
import { allowedTransitions, needsAttention, statusAfterComment } from "../src/lib/team-requests.js";
import type { RagClient } from "../src/routes/query.js";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const env = Object.fromEntries(
  readFileSync(path.join(ROOT, ".env"), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const PORT = process.env.POSTGRES_HOST_PORT ?? "55432";
const DB = "ragsis_teams_test";

const storage = { presignPut: async () => "", presignGet: async () => "", head: async () => null, delete: async () => undefined, put: async () => undefined, get: async () => null } as Storage;
const queue: Queue = { send: async () => undefined };
const rag: RagClient = { query: async () => ({ status: 200, body: {} }) };

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

/**
 * Alice owns the org and belongs to no team. Lucia is in Legal; Tomas leads Treasury and Bob works there.
 * Carol is a member with no team; Victor is a viewer.
 */
async function setup(tag: string) {
  const people = ["alice", "lucia", "tomas", "bob", "carol", "victor"] as const;
  const tokens = Object.fromEntries(await Promise.all(people.map(async (p) => [p, await login(`${p}@${tag}.test`)]))) as Record<(typeof people)[number], string>;
  const org = (await call(tokens.alice, "POST", "/v1/organizations", { name: `Org ${tag}` })).json();
  const ids: Record<string, string> = { alice: (await call(tokens.alice, "GET", "/v1/me")).json().user.id };
  for (const p of people.slice(1)) {
    const r = await call(tokens.alice, "POST", `/v1/organizations/${org.id}/members`, { email: `${p}@${tag}.test`, role: p === "victor" ? "viewer" : "member" });
    expect(r.statusCode).toBe(201);
    ids[p] = r.json().user_id;
  }
  const base = `/v1/organizations/${org.id}`;
  return { ...tokens, ids, org: org.id as string, base };
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
    INTERNAL_SERVICE_SECRET: "teams-test-internal-secret-0123456789abcdef",
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

describe("request rules", () => {
  const team = { requester: false, receiver: true, assignee: false };
  const requester = { requester: true, receiver: false, assignee: false };

  it("lets the receiving team work the request and the requester cancel or reopen it", () => {
    expect(allowedTransitions("open", team)).toEqual(["in_progress", "waiting", "done", "declined"]);
    expect(allowedTransitions("open", requester)).toEqual(["cancelled"]);
    expect(allowedTransitions("done", requester)).toEqual(["open"]);
    expect(allowedTransitions("done", team)).toEqual(["in_progress"]);
    expect(allowedTransitions("cancelled", team)).toEqual([]);
    expect(allowedTransitions("open", { requester: false, receiver: false, assignee: false })).toEqual([]);
  });

  it("puts a waiting request back in the team's hands when the requester replies", () => {
    expect(statusAfterComment("waiting", requester)).toBe("in_progress");
    expect(statusAfterComment("waiting", team)).toBeNull();
    expect(statusAfterComment("in_progress", requester)).toBeNull();
  });

  it("asks for attention only from whoever has to act", () => {
    const r = { status: "open" as const, requested_by: "u-req", assignee_id: null, to_team_id: "t1" };
    expect(needsAttention(r, "u-lead", new Set(["t1"]))).toBe(true);
    expect(needsAttention(r, "u-other", new Set())).toBe(false);
    expect(needsAttention({ ...r, assignee_id: "u-bob" }, "u-lead", new Set(["t1"]))).toBe(false);
    expect(needsAttention({ ...r, status: "waiting" }, "u-req", new Set())).toBe(true);
  });
});

describe("teams and requests between teams", () => {
  it("separates teams, routes a request from Legal to Treasury and keeps it among the people involved", async () => {
    const s = await setup("flow");

    // An admin creates the teams. A space called "Treasury" already exists: the team adopts it.
    const ws = await call(s.alice, "POST", `${s.base}/workspaces`, { name: "Finance & Treasury" });
    expect(ws.statusCode).toBe(201);
    const legal = (await call(s.alice, "POST", `${s.base}/teams`, { name: "Legal", color: "violet", lead_user_id: s.ids.lucia })).json();
    expect(legal).toMatchObject({ reused_space: false, members: 1 });
    const treasury = (await call(s.alice, "POST", `${s.base}/teams`, { name: "Finance & Treasury", color: "green" })).json();
    // The adopted space keeps its people: Alice created it, so she is in Treasury until she steps out.
    expect(treasury).toMatchObject({ reused_space: true, workspace_id: ws.json().id, members: 1 });
    expect((await call(s.alice, "DELETE", `${s.base}/teams/${treasury.id}/members/${s.ids.alice}`)).statusCode).toBe(204);
    expect((await call(s.alice, "POST", `${s.base}/teams`, { name: "legal" })).statusCode).toBe(409);
    expect((await call(s.lucia, "POST", `${s.base}/teams`, { name: "Sales" })).statusCode).toBe(403);

    expect((await call(s.alice, "PUT", `${s.base}/teams/${treasury.id}/members/${s.ids.tomas}`, { lead: true })).statusCode).toBe(204);
    // Admins (the managers) decide who is in which team, from Governance. Not even a team's lead can.
    expect((await call(s.alice, "PUT", `${s.base}/teams/${treasury.id}/members/${s.ids.bob}`, {})).statusCode).toBe(204);
    expect((await call(s.tomas, "PUT", `${s.base}/teams/${treasury.id}/members/${s.ids.carol}`, {})).statusCode).toBe(403);
    expect((await call(s.tomas, "DELETE", `${s.base}/teams/${treasury.id}/members/${s.ids.bob}`)).statusCode).toBe(403);
    expect((await call(s.tomas, "PATCH", `${s.base}/teams/${treasury.id}`, { name: "Money" })).statusCode).toBe(403);
    expect((await call(s.bob, "PUT", `${s.base}/teams/${treasury.id}/members/${s.ids.carol}`, {})).statusCode).toBe(403);
    expect((await call(s.lucia, "PUT", `${s.base}/teams/${treasury.id}/members/${s.ids.carol}`, {})).statusCode).toBe(403);

    // No mixing: Lucia only has Legal's space; Treasury's documents are out of her reach.
    const luciaSpaces = (await call(s.lucia, "GET", `${s.base}/workspaces`)).json().workspaces.map((w: { id: string }) => w.id);
    expect(luciaSpaces).toEqual([legal.workspace_id]);
    expect((await call(s.lucia, "GET", `${s.base}/workspaces/${treasury.workspace_id}/documents`)).statusCode).toBe(404);

    // The directory is public inside the org: everyone can see which teams exist and who leads them.
    const dir = (await call(s.carol, "GET", `${s.base}/teams`)).json();
    expect(dir.teams.map((x: { name: string }) => x.name)).toEqual(["Finance & Treasury", "Legal"]);
    expect(dir.teams[0].people.find((p: { lead: boolean }) => p.lead).id).toBe(s.ids.tomas);
    expect(dir.teams[0].open_requests).toBeNull(); // not her queue
    expect(dir.can_manage).toBe(false);

    // Lucia (Legal) asks Treasury for something. She is in one team, so the request comes from Legal.
    const created = await call(s.lucia, "POST", `${s.base}/requests`, { to_team_id: treasury.id, title: "Bank certificate for the Acme contract", body: "Needed before Friday's signing.", priority: "high", due_on: "2026-11-20" });
    expect(created.statusCode).toBe(201);
    const req1 = created.json();
    expect(req1).toMatchObject({ number: 1, status: "open", priority: "high", due_on: "2026-11-20", from_team: { name: "Legal" }, to_team: { name: "Finance & Treasury" } });
    expect(req1.my).toMatchObject({ requester: true, receiver: false, transitions: ["cancelled"], can_assign: false });

    // Who sees it: the requester, the receiving team, the sending team. Not the admin, not other members.
    for (const who of [s.lucia, s.tomas, s.bob]) expect((await call(who, "GET", `${s.base}/requests/${req1.id}`)).statusCode).toBe(200);
    for (const who of [s.alice, s.carol]) expect((await call(who, "GET", `${s.base}/requests/${req1.id}`)).statusCode).toBe(404);
    expect((await call(s.alice, "GET", `${s.base}/requests?view=all`)).json().requests).toEqual([]);

    // Inbox: the lead triages new requests; Bob is not pinged while Treasury has a lead.
    const people = async (token: string) => (await call(token, "GET", `${s.base}/inbox`)).json().counts.people as number;
    expect(await people(s.tomas)).toBe(1);
    expect(await people(s.bob)).toBe(0);
    expect(await people(s.lucia)).toBe(0);
    const tomasBoard = (await call(s.tomas, "GET", `${s.base}/requests?view=team`)).json();
    expect(tomasBoard.requests.map((r: { id: string }) => r.id)).toEqual([req1.id]);
    expect(tomasBoard.counts.attention).toBe(1);

    // Tomas assigns it to Bob. Assigning outside the team is refused.
    expect((await call(s.tomas, "PATCH", `${s.base}/requests/${req1.id}`, { assignee_id: s.ids.lucia })).statusCode).toBe(400);
    expect((await call(s.lucia, "PATCH", `${s.base}/requests/${req1.id}`, { assignee_id: s.ids.bob })).statusCode).toBe(403);
    const assigned = await call(s.tomas, "PATCH", `${s.base}/requests/${req1.id}`, { assignee_id: s.ids.bob });
    expect(assigned.json().assignee.id).toBe(s.ids.bob);
    expect(await people(s.tomas)).toBe(0);
    expect(await people(s.bob)).toBe(1);

    // Bob needs something from Lucia: "waiting" requires saying what.
    expect((await call(s.bob, "PATCH", `${s.base}/requests/${req1.id}`, { status: "waiting" })).statusCode).toBe(400);
    const waiting = await call(s.bob, "PATCH", `${s.base}/requests/${req1.id}`, { status: "waiting", note: "Which account should the certificate cover?" });
    expect(waiting.json().status).toBe("waiting");
    expect(await people(s.lucia)).toBe(1);
    expect((await call(s.lucia, "GET", `${s.base}/requests?view=for_me`)).json().requests[0].my.attention).toBe(true);

    // Lucia answers; the request goes back to Treasury automatically.
    const reply = await call(s.lucia, "POST", `${s.base}/requests/${req1.id}/comments`, { body: "The operating account ending 4411." });
    expect(reply.json()).toEqual({ status: "in_progress" });
    expect(await people(s.lucia)).toBe(0);

    // The requester can't close the team's work, only cancel it; the team marks it done.
    expect((await call(s.lucia, "PATCH", `${s.base}/requests/${req1.id}`, { status: "done" })).statusCode).toBe(403);
    expect((await call(s.carol, "PATCH", `${s.base}/requests/${req1.id}`, { status: "done" })).statusCode).toBe(404);
    const done = (await call(s.bob, "PATCH", `${s.base}/requests/${req1.id}`, { status: "done", note: "Sent by email." })).json();
    expect(done).toMatchObject({ status: "done" });
    expect(done.closed_at).toBeTruthy();
    const reopened = (await call(s.lucia, "PATCH", `${s.base}/requests/${req1.id}`, { status: "open" })).json();
    expect(reopened).toMatchObject({ status: "open", closed_at: null });

    // Full timeline, in order, with who did what.
    const detail = (await call(s.tomas, "GET", `${s.base}/requests/${req1.id}`)).json();
    expect(detail.events.map((e: { kind: string }) => e.kind)).toEqual(["created", "assigned", "status", "comment", "status", "status", "status"]);
    expect(detail.events[2]).toMatchObject({ body: "Which account should the certificate cover?", data: { from: "open", to: "waiting" } });
    expect(detail.events[4].data).toMatchObject({ from: "waiting", to: "in_progress", auto: true });
    expect(detail.people[s.ids.bob]).toBeTruthy();
    expect(detail.assignees.map((a: { id: string }) => a.id).sort()).toEqual([s.ids.bob, s.ids.tomas].sort());
    expect(detail.comments).toBe(1);

    // When Bob leaves Treasury his open requests go back to the team's queue, even though the admin removing him
    // can't read them.
    await call(s.tomas, "PATCH", `${s.base}/requests/${req1.id}`, { assignee_id: s.ids.bob });
    expect((await call(s.alice, "DELETE", `${s.base}/teams/${treasury.id}/members/${s.ids.bob}`)).statusCode).toBe(204);
    const after = (await call(s.tomas, "GET", `${s.base}/requests/${req1.id}`)).json();
    expect(after.assignee).toBeNull();
    expect(after.events.at(-1)).toMatchObject({ kind: "assigned", data: { from: s.ids.bob, to: null, reason: "left_team" } });
    expect((await call(s.bob, "GET", `${s.base}/requests/${req1.id}`)).statusCode).toBe(404);
    expect((await call(s.alice, "GET", `${s.base}/requests/${req1.id}`)).statusCode).toBe(404);
  });

  it("guards who can ask on behalf of whom and numbers requests per organization", async () => {
    const s = await setup("guards");
    const legal = (await call(s.alice, "POST", `${s.base}/teams`, { name: "Legal", lead_user_id: s.ids.lucia })).json();
    const treasury = (await call(s.alice, "POST", `${s.base}/teams`, { name: "Treasury" })).json();
    await call(s.alice, "PUT", `${s.base}/teams/${treasury.id}/members/${s.ids.bob}`, {});

    // Viewers read; they don't file requests.
    expect((await call(s.victor, "POST", `${s.base}/requests`, { to_team_id: treasury.id, title: "Can I see the budget?" })).statusCode).toBe(403);
    // You can't speak for a team you're not in.
    expect((await call(s.lucia, "POST", `${s.base}/requests`, { to_team_id: legal.id, from_team_id: treasury.id, title: "Review this NDA" })).statusCode).toBe(403);

    // Carol has no team: her request comes from no team, and she still follows it.
    const a = (await call(s.carol, "POST", `${s.base}/requests`, { to_team_id: treasury.id, title: "Reimburse my travel" })).json();
    expect(a).toMatchObject({ number: 1, from_team: null });
    // A team without a lead: every member triages.
    expect((await call(s.bob, "GET", `${s.base}/inbox`)).json().counts).toMatchObject({ people: 1 });
    const b = (await call(s.bob, "POST", `${s.base}/requests`, { to_team_id: legal.id, title: "Review the supplier NDA" })).json();
    expect(b).toMatchObject({ number: 2, from_team: { name: "Treasury" } });

    // Archived teams stop taking requests.
    expect((await call(s.lucia, "PATCH", `${s.base}/teams/${treasury.id}`, { archived: true })).statusCode).toBe(403);
    expect((await call(s.alice, "PATCH", `${s.base}/teams/${treasury.id}`, { archived: true })).statusCode).toBe(200);
    expect((await call(s.carol, "POST", `${s.base}/requests`, { to_team_id: treasury.id, title: "Another reimbursement" })).statusCode).toBe(400);

    // Suggestions skip what already exists.
    const dir = (await call(s.alice, "GET", `${s.base}/teams`)).json();
    expect(dir.suggestions.map((x: { name: string }) => x.name)).not.toContain("Legal");
    expect(dir.suggestions.map((x: { name: string }) => x.name)).toContain("People");

    // Renaming a team renames its space, so the workspace switcher stays recognisable.
    expect((await call(s.alice, "PATCH", `${s.base}/teams/${legal.id}`, { name: "Legal & Compliance" })).statusCode).toBe(200);
    const spaces = (await call(s.lucia, "GET", `${s.base}/workspaces`)).json().workspaces;
    expect(spaces.map((w: { name: string }) => w.name)).toEqual(["Legal & Compliance"]);

    // Requests are invisible across organizations even with a guessed id.
    const other = await setup("guards-other");
    expect((await call(other.alice, "GET", `${other.base}/requests/${a.id}`)).statusCode).toBe(404);
  });

  it("keeps the database boundary even if the API forgot a check", async () => {
    const s = await setup("rls");
    const treasury = (await call(s.alice, "POST", `${s.base}/teams`, { name: "Treasury" })).json();
    await call(s.alice, "PUT", `${s.base}/teams/${treasury.id}/members/${s.ids.bob}`, {});
    const r = (await call(s.carol, "POST", `${s.base}/requests`, { to_team_id: treasury.id, title: "Pay supplier invoice 88" })).json();
    // The assignee must belong to the receiving team, whatever the caller sends.
    await expect(owner.query("UPDATE team_requests SET assignee_id = $1 WHERE id = $2", [s.ids.lucia, r.id])).rejects.toThrow(/assignee is not in the receiving team/);
    // Who asked whom is fixed once filed.
    await expect(owner.query("UPDATE team_requests SET requested_by = $1 WHERE id = $2", [s.ids.lucia, r.id])).rejects.toThrow(/cannot change/);
  });
});
