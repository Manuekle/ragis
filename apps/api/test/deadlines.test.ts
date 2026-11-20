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
import type { DeadlineReminder } from "../src/lib/deadline-email.js";
import { reminderText } from "../src/lib/deadline-email.js";
import { sendDeadlineReminders } from "../src/lib/deadline-reminders.js";
import { addDays, todayIn } from "../src/lib/deadlines.js";
import type { RagClient } from "../src/routes/query.js";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const env = Object.fromEntries(
  readFileSync(path.join(ROOT, ".env"), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const PORT = process.env.POSTGRES_HOST_PORT ?? "55432";
const DB = "ragsis_deadlines_test";

const storage = { presignPut: async () => "", presignGet: async () => "", head: async () => null, delete: async () => undefined, put: async () => undefined, get: async () => null } as Storage;
const sent: unknown[] = [];
const queue: Queue = { send: async (m: unknown) => void sent.push(m) };
const rag: RagClient = { query: async () => ({ status: 200, body: {} }) };
const mail: DeadlineReminder[] = [];

let app: FastifyInstance;
let pool: pg.Pool;
let owner: pg.Client;
let deps: Parameters<typeof sendDeadlineReminders>[0];

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
 * Socia owns the firm (editor of the litigation space). Asociado is an editor there; Lectora reads it; Externo is a
 * member with no access to the space; Visor is an org viewer.
 */
async function setup(tag: string) {
  const people = ["socia", "asociado", "lectora", "externo", "visor"] as const;
  const tokens = Object.fromEntries(await Promise.all(people.map(async (p) => [p, await login(`${p}@${tag}.test`)]))) as Record<(typeof people)[number], string>;
  const org = (await call(tokens.socia, "POST", "/v1/organizations", { name: `Firma ${tag}` })).json();
  const ws = org.default_workspace_id as string;
  const ids: Record<string, string> = { socia: (await call(tokens.socia, "GET", "/v1/me")).json().user.id };
  for (const p of people.slice(1)) {
    const r = await call(tokens.socia, "POST", `/v1/organizations/${org.id}/members`, { email: `${p}@${tag}.test`, role: p === "visor" ? "viewer" : "member" });
    expect(r.statusCode).toBe(201);
    ids[p] = r.json().user_id;
  }
  for (const [p, role] of [["asociado", "editor"], ["lectora", "reader"], ["visor", "reader"]] as const) {
    await call(tokens.socia, "POST", `/v1/organizations/${org.id}/workspaces/${ws}/members`, { user_id: ids[p], role });
  }
  // An indexed court document with one candidate, as the ingest worker leaves it.
  const doc = randomUUID();
  const ver = randomUUID();
  await owner.query("INSERT INTO documents (id, organization_id, workspace_id, title) VALUES ($1,$2,$3,'Auto admisorio')", [doc, org.id, ws]);
  await owner.query("INSERT INTO document_acl (document_id, organization_id, principal) VALUES ($1,$2,$3)", [doc, org.id, `workspace:${ws}`]);
  await owner.query(
    `INSERT INTO document_versions (id, organization_id, document_id, version_no, filename, content_type, declared_size, s3_key, status, is_current)
     VALUES ($1,$2,$3,1,'auto.pdf','application/pdf',10,'k','indexed',true)`,
    [ver, org.id, doc],
  );
  await owner.query("UPDATE documents SET current_version_id = $2 WHERE id = $1", [doc, ver]);
  const candidate = async (quote: string, amount = 10) =>
    (
      await owner.query(
        `INSERT INTO deadline_candidates (organization_id, workspace_id, document_id, version_id, page, quote, amount, unit, unit_assumed,
                                          trigger_hint, legal_basis, title, fingerprint)
         VALUES ($1,$2,$3,$4,2,$5,$6,'business_days',true,'notification','art. 369 del CGP','Traslado',$7) RETURNING id`,
        [org.id, ws, doc, ver, quote, amount, randomUUID()],
      )
    ).rows[0].id as string;
  return { ...tokens, ids, org: org.id as string, ws, doc, ver, candidate, base: `/v1/organizations/${org.id}` };
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
    INTERNAL_SERVICE_SECRET: "deadlines-test-internal-secret-0123456789abcdef",
    AUTH_MODE: "dev",
    JWT_DEV_SECRET: "dev-secret-for-tests-0123456789abcdefghij",
    RAGSIS_ENV: "test",
  });
  pool = createPool(cfg.DATABASE_URL);
  const deadlineMailer = async (r: DeadlineReminder) => void mail.push(r);
  app = await buildApp({ cfg, pool, storage, queue, rag, deadlineMailer, disableBackgroundJobs: true });
  deps = { cfg, pool, storage, queue, rag, deadlineMailer } as unknown as typeof deps;
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await owner?.end();
});

