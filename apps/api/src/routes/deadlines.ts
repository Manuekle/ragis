import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../app.js";
import type { Db } from "../db/pool.js";
import {
  DEADLINE_STATUSES,
  TRIGGER_KINDS,
  UNITS,
  addDays,
  computeDueDate,
  daysBetween,
  isIsoDate,
  addWorkingDays,
  isWorkingDay,
  loadCalendar,
  suggestedClosures,
  toIcs,
  todayIn,
  type Calendar,
  type Computation,
  type TermInput,
  type Unit,
} from "../lib/deadlines.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { assertUuid, audit, isAdmin, requireAdmin, requireWorkspaceWrite, tx, type TenantContext } from "../lib/tenant.js";

/**
 * Procedural deadlines ("términos", ADR-038).
 *
 * The ingest worker proposes candidates with the literal sentence and page they come from; a person confirms each one
 * here (with the date it runs from and who is responsible), and only then is it a deadline. The due date is always
 * computed on the server from the firm's calendar (country holidays + court closures) and stored with its breakdown.
 * Visibility is enforced by RLS (migration 0023): members of the deadline's workspace and the person responsible.
 * No route declares scopes, so service API keys cannot reach any of this.
 */

const DATE = z.string().refine(isIsoDate, "expected a date YYYY-MM-DD");
const Term = {
  trigger_kind: z.enum(TRIGGER_KINDS).default("notification"),
  trigger_date: DATE,
  notice_by_email: z.boolean().default(false),
  unit: z.enum(UNITS),
  amount: z.number().int().min(1).max(3650).nullable().default(null),
};
const Preview = z.object({ trigger_date: DATE, unit: z.enum(UNITS), amount: Term.amount, notice_by_email: Term.notice_by_email }).strict();
const CreateDeadline = z
  .object({
    candidate_id: z.string().uuid().optional(),
    workspace_id: z.string().uuid().optional(),
    title: z.string().trim().min(3).max(200),
    ...Term,
    legal_basis: z.string().trim().max(300).default(""),
    responsible_id: z.string().uuid(),
    notes: z.string().trim().max(4000).default(""),
  })
  .strict();
const UpdateDeadline = z
  .object({
    title: z.string().trim().min(3).max(200).optional(),
    trigger_kind: z.enum(TRIGGER_KINDS).optional(),
    trigger_date: DATE.optional(),
    notice_by_email: z.boolean().optional(),
    unit: z.enum(UNITS).optional(),
    amount: z.number().int().min(1).max(3650).nullable().optional(),
    legal_basis: z.string().trim().max(300).optional(),
    responsible_id: z.string().uuid().optional(),
    notes: z.string().trim().max(4000).optional(),
    status: z.enum(DEADLINE_STATUSES).optional(),
  })
  .strict();
const ListQuery = z.object({
  view: z.enum(["open", "overdue", "week", "month", "done", "all"]).default("open"),
  mine: z.enum(["1", "0", "true", "false"]).optional(),
  workspace_id: z.string().uuid().optional(),
});
const CandidateQuery = z.object({ status: z.enum(["proposed", "confirmed", "dismissed", "all"]).default("proposed"), document_id: z.string().uuid().optional() });
const ClosureBody = z.object({ starts_on: DATE, ends_on: DATE, label: z.string().trim().min(1).max(120) }).strict();
const CalendarBody = z.object({ holiday_country: z.string().regex(/^[a-z]{2}$/) }).strict();