describe("holidays", () => {
  it("loads Colombian holidays from the migration", async () => {
    const r = await owner.query("SELECT day::text, name FROM public_holidays WHERE country='co' AND day BETWEEN '2026-01-01' AND '2026-12-31' ORDER BY day");
    expect(r.rows).toHaveLength(18);
    expect(r.rows.map((x) => x.day)).toEqual(expect.arrayContaining(["2026-03-23", "2026-04-02", "2026-04-03", "2026-05-18", "2026-11-16"]));
  });
});

describe("confirming candidates", () => {
  it("turns a candidate into a deadline with the citation from the candidate and records who confirmed it", async () => {
    const s = await setup("confirm");
    const cid = await s.candidate("Córrase traslado por el término de diez (10) días.");
    const list = await call(s.asociado, "GET", `${s.base}/deadline-candidates`);
    expect(list.statusCode).toBe(200);
    const [c] = list.json().candidates;
    expect(c).toMatchObject({ id: cid, page: 2, document_title: "Auto admisorio", can_confirm: true, unit_assumed: true });

    // The client cannot supply its own citation.
    const forged = await call(s.asociado, "POST", `${s.base}/deadlines`, {
      candidate_id: cid, title: "Contestar", trigger_date: "2026-11-13", unit: "business_days", amount: 10, responsible_id: s.ids.asociado, quote: "otra cosa",
    });
    expect(forged.statusCode).toBe(400);

    const r = await call(s.asociado, "POST", `${s.base}/deadlines`, {
      candidate_id: cid, title: "Contestar la demanda", trigger_kind: "notification", trigger_date: "2026-11-13", unit: "business_days", amount: 10,
      legal_basis: "art. 369 CGP", responsible_id: s.ids.asociado,
    });
    expect(r.statusCode).toBe(201);
    const d = r.json();
    // Friday 13 Nov; Monday 16 is a holiday: 10 business days from Tuesday 17 -> 30 Nov.
    expect(d).toMatchObject({ due_on: "2026-11-30", page: 2, quote: "Córrase traslado por el término de diez (10) días.", document_id: s.doc, workspace_id: s.ws });
    expect(d.computation.skipped).toEqual([{ day: "2026-11-16", reason: "holiday", name: "Independencia de Cartagena" }]);
    expect(d.confirmed_by).toBe(s.ids.asociado);

    const again = await call(s.socia, "POST", `${s.base}/deadlines`, {
      candidate_id: cid, title: "Otra vez", trigger_date: "2026-11-13", unit: "business_days", amount: 10, responsible_id: s.ids.socia,
    });
    expect(again.statusCode).toBe(409);
    const confirmed = (await call(s.asociado, "GET", `${s.base}/deadline-candidates?status=confirmed`)).json().candidates;
    expect(confirmed[0]).toMatchObject({ id: cid, deadline_id: d.id, decided_by_email: "asociado@confirm.test" });
    const audit = await owner.query("SELECT action FROM audit_events WHERE organization_id=$1 AND resource=$2", [s.org, `deadline:${d.id}`]);
    expect(audit.rows.map((x) => x.action)).toEqual(["deadline.confirmed"]);
  });

  it("lets readers see candidates but not confirm or dismiss them; viewers cannot confirm either", async () => {
    const s = await setup("readers");
    const cid = await s.candidate("Plazo de cinco días para subsanar.", 5);
    expect((await call(s.lectora, "GET", `${s.base}/deadline-candidates`)).json().candidates[0].can_confirm).toBe(false);
    const body = { candidate_id: cid, title: "Subsanar", trigger_date: "2026-11-13", unit: "business_days", amount: 5, responsible_id: s.ids.lectora };
    expect((await call(s.lectora, "POST", `${s.base}/deadlines`, body)).statusCode).toBe(403);
    expect((await call(s.visor, "POST", `${s.base}/deadlines`, body)).statusCode).toBe(403);
    expect((await call(s.lectora, "POST", `${s.base}/deadline-candidates/${cid}/dismiss`)).statusCode).toBe(403);
    // Someone who cannot read the document does not see its candidates.
    expect((await call(s.externo, "GET", `${s.base}/deadline-candidates`)).json().candidates).toEqual([]);
    expect((await call(s.externo, "POST", `${s.base}/deadline-candidates/${cid}/dismiss`)).statusCode).toBe(404);
    const dismissed = await call(s.asociado, "POST", `${s.base}/deadline-candidates/${cid}/dismiss`);
    expect(dismissed.json()).toEqual({ id: cid, status: "dismissed" });
    expect((await call(s.asociado, "POST", `${s.base}/deadline-candidates/${cid}/dismiss`)).statusCode).toBe(409);
  });

  it("rejects a responsible person outside the firm and bad term shapes", async () => {
    const s = await setup("shapes");
    const base = { workspace_id: s.ws, title: "Audiencia", trigger_date: "2026-11-20", responsible_id: s.ids.socia };
    expect((await call(s.socia, "POST", `${s.base}/deadlines`, { ...base, unit: "fixed", amount: 3 })).statusCode).toBe(400);
    expect((await call(s.socia, "POST", `${s.base}/deadlines`, { ...base, unit: "business_days" })).statusCode).toBe(400);
    expect((await call(s.socia, "POST", `${s.base}/deadlines`, { ...base, unit: "fixed", responsible_id: randomUUID() })).statusCode).toBe(400);
    const fixed = await call(s.socia, "POST", `${s.base}/deadlines`, { ...base, unit: "fixed" });
    expect(fixed.statusCode).toBe(201);
    expect(fixed.json()).toMatchObject({ due_on: "2026-11-20", amount: null, document_id: null, quote: null });
  });
});

describe("visibility and changes", () => {
  it("shows a deadline to its workspace and to the responsible person only", async () => {
    const s = await setup("visibility");
    const d = (await call(s.socia, "POST", `${s.base}/deadlines`, {
      workspace_id: s.ws, title: "Alegatos de conclusión", trigger_date: "2026-11-13", unit: "business_days", amount: 5, responsible_id: s.ids.socia,
    })).json();
    expect((await call(s.lectora, "GET", `${s.base}/deadlines/${d.id}`)).statusCode).toBe(200);
    expect((await call(s.externo, "GET", `${s.base}/deadlines/${d.id}`)).statusCode).toBe(404);
    expect((await call(s.externo, "GET", `${s.base}/deadlines`)).json().deadlines).toEqual([]);
    // Reassigned to Externo: now they see it (and can mark it done), though they are not in the space.
    const moved = await call(s.socia, "PATCH", `${s.base}/deadlines/${d.id}`, { responsible_id: s.ids.externo });
    expect(moved.statusCode).toBe(200);
    expect((await call(s.externo, "GET", `${s.base}/deadlines?mine=1`)).json().deadlines.map((x: { id: string }) => x.id)).toEqual([d.id]);
    // A reader of the space cannot change it.
    expect((await call(s.lectora, "PATCH", `${s.base}/deadlines/${d.id}`, { status: "done" })).statusCode).toBe(403);
    const done = await call(s.externo, "PATCH", `${s.base}/deadlines/${d.id}`, { status: "done" });
    expect(done.json()).toMatchObject({ status: "done", state: "done", closed_by: s.ids.externo });
    const reopened = await call(s.socia, "PATCH", `${s.base}/deadlines/${d.id}`, { status: "pending" });
    expect(reopened.json()).toMatchObject({ status: "pending", closed_at: null });
    const detail = (await call(s.socia, "GET", `${s.base}/deadlines/${d.id}`)).json();
    expect(detail.events.map((e: { kind: string }) => e.kind)).toEqual(["confirmed", "updated", "done", "reopened"]);
  });

  it("recomputes the due date when the term changes and lists by urgency", async () => {
    const s = await setup("urgency");
    const today = todayIn("co");
    const mk = (title: string, trigger: string, amount: number) =>
      call(s.socia, "POST", `${s.base}/deadlines`, { workspace_id: s.ws, title, trigger_date: trigger, unit: "calendar_days", amount, responsible_id: s.ids.socia });
    const late = (await mk("Vencido", addDays(today, -20), 5)).json();
    await mk("Esta semana", addDays(today, -1), 3);
    await mk("Este mes", today, 25);
    const list = (await call(s.socia, "GET", `${s.base}/deadlines`)).json();
    expect(list.deadlines[0]).toMatchObject({ id: late.id, state: "overdue" });
    expect(list.counts.overdue).toBe(1);
    expect(list.counts.open).toBe(3);
    expect((await call(s.socia, "GET", `${s.base}/deadlines?view=overdue`)).json().deadlines).toHaveLength(1);
    const changed = await call(s.socia, "PATCH", `${s.base}/deadlines/${late.id}`, { trigger_date: today, amount: 40 });
    expect(changed.json().due_on > today).toBe(true);
    expect(changed.json().state).not.toBe("overdue");
  });
});