const DEADLINE_SQL = `
  SELECT d.id, d.workspace_id, w.name AS workspace_name, d.title, d.trigger_kind, d.trigger_date::text AS trigger_date,
         d.notice_by_email, d.unit, d.amount, d.due_on::text AS due_on, d.computation, d.legal_basis,
         d.responsible_id, ru.email AS responsible_email, ru.display_name AS responsible_name, d.status, d.notes,
         d.document_id, doc.title AS document_title, d.version_id, d.page, d.quote,
         d.confirmed_by, cu.email AS confirmed_by_email, cu.display_name AS confirmed_by_name, d.confirmed_at,
         d.closed_by, xu.email AS closed_by_email, d.closed_at, d.created_at, d.updated_at,
         (SELECT c.chunk_id FROM deadline_candidates c WHERE c.deadline_id = d.id LIMIT 1) AS chunk_id
    FROM deadlines d
    JOIN workspaces w ON w.id = d.workspace_id
    LEFT JOIN users ru ON ru.id = d.responsible_id
    LEFT JOIN users cu ON cu.id = d.confirmed_by
    LEFT JOIN users xu ON xu.id = d.closed_by
    LEFT JOIN documents doc ON doc.id = d.document_id`;

interface DeadlineRow {
  id: string;
  workspace_id: string;
  title: string;
  trigger_kind: string;
  trigger_date: string;
  notice_by_email: boolean;
  unit: Unit;
  amount: number | null;
  due_on: string;
  legal_basis: string;
  responsible_id: string;
  responsible_email: string | null;
  status: string;
  notes: string;
  document_title: string | null;
  page: number | null;
  quote: string | null;
  [key: string]: unknown;
}

/** Days left, in working days for what is ahead and calendar days for what is overdue. */
function standing(cal: Calendar, today: string, d: Pick<DeadlineRow, "status" | "due_on">) {
  if (d.status !== "pending") return { state: d.status, days_left: null as number | null };
  if (d.due_on < today) return { state: "overdue", days_left: -daysBetween(d.due_on, today) };
  if (d.due_on === today) return { state: "today", days_left: 0 };
  let n = 0;
  for (let day = addDays(today, 1); day <= d.due_on && n < 400; day = addDays(day, 1)) if (isWorkingDay(cal, day)) n++;
  return { state: daysBetween(today, d.due_on) <= 7 ? "soon" : "upcoming", days_left: n };
}

const present = (cal: Calendar, today: string) => (d: DeadlineRow) => ({ ...d, ...standing(cal, today, d) });

function canEdit(t: TenantContext, d: Pick<DeadlineRow, "workspace_id" | "responsible_id">): boolean {
  if (t.role === "viewer") return false;
  if (d.responsible_id === t.userId) return true;
  const access = t.workspaces.get(d.workspace_id);
  return access === "editor" || (access !== undefined && isAdmin(t));
}

function compute(input: TermInput, cal: Calendar): Computation {
  if ((input.unit === "fixed") !== (input.amount === null)) {
    throw badRequest(input.unit === "fixed" ? "a fixed date takes no amount" : "amount is required for this unit");
  }
  return computeDueDate(input, cal);
}

/** Integrity triggers (migration 0023) raise 23514 for a responsible person outside the firm and similar. */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if ((error as { code?: string }).code === "23514") throw badRequest((error as Error).message);
    throw error;
  }
}

async function loadDeadline(db: Db, id: string): Promise<DeadlineRow> {
  assertUuid(id, "deadline");
  const row = (await db.query(`${DEADLINE_SQL} WHERE d.id = $1`, [id])).rows[0] as DeadlineRow | undefined;
  if (!row) throw notFound("deadline");
  return row;
}

/** Pending deadlines that need the user now (Inbox): theirs, overdue or due within two working days. */
export async function deadlineAttention(db: Db, t: TenantContext): Promise<{ deadlines: number; candidates: number }> {
  const cal = await loadCalendar(db, t.organizationId);
  const limit = addWorkingDays(cal, todayIn(cal.country), 2);
  const mine = (
    await db.query("SELECT count(*)::int AS n FROM deadlines WHERE status = 'pending' AND responsible_id = $1 AND due_on <= $2", [t.userId, limit])
  ).rows[0].n as number;
  const editable = [...t.workspaces.entries()].filter(([, a]) => a === "editor" || isAdmin(t)).map(([w]) => w);
  const candidates = t.role === "viewer" || !editable.length
    ? 0
    : ((await db.query("SELECT count(*)::int AS n FROM deadline_candidates WHERE status = 'proposed' AND workspace_id = ANY($1::uuid[])", [editable])).rows[0].n as number);
  return { deadlines: mine, candidates };
}