describe("firm calendar", () => {
  it("lets admins add court closures, which recompute pending deadlines", async () => {
    const s = await setup("closures");
    const d = (await call(s.asociado, "POST", `${s.base}/deadlines`, {
      workspace_id: s.ws, title: "Recurso de apelación", trigger_date: "2026-12-18", unit: "business_days", amount: 3, responsible_id: s.ids.asociado,
    })).json();
    expect(d.due_on).toBe("2026-12-23");
    const cal = (await call(s.asociado, "GET", `${s.base}/deadline-calendar?year=2026`)).json();
    expect(cal).toMatchObject({ country: "co", can_edit: false });
    expect(cal.suggestions.map((x: { label: string }) => x.label)).toEqual(["Semana Santa 2026", "Vacancia judicial 2026-2027"]);
    const vacancy = cal.suggestions[1];
    expect((await call(s.asociado, "POST", `${s.base}/court-closures`, vacancy)).statusCode).toBe(403);
    // Recomputation reaches every pending deadline of the firm, whoever adds the closure.
    const added = await call(s.socia, "POST", `${s.base}/court-closures`, vacancy);
    expect(added.statusCode).toBe(201);
    expect(added.json().recomputed).toBe(1);
    const after = (await call(s.asociado, "GET", `${s.base}/deadlines/${d.id}`)).json();
    expect(after.due_on).toBe("2027-01-14");
    expect(after.events.at(-1)).toMatchObject({ kind: "recomputed", data: { from: "2026-12-23", to: "2027-01-14" } });
    expect((await call(s.socia, "GET", `${s.base}/deadline-calendar?year=2026`)).json().suggestions).toHaveLength(1);
    const removed = await call(s.socia, "DELETE", `${s.base}/court-closures/${added.json().id}`);
    expect(removed.json().recomputed).toBe(1);
    expect((await call(s.socia, "PUT", `${s.base}/deadline-calendar`, { holiday_country: "zz" })).statusCode).toBe(400);
  });
});

describe("calendar export, inbox and reminders", () => {
  it("exports .ics, counts urgent deadlines in the Inbox and sends each reminder once", async () => {
    const s = await setup("remind");
    const today = todayIn("co");
    const d = (await call(s.asociado, "POST", `${s.base}/deadlines`, {
      workspace_id: s.ws, title: "Contestar la demanda", trigger_date: today, unit: "fixed", legal_basis: "art. 96 CGP", responsible_id: s.ids.asociado,
    })).json();
    const ics = await call(s.asociado, "GET", `${s.base}/deadlines/${d.id}/calendar.ics`);
    expect(ics.headers["content-type"]).toContain("text/calendar");
    expect(ics.body).toContain(`DTSTART;VALUE=DATE:${today.replace(/-/g, "")}`);
    expect(ics.body).toContain("SUMMARY:Vence: Contestar la demanda");
    const feed = await call(s.asociado, "GET", `${s.base}/deadlines/calendar.ics?mine=1`);
    expect(feed.body.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect((await call(s.externo, "GET", `${s.base}/deadlines/calendar.ics`)).body).not.toContain("BEGIN:VEVENT");

    await s.candidate("Término de tres días.", 3);
    const inbox = (await call(s.asociado, "GET", `${s.base}/inbox`)).json();
    expect(inbox.counts).toMatchObject({ deadlines: 1, candidates: 1 });
    expect((await call(s.lectora, "GET", `${s.base}/inbox`)).json().counts).toMatchObject({ deadlines: 0, candidates: 0 });

    // Noon in Bogotá today: the "due" reminder goes out once to the responsible lawyer.
    const noon = new Date(`${today}T17:00:00Z`);
    mail.length = 0;
    await sendDeadlineReminders(deps, noon);
    const mine = mail.filter((m) => m.title === "Contestar la demanda" && m.to === "asociado@remind.test");
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ kind: "due", dueOn: today, legalBasis: "art. 96 CGP" });
    expect(reminderText(mine[0]!).subject).toBe("Ragis · Término vence hoy: Contestar la demanda");
    mail.length = 0;
    await sendDeadlineReminders(deps, noon);
    expect(mail.filter((m) => m.title === "Contestar la demanda")).toHaveLength(0);
    const detail = (await call(s.asociado, "GET", `${s.base}/deadlines/${d.id}`)).json();
    expect(detail.reminders).toMatchObject([{ kind: "due", recipient: "asociado@remind.test" }]);
    // Before 7:00 in Bogotá nothing goes out.
    await owner.query("DELETE FROM deadline_reminders WHERE deadline_id=$1", [d.id]);
    mail.length = 0;
    await sendDeadlineReminders(deps, new Date(`${today}T10:00:00Z`));
    expect(mail.filter((m) => m.title === "Contestar la demanda")).toHaveLength(0);
  });

  it("queues a candidate rescan for an indexed document", async () => {
    const s = await setup("rescan");
    sent.length = 0;
    const r = await call(s.asociado, "POST", `${s.base}/documents/${s.doc}/deadline-scan`);
    expect(r.statusCode).toBe(202);
    expect(sent).toEqual([expect.objectContaining({ kind: "reindex", document_id: s.doc, version_id: s.ver })]);
    const job = await owner.query("SELECT params FROM ingestion_jobs WHERE id=$1", [r.json().job_id]);
    expect(job.rows[0].params).toEqual({ mode: "deadlines" });
    expect((await call(s.lectora, "POST", `${s.base}/documents/${s.doc}/deadline-scan`)).statusCode).toBe(403);
  });
});