/** Recomputes every pending deadline of the tenant after its calendar changed. Returns how many moved. */
async function recomputeAll(db: Db, organizationId: string, reason: string): Promise<number> {
  const cal = await loadCalendar(db, organizationId);
  const rows = (await db.query("SELECT id, trigger_date::text AS trigger_date, notice_by_email, unit, amount, due_on::text AS due_on FROM app.pending_deadline_terms()")).rows as
    (TermInput & { id: string; due_on: string })[];
  let moved = 0;
  for (const r of rows) {
    const c = computeDueDate(r, cal);
    if (c.due_on === r.due_on) continue;
    const res = await db.query("SELECT app.recompute_deadline($1, $2, $3::jsonb, $4) AS moved", [r.id, c.due_on, JSON.stringify(c), reason]);
    if (res.rows[0].moved) moved++;
  }
  return moved;
}

export async function deadlineRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { pool, queue } = deps;
  const base = "/v1/organizations/:org";
  const webUrl = (org: string, id?: string) => `${deps.cfg.PUBLIC_BASE_URL.replace(/\/$/, "")}/app/${org}/deadlines${id ? `?d=${id}` : ""}`;

  // ---------------------------------------------------------------- deadlines
  app.get(`${base}/deadlines`, async (req) => {
    const t = req.tenant!;
    const q = ListQuery.parse(req.query);
    if (q.workspace_id) assertUuid(q.workspace_id, "workspace");
    return tx(pool, t, async (db) => {
      const cal = await loadCalendar(db, t.organizationId);
      const today = todayIn(cal.country);
      const where: string[] = [];
      const args: unknown[] = [];
      const arg = (v: unknown) => `$${args.push(v)}`;
      if (q.mine === "1" || q.mine === "true") where.push(`d.responsible_id = ${arg(t.userId)}`);
      if (q.workspace_id) where.push(`d.workspace_id = ${arg(q.workspace_id)}`);
      const scope = [...where];
      if (q.view === "open") where.push("d.status = 'pending'");
      if (q.view === "overdue") where.push(`d.status = 'pending' AND d.due_on < ${arg(today)}`);
      if (q.view === "week") where.push(`d.status = 'pending' AND d.due_on BETWEEN ${arg(today)} AND ${arg(addDays(today, 7))}`);
      if (q.view === "month") where.push(`d.status = 'pending' AND d.due_on BETWEEN ${arg(today)} AND ${arg(addDays(today, 30))}`);
      if (q.view === "done") where.push("d.status IN ('done', 'cancelled')");
      const order = q.view === "done" ? "d.closed_at DESC" : "d.status = 'pending' DESC, d.due_on, d.created_at";
      const rows = (await db.query(`${DEADLINE_SQL} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ${order} LIMIT 500`, args)).rows as DeadlineRow[];
      const countArgs = args.slice(0, scope.length);
      const c = (
        await db.query(
          `SELECT count(*) FILTER (WHERE d.status = 'pending' AND d.due_on < $${countArgs.length + 1})::int AS overdue,
                  count(*) FILTER (WHERE d.status = 'pending' AND d.due_on BETWEEN $${countArgs.length + 1} AND $${countArgs.length + 2})::int AS week,
                  count(*) FILTER (WHERE d.status = 'pending' AND d.due_on BETWEEN $${countArgs.length + 1} AND $${countArgs.length + 3})::int AS month,
                  count(*) FILTER (WHERE d.status = 'pending')::int AS open
             FROM deadlines d ${scope.length ? `WHERE ${scope.join(" AND ")}` : ""}`,
          [...countArgs, today, addDays(today, 7), addDays(today, 30)],
        )
      ).rows[0];
      const candidates = (await db.query("SELECT count(*)::int AS n FROM deadline_candidates WHERE status = 'proposed'")).rows[0].n as number;
      return {
        today,
        country: cal.country,
        reminders_enabled: Boolean(deps.deadlineMailer),
        counts: { ...c, candidates },
        deadlines: rows.map(present(cal, today)).map((d) => ({ ...d, can_edit: canEdit(t, d) })),
      };
    });
  });

  app.post(`${base}/deadlines/preview`, async (req) => {
    const t = req.tenant!;
    const body = Preview.parse(req.body);
    return tx(pool, t, async (db) => {
      const cal = await loadCalendar(db, t.organizationId);
      return { computation: compute(body, cal), today: todayIn(cal.country), country: cal.country };
    });
  });

  // Confirm a candidate (citation comes from the candidate, never from the client) or enter a deadline by hand.
  app.post(`${base}/deadlines`, async (req, reply) => {
    const t = req.tenant!;
    const body = CreateDeadline.parse(req.body);
    const created = await tx(pool, t, async (db) => {
      let cite: { workspace_id: string; document_id: string | null; version_id: string | null; page: number | null; quote: string | null } = {
        workspace_id: body.workspace_id ?? "", document_id: null, version_id: null, page: null, quote: null,
      };
      if (body.candidate_id) {
        const c = (await db.query("SELECT * FROM deadline_candidates WHERE id = $1 FOR UPDATE", [body.candidate_id])).rows[0];
        if (!c) throw notFound("candidate");
        if (c.status !== "proposed") throw conflict(`this candidate is already ${c.status}`);
        cite = { workspace_id: c.workspace_id, document_id: c.document_id, version_id: c.version_id, page: c.page, quote: c.quote };
      } else if (!body.workspace_id) {
        throw badRequest("workspace_id is required for a deadline entered by hand");
      }
      requireWorkspaceWrite(t, cite.workspace_id);
      const cal = await loadCalendar(db, t.organizationId);
      const computation = compute(body, cal);
      const id = randomUUID();
      await guard(() =>
        db.query(
          `INSERT INTO deadlines (id, organization_id, workspace_id, title, trigger_kind, trigger_date, notice_by_email, unit, amount,
                                  due_on, computation, legal_basis, responsible_id, notes, document_id, version_id, page, quote, confirmed_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17,$18,$19)`,
          [id, t.organizationId, cite.workspace_id, body.title, body.trigger_kind, body.trigger_date, body.notice_by_email, body.unit,
           body.unit === "fixed" ? null : body.amount, computation.due_on, JSON.stringify(computation), body.legal_basis,
           body.responsible_id, body.notes, cite.document_id, cite.version_id, cite.page, cite.quote, t.userId],
        ),
      );
      if (body.candidate_id) {
        await db.query("UPDATE deadline_candidates SET status = 'confirmed', deadline_id = $2, decided_by = $3, decided_at = now() WHERE id = $1", [
          body.candidate_id, id, t.userId,
        ]);
      }
      await db.query("INSERT INTO deadline_events (deadline_id, organization_id, actor_id, kind, data) VALUES ($1,$2,$3,'confirmed',$4::jsonb)", [
        id, t.organizationId, t.userId, JSON.stringify({ due_on: computation.due_on, candidate_id: body.candidate_id ?? null }),
      ]);
      await audit(db, t, "deadline.confirmed", `deadline:${id}`, "allow", {
        candidate_id: body.candidate_id ?? null, document_id: cite.document_id, due_on: computation.due_on, responsible_id: body.responsible_id,
      });
      return present(cal, todayIn(cal.country))(await loadDeadline(db, id));
    });
    reply.code(201);
    return created;
  });

  app.get(`${base}/deadlines/calendar.ics`, async (req, reply) => {
    const t = req.tenant!;
    const q = z.object({ mine: z.enum(["1", "0", "true", "false"]).optional() }).parse(req.query);
    const mine = q.mine === "1" || q.mine === "true";
    const rows = await tx(pool, t, async (db) =>
      (await db.query(`${DEADLINE_SQL} WHERE d.status = 'pending' ${mine ? "AND d.responsible_id = $1" : ""} ORDER BY d.due_on`, mine ? [t.userId] : [])).rows as DeadlineRow[],
    );
    reply.header("content-type", "text/calendar; charset=utf-8").header("content-disposition", 'attachment; filename="terminos.ics"');
    return toIcs(rows.map((d) => icsEvent(d, webUrl(t.organizationId, d.id))), mine ? "Mis términos · Ragis" : "Términos · Ragis");
  });

  app.get(`${base}/deadlines/:id`, async (req) => {
    const t = req.tenant!;
    const { id } = req.params as { id: string };
    return tx(pool, t, async (db) => {
      const d = await loadDeadline(db, id);
      const cal = await loadCalendar(db, t.organizationId);
      const events = (
        await db.query(
          `SELECT e.id, e.kind, e.data, e.created_at, u.email AS actor_email, u.display_name AS actor_name
             FROM deadline_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.deadline_id = $1 ORDER BY e.id`,
          [id],
        )
      ).rows;
      const reminders = (
        await db.query(
          "SELECT kind, due_on::text AS due_on, recipient, sent_at FROM deadline_reminders WHERE deadline_id = $1 AND sent_at IS NOT NULL ORDER BY sent_at",
          [id],
        )
      ).rows;
      return { ...present(cal, todayIn(cal.country))(d), can_edit: canEdit(t, d), events, reminders, reminders_enabled: Boolean(deps.deadlineMailer) };
    });
  });

  app.get(`${base}/deadlines/:id/calendar.ics`, async (req, reply) => {
    const t = req.tenant!;
    const { id } = req.params as { id: string };
    const d = await tx(pool, t, (db) => loadDeadline(db, id));
    reply.header("content-type", "text/calendar; charset=utf-8").header("content-disposition", `attachment; filename="termino-${d.id.slice(0, 8)}.ics"`);
    return toIcs([icsEvent(d, webUrl(t.organizationId, d.id))], "Términos · Ragis");
  });

  app.patch(`${base}/deadlines/:id`, async (req) => {
    const t = req.tenant!;
    const { id } = req.params as { id: string };
    const body = UpdateDeadline.parse(req.body);
    return tx(pool, t, async (db) => {
      const d = await loadDeadline(db, id);
      if (!canEdit(t, d)) throw forbidden("only the responsible person or an editor of the workspace can change this deadline");
      const cal = await loadCalendar(db, t.organizationId);
      const next = {
        title: body.title ?? d.title,
        trigger_kind: body.trigger_kind ?? d.trigger_kind,
        trigger_date: body.trigger_date ?? d.trigger_date,
        notice_by_email: body.notice_by_email ?? d.notice_by_email,
        unit: body.unit ?? d.unit,
        amount: body.amount !== undefined ? body.amount : body.unit === "fixed" ? null : d.amount,
        legal_basis: body.legal_basis ?? d.legal_basis,
        responsible_id: body.responsible_id ?? d.responsible_id,
        notes: body.notes ?? d.notes,
        status: body.status ?? d.status,
      };
      const termChanged = (["trigger_date", "notice_by_email", "unit", "amount"] as const).some((k) => next[k] !== d[k]);
      const computation = termChanged ? compute(next, cal) : null;
      const changes: Record<string, unknown> = {};
      for (const k of ["title", "trigger_kind", "trigger_date", "notice_by_email", "unit", "amount", "legal_basis", "responsible_id"] as const) {
        if (next[k] !== d[k]) changes[k] = [d[k], next[k]];
      }
      if (computation && computation.due_on !== d.due_on) changes.due_on = [d.due_on, computation.due_on];
      if (next.notes !== d.notes) changes.notes = "edited";
      const statusChanged = next.status !== d.status;
      if (!Object.keys(changes).length && !statusChanged) return { ...present(cal, todayIn(cal.country))(d), can_edit: true };
      await guard(() =>
        db.query(
          `UPDATE deadlines SET title=$2, trigger_kind=$3, trigger_date=$4, notice_by_email=$5, unit=$6, amount=$7, legal_basis=$8,
                  responsible_id=$9, notes=$10, status=$11,
                  due_on=COALESCE($12::date, due_on), computation=COALESCE($13::jsonb, computation),
                  closed_at=CASE WHEN $11 = 'pending' THEN NULL WHEN status = $11 THEN closed_at ELSE now() END,
                  closed_by=CASE WHEN $11 = 'pending' THEN NULL WHEN status = $11 THEN closed_by ELSE $14::uuid END
            WHERE id=$1`,
          [id, next.title, next.trigger_kind, next.trigger_date, next.notice_by_email, next.unit, next.amount, next.legal_basis,
           next.responsible_id, next.notes, next.status, computation?.due_on ?? null, computation ? JSON.stringify(computation) : null, t.userId],
        ),
      );
      const event = (kind: string, data: unknown) =>
        db.query("INSERT INTO deadline_events (deadline_id, organization_id, actor_id, kind, data) VALUES ($1,$2,$3,$4,$5::jsonb)", [
          id, t.organizationId, t.userId, kind, JSON.stringify(data),
        ]);
      if (Object.keys(changes).length) await event("updated", changes);
      if (statusChanged) await event(next.status === "pending" ? "reopened" : next.status, { from: d.status });
      await audit(db, t, statusChanged ? `deadline.${next.status === "pending" ? "reopened" : next.status}` : "deadline.updated", `deadline:${id}`, "allow", {
        fields: Object.keys(changes),
      });
      const after = await loadDeadline(db, id);
      return { ...present(cal, todayIn(cal.country))(after), can_edit: canEdit(t, after) };
    });
  });

  // ---------------------------------------------------------------- candidates
  app.get(`${base}/deadline-candidates`, async (req) => {
    const t = req.tenant!;
    const q = CandidateQuery.parse(req.query);
    return tx(pool, t, async (db) => {
      const cal = await loadCalendar(db, t.organizationId);
      const args: unknown[] = [];
      const where = [q.status === "all" ? "true" : `c.status = $${args.push(q.status)}`];
      if (q.document_id) where.push(`c.document_id = $${args.push(q.document_id)}`);
      const rows = (
        await db.query(
          `SELECT c.id, c.workspace_id, w.name AS workspace_name, c.document_id, d.title AS document_title, c.version_id, v.version_no,
                  c.chunk_id, c.page, c.quote, c.amount, c.unit, c.unit_assumed, c.trigger_hint, c.trigger_date::text AS trigger_date,
                  c.legal_basis, c.title, c.status, c.deadline_id, c.decided_at, du.email AS decided_by_email, c.created_at
             FROM deadline_candidates c
             JOIN documents d ON d.id = c.document_id
             JOIN document_versions v ON v.id = c.version_id
             JOIN workspaces w ON w.id = c.workspace_id
             LEFT JOIN users du ON du.id = c.decided_by
            WHERE ${where.join(" AND ")}
            ORDER BY c.created_at DESC, d.title, c.page NULLS LAST LIMIT 300`,
          args,
        )
      ).rows;
      return {
        today: todayIn(cal.country),
        candidates: rows.map((c) => ({
          ...c,
          can_confirm: t.role !== "viewer" && (t.workspaces.get(c.workspace_id) === "editor" || (t.workspaces.has(c.workspace_id) && isAdmin(t))),
          // What the due date would be if the stated date is the start: a hint only, the person decides.
          suggested_due: c.trigger_date && (c.unit === "fixed" || c.amount)
            ? computeDueDate({ trigger_date: c.trigger_date, unit: c.unit, amount: c.unit === "fixed" ? null : c.amount, notice_by_email: false }, cal).due_on
            : null,
        })),
      };
    });
  });

  app.post(`${base}/deadline-candidates/:id/dismiss`, async (req) => {
    const t = req.tenant!;
    const { id } = req.params as { id: string };
    assertUuid(id, "candidate");
    return tx(pool, t, async (db) => {
      const c = (await db.query("SELECT id, workspace_id, status, document_id FROM deadline_candidates WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!c) throw notFound("candidate");
      requireWorkspaceWrite(t, c.workspace_id);
      if (c.status !== "proposed") throw conflict(`this candidate is already ${c.status}`);
      await db.query("UPDATE deadline_candidates SET status = 'dismissed', decided_by = $2, decided_at = now() WHERE id = $1", [id, t.userId]);
      await audit(db, t, "deadline_candidate.dismissed", `deadline_candidate:${id}`, "allow", { document_id: c.document_id });
      return { id, status: "dismissed" };
    });
  });

  // Look for candidates again in a document that was indexed before detection existed (or after editing patterns).
  app.post(`${base}/documents/:id/deadline-scan`, async (req, reply) => {
    const t = req.tenant!;
    const { id } = req.params as { id: string };
    assertUuid(id, "document");
    const job = await tx(pool, t, async (db) => {
      const d = (
        await db.query(
          `SELECT d.id, d.workspace_id, d.current_version_id, v.status FROM documents d
             LEFT JOIN document_versions v ON v.id = d.current_version_id WHERE d.id = $1 AND d.status = 'active'`,
          [id],
        )
      ).rows[0];
      if (!d) throw notFound("document");
      requireWorkspaceWrite(t, d.workspace_id);
      if (d.status !== "indexed") throw conflict("the document has not finished indexing");
      const jobId = randomUUID();
      const key = `deadlines:${d.current_version_id}:${Math.floor(Date.now() / 60_000)}`;
      const r = await db.query(
        `INSERT INTO ingestion_jobs (id, organization_id, kind, document_id, version_id, idempotency_key, params)
         VALUES ($1,$2,'reindex',$3,$4,$5,'{"mode":"deadlines"}'::jsonb) ON CONFLICT (organization_id, idempotency_key) DO NOTHING RETURNING id`,
        [jobId, t.organizationId, id, d.current_version_id, key],
      );
      if (!r.rows[0]) return { id: null as string | null, version: d.current_version_id as string };
      await audit(db, t, "document.deadline_scan", `document:${id}`, "allow", { job_id: jobId });
      return { id: jobId as string | null, version: d.current_version_id as string };
    });
    if (job.id) await queue.send({ v: 1, kind: "reindex", organization_id: t.organizationId, document_id: id, version_id: job.version, job_id: job.id });
    reply.code(202);
    return { job_id: job.id, state: job.id ? "queued" : "already_queued" };
  });

  // ---------------------------------------------------------------- people and calendar
  // Who can be responsible: active members of the firm (the same directory the team pages show to everyone).
  app.get(`${base}/deadline-people`, async (req) => {
    const t = req.tenant!;
    const people = await tx(pool, t, async (db) =>
      (
        await db.query(
          `SELECT u.id, u.email, u.display_name FROM memberships m JOIN users u ON u.id = m.user_id
            WHERE m.organization_id = $1 AND m.status = 'active' ORDER BY coalesce(u.display_name, u.email)`,
          [t.organizationId],
        )
      ).rows,
    );
    return { people, me: t.userId };
  });

  app.get(`${base}/deadline-calendar`, async (req) => {
    const t = req.tenant!;
    const q = z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() }).parse(req.query);
    return tx(pool, t, async (db) => {
      const cal = await loadCalendar(db, t.organizationId);
      const year = q.year ?? Number(todayIn(cal.country).slice(0, 4));
      const holidays = (
        await db.query(
          "SELECT day::text AS day, name, basis FROM public_holidays WHERE country = $1 AND day BETWEEN $2 AND $3 ORDER BY day, name",
          [cal.country, `${year}-01-01`, `${year}-12-31`],
        )
      ).rows;
      const closures = (
        await db.query(
          `SELECT c.id, c.starts_on::text AS starts_on, c.ends_on::text AS ends_on, c.label, c.created_at, u.email AS created_by_email
             FROM court_closures c LEFT JOIN users u ON u.id = c.created_by ORDER BY c.starts_on`,
        )
      ).rows;
      const countries = (await db.query("SELECT DISTINCT country FROM public_holidays ORDER BY country")).rows.map((r) => r.country as string);
      const suggestions = suggestedClosures(cal.country, year, cal.holidays).filter(
        (s) => !closures.some((c) => c.starts_on === s.starts_on && c.ends_on === s.ends_on),
      );
      return { country: cal.country, countries, year, coverage: cal.coverage, holidays, closures, suggestions, can_edit: isAdmin(t) };
    });
  });

  app.put(`${base}/deadline-calendar`, async (req) => {
    const t = req.tenant!;
    requireAdmin(t);
    const body = CalendarBody.parse(req.body);
    return tx(pool, t, async (db) => {
      const known = (await db.query("SELECT 1 FROM public_holidays WHERE country = $1 LIMIT 1", [body.holiday_country])).rows[0];
      if (!known) throw badRequest("there are no public holidays loaded for that country");
      await db.query("UPDATE organizations SET holiday_country = $2 WHERE id = $1", [t.organizationId, body.holiday_country]);
      const moved = await recomputeAll(db, t.organizationId, `holiday country ${body.holiday_country}`);
      await audit(db, t, "deadline_calendar.country", `organization:${t.organizationId}`, "allow", { country: body.holiday_country, moved });
      return { country: body.holiday_country, recomputed: moved };
    });
  });

  app.post(`${base}/court-closures`, async (req, reply) => {
    const t = req.tenant!;
    requireAdmin(t);
    const body = ClosureBody.parse(req.body);
    if (body.ends_on < body.starts_on) throw badRequest("the closure ends before it starts");
    if (daysBetween(body.starts_on, body.ends_on) > 366) throw badRequest("a closure cannot last more than a year");
    const out = await tx(pool, t, async (db) => {
      const id = randomUUID();
      await db.query("INSERT INTO court_closures (id, organization_id, starts_on, ends_on, label, created_by) VALUES ($1,$2,$3,$4,$5,$6)", [
        id, t.organizationId, body.starts_on, body.ends_on, body.label, t.userId,
      ]);
      const moved = await recomputeAll(db, t.organizationId, `closure added: ${body.label}`);
      await audit(db, t, "court_closure.created", `court_closure:${id}`, "allow", { ...body, moved });
      return { id, ...body, recomputed: moved };
    });
    reply.code(201);
    return out;
  });

  app.delete(`${base}/court-closures/:id`, async (req) => {
    const t = req.tenant!;
    requireAdmin(t);
    const { id } = req.params as { id: string };
    assertUuid(id, "closure");
    return tx(pool, t, async (db) => {
      const r = await db.query("DELETE FROM court_closures WHERE id = $1 RETURNING label, starts_on::text, ends_on::text", [id]);
      if (!r.rows[0]) throw notFound("closure");
      const moved = await recomputeAll(db, t.organizationId, `closure removed: ${r.rows[0].label}`);
      await audit(db, t, "court_closure.deleted", `court_closure:${id}`, "allow", { ...r.rows[0], moved });
      return { id, recomputed: moved };
    });
  });
}

const UNIT_ES: Record<Unit, string> = { business_days: "días hábiles", calendar_days: "días calendario", months: "meses", years: "años", fixed: "" };

function icsEvent(d: DeadlineRow, url: string) {
  const term = d.unit === "fixed" ? "Fecha fija" : `${d.amount} ${UNIT_ES[d.unit]} desde el ${d.trigger_date}`;
  const lines = [
    `Término: ${term}`,
    d.legal_basis ? `Norma: ${d.legal_basis}` : "",
    d.document_title ? `Fuente: ${d.document_title}${d.page ? `, página ${d.page}` : ""}` : "",
    d.quote ? `«${d.quote}»` : "",
    d.responsible_email ? `Responsable: ${d.responsible_email}` : "",
    `Abrir en Ragis: ${url}`,
  ].filter(Boolean);
  return { id: d.id, title: d.title, due_on: d.due_on, description: lines.join("\n"), url };
}
