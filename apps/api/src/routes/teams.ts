import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../app.js";
import type { Db } from "../db/pool.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import {
  NOTE_REQUIRED,
  PRIORITIES,
  REQUEST_STATUSES,
  SUGGESTED_TEAMS,
  TEAM_COLORS,
  allowedTransitions,
  canAssign,
  canEditDetails,
  isClosed,
  needsAttention,
  statusAfterComment,
  type Involvement,
  type RequestStatus,
} from "../lib/team-requests.js";
import { assertUuid, audit, isAdmin, tx, type TenantContext } from "../lib/tenant.js";
import { emit } from "../lib/workflow-runner.js";

/**
 * Company teams and requests between teams (ADR-035).
 *
 * A team owns one workspace: its documents stay inside it through the existing ACL. Membership is the workspace
 * membership. Admins (the company's managers) create teams and assign people to them from Governance; leads triage
 * the requests that reach their team. Requests are visible only to the people involved (RLS in migration 0019);
 * admins manage teams but do not read other teams' requests. No route declares scopes, so service API keys cannot
 * reach any of this.
 */

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const CreateTeam = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(280).default(""),
    color: z.enum(TEAM_COLORS).default("blue"),
    lead_user_id: z.string().uuid().optional(),
  })
  .strict();
const UpdateTeam = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(280).optional(),
    color: z.enum(TEAM_COLORS).optional(),
    archived: z.boolean().optional(),
  })
  .strict();
const SetMember = z.object({ lead: z.boolean().optional(), access: z.enum(["editor", "reader"]).optional() }).strict();
const CreateRequest = z
  .object({
    to_team_id: z.string().uuid(),
    from_team_id: z.string().uuid().nullable().optional(),
    title: z.string().trim().min(3).max(160),
    body: z.string().trim().max(8000).default(""),
    priority: z.enum(PRIORITIES).default("normal"),
    due_on: DATE.nullable().optional(),
  })
  .strict();
const UpdateRequest = z
  .object({
    status: z.enum(REQUEST_STATUSES).optional(),
    assignee_id: z.string().uuid().nullable().optional(),
    priority: z.enum(PRIORITIES).optional(),
    due_on: DATE.nullable().optional(),
    note: z.string().trim().max(4000).optional(),
  })
  .strict();
const CommentBody = z.object({ body: z.string().trim().min(1).max(4000) }).strict();
const ListQuery = z.object({
  view: z.enum(["for_me", "team", "sent", "all"]).default("for_me"),
  team_id: z.string().uuid().optional(),
  closed: z.enum(["recent", "all", "none"]).default("recent"),
});

interface MyTeams {
  /** Teams I belong to. */
  member: Set<string>;
  /** Teams I lead. */
  lead: Set<string>;
  /** Teams whose unassigned requests I should pick up: I lead them, or nobody does. */
  triage: Set<string>;
}

async function myTeams(db: Db, userId: string): Promise<MyTeams> {
  const rows = (
    await db.query(
      `SELECT t.id, wm.team_lead AS lead,
              EXISTS (SELECT 1 FROM workspace_members l WHERE l.workspace_id = t.workspace_id AND l.team_lead) AS has_lead
         FROM teams t JOIN workspace_members wm ON wm.workspace_id = t.workspace_id AND wm.user_id = $1`,
      [userId],
    )
  ).rows as { id: string; lead: boolean; has_lead: boolean }[];
  return {
    member: new Set(rows.map((r) => r.id)),
    lead: new Set(rows.filter((r) => r.lead).map((r) => r.id)),
    triage: new Set(rows.filter((r) => r.lead || !r.has_lead).map((r) => r.id)),
  };
}

/**
 * Requests that need something from the user right now (Inbox counter). Same rule as `needsAttention`; kept in SQL
 * so the counter is one cheap query on every page load.
 */
export async function peopleAttentionCount(db: Db, userId: string): Promise<number> {
  const mine = await myTeams(db, userId);
  const r = await db.query(
    `SELECT count(*)::int AS n FROM team_requests r
      WHERE r.closed_at IS NULL AND (
        (r.status = 'waiting' AND r.requested_by = $1)
        OR (r.status = 'open' AND (r.assignee_id = $1 OR (r.assignee_id IS NULL AND r.to_team_id = ANY($2::uuid[]))))
      )`,
    [userId, [...mine.triage]],
  );
  return r.rows[0].n as number;
}

const REQUEST_SELECT = `
  SELECT r.id, r.number, r.title, r.body, r.status, r.priority, r.due_on::text AS due_on, r.created_at, r.updated_at, r.closed_at,
         r.requested_by, r.assignee_id, r.to_team_id, r.from_team_id,
         json_build_object('id', tt.id, 'name', tt.name, 'color', tt.color) AS to_team,
         CASE WHEN ft.id IS NULL THEN NULL ELSE json_build_object('id', ft.id, 'name', ft.name, 'color', ft.color) END AS from_team,
         json_build_object('id', r.requested_by, 'name', coalesce(ru.display_name, ru.email, 'Former member'), 'email', ru.email) AS requester,
         CASE WHEN r.assignee_id IS NULL THEN NULL
              ELSE json_build_object('id', r.assignee_id, 'name', coalesce(au.display_name, au.email, 'Former member'), 'email', au.email) END AS assignee,
         (SELECT count(*)::int FROM team_request_events e WHERE e.request_id = r.id AND e.kind = 'comment') AS comments
    FROM team_requests r
    JOIN teams tt ON tt.id = r.to_team_id
    LEFT JOIN teams ft ON ft.id = r.from_team_id
    LEFT JOIN users ru ON ru.id = r.requested_by
    LEFT JOIN users au ON au.id = r.assignee_id`;

type RequestRow = {
  id: string;
  status: RequestStatus;
  requested_by: string;
  assignee_id: string | null;
  to_team_id: string;
  from_team_id: string | null;
  body: string;
  [k: string]: unknown;
};

function involvement(r: RequestRow, userId: string, mine: MyTeams): Involvement {
  return { requester: r.requested_by === userId, receiver: mine.member.has(r.to_team_id), assignee: r.assignee_id === userId };
}

/** What the person may do with the request; the screen shows only these controls. */
function present(r: RequestRow, userId: string, mine: MyTeams, opts: { full: boolean }) {
  const who = involvement(r, userId, mine);
  const { requested_by: _rb, assignee_id: _a, to_team_id: _tt, from_team_id: _ft, body, ...rest } = r;
  return {
    ...rest,
    ...(opts.full ? { body } : { excerpt: body.length > 180 ? `${body.slice(0, 179).trimEnd()}…` : body }),
    my: {
      ...who,
      attention: needsAttention(r, userId, mine.triage),
      transitions: allowedTransitions(r.status, who),
      can_assign: canAssign(r.status, who),
      can_edit: canEditDetails(r.status, who),
    },
  };
}

async function loadRequest(db: Db, id: string): Promise<RequestRow> {
  const row = (await db.query(`${REQUEST_SELECT} WHERE r.id = $1`, [id])).rows[0] as RequestRow | undefined;
  if (!row) throw notFound("request");
  return row;
}

async function teamOrThrow(db: Db, id: string) {
  const row = (await db.query("SELECT id, name, description, color, workspace_id, archived_at FROM teams WHERE id = $1", [id])).rows[0];
  if (!row) throw notFound("team");
  return row as { id: string; name: string; description: string; color: string; workspace_id: string; archived_at: string | null };
}

/** Teams and who is in them are decided by admins, from Governance. */
function requireAdmin(t: TenantContext, what: string) {
  if (!isAdmin(t)) throw forbidden(`only admins can ${what}`);
}

async function requestEvent(db: Db, t: TenantContext, requestId: string, kind: string, body = "", data: Record<string, unknown> = {}) {
  await db.query(
    "INSERT INTO team_request_events (request_id, organization_id, actor_id, kind, body, data) VALUES ($1,$2,$3,$4,$5,$6::jsonb)",
    [requestId, t.organizationId, t.userId, kind, body, JSON.stringify(data)],
  );
}

export async function teamRoutes(app: FastifyInstance, deps: Deps) {
  const { pool } = deps;
  const base = "/v1/organizations/:org";

  // ---------------------------------------------------------------- team directory
  app.get(`${base}/teams`, async (req) => {
    const t = req.tenant!;
    return tx(pool, t, async (db) => {
      const teams = (
        await db.query(
          `SELECT t.id, t.name, t.description, t.color, t.workspace_id, t.archived_at, t.created_at,
                  count(wm.user_id)::int AS member_count,
                  coalesce(json_agg(json_build_object('id', u.id, 'name', coalesce(u.display_name, u.email), 'lead', wm.team_lead)
                                    ORDER BY wm.team_lead DESC, u.email) FILTER (WHERE wm.user_id IS NOT NULL), '[]') AS people,
                  coalesce(bool_or(wm.user_id = $1), false) AS is_member,
                  coalesce(bool_or(wm.user_id = $1 AND wm.team_lead), false) AS is_lead
             FROM teams t
             LEFT JOIN workspace_members wm ON wm.workspace_id = t.workspace_id
             LEFT JOIN users u ON u.id = wm.user_id
            GROUP BY t.id
            ORDER BY t.archived_at NULLS FIRST, lower(t.name)`,
          [t.userId],
        )
      ).rows;
      // Open requests per team, counted only for the teams the person belongs to (their own queue).
      const memberOf = teams.filter((x) => x.is_member).map((x) => x.id as string);
      const open = memberOf.length
        ? (
            await db.query(
              "SELECT to_team_id, count(*)::int AS n FROM team_requests WHERE closed_at IS NULL AND to_team_id = ANY($1::uuid[]) GROUP BY 1",
              [memberOf],
            )
          ).rows
        : [];
      const openBy = new Map(open.map((r) => [r.to_team_id as string, r.n as number]));
      let suggestions: unknown[] = [];
      if (isAdmin(t)) {
        const taken = new Set(teams.map((x) => String(x.name).trim().toLowerCase()));
        const spaces = (
          await db.query(
            `SELECT w.id, lower(btrim(w.name)) AS key, (SELECT count(*)::int FROM workspace_members m WHERE m.workspace_id = w.id) AS members
               FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM teams x WHERE x.workspace_id = w.id)`,
          )
        ).rows;
        suggestions = SUGGESTED_TEAMS.filter((s) => !taken.has(s.name.toLowerCase())).map((s) => {
          const ws = spaces.find((w) => w.key === s.name.toLowerCase());
          return { ...s, existing_workspace: ws ? { id: ws.id, members: ws.members } : null };
        });
      }
      return {
        teams: teams.map((x) => ({ ...x, open_requests: x.is_member ? (openBy.get(x.id) ?? 0) : null })),
        can_manage: isAdmin(t),
        suggestions,
      };
    });
  });

  app.post(`${base}/teams`, async (req, reply) => {
    const t = req.tenant!;
    if (!isAdmin(t)) throw forbidden("only admins can create teams");
    const body = CreateTeam.parse(req.body);
    const out = await tx(pool, t, async (db) => {
      if ((await db.query("SELECT 1 FROM teams WHERE lower(btrim(name)) = lower($1)", [body.name])).rowCount) {
        throw conflict("a team with this name already exists");
      }
      // A space with the same name (e.g. created during setup) becomes the team's space, with the people already in it.
      const existing = (
        await db.query(
          `SELECT w.id, EXISTS (SELECT 1 FROM teams x WHERE x.workspace_id = w.id) AS linked,
                  (SELECT count(*)::int FROM workspace_members m WHERE m.workspace_id = w.id) AS members
             FROM workspaces w WHERE lower(btrim(w.name)) = lower($1)`,
          [body.name],
        )
      ).rows[0];
      if (existing?.linked) throw conflict("a space with this name already belongs to another team");
      const workspaceId = (existing?.id as string | undefined) ?? randomUUID();
      if (!existing) {
        await db.query("INSERT INTO workspaces (id, organization_id, name) VALUES ($1,$2,$3)", [workspaceId, t.organizationId, body.name]);
        await audit(db, t, "workspace.created", `workspace:${workspaceId}`, "allow", { for_team: true });
      }
      const id = randomUUID();
      await db.query(
        "INSERT INTO teams (id, organization_id, workspace_id, name, description, color, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [id, t.organizationId, workspaceId, body.name, body.description, body.color, t.userId],
      );
      if (body.lead_user_id) {
        const m = await db.query("SELECT role FROM memberships WHERE organization_id=$1 AND user_id=$2 AND status='active'", [t.organizationId, body.lead_user_id]);
        if (!m.rowCount) throw notFound("member");
        await db.query(
          `INSERT INTO workspace_members (workspace_id, organization_id, user_id, role, team_lead) VALUES ($1,$2,$3,$4,true)
           ON CONFLICT (workspace_id, user_id) DO UPDATE SET team_lead = true`,
          [workspaceId, t.organizationId, body.lead_user_id, m.rows[0].role === "viewer" ? "reader" : "editor"],
        );
      }
      await audit(db, t, "team.created", `team:${id}`, "allow", { workspace_id: workspaceId, reused_space: !!existing });
      return { id, workspace_id: workspaceId, reused_space: !!existing, members: (existing?.members as number | undefined) ?? (body.lead_user_id ? 1 : 0) };
    });
    reply.code(201);
    return { ...out, name: body.name };
  });

  app.patch(`${base}/teams/:id`, async (req) => {
    const t = req.tenant!;
    const id = assertUuid((req.params as { id: string }).id, "team");
    requireAdmin(t, "change teams");
    const body = UpdateTeam.parse(req.body);
    return tx(pool, t, async (db) => {
      const team = await teamOrThrow(db, id);
      if (body.name && body.name.toLowerCase() !== team.name.toLowerCase()) {
        if ((await db.query("SELECT 1 FROM teams WHERE lower(btrim(name)) = lower($1) AND id <> $2", [body.name, id])).rowCount) {
          throw conflict("a team with this name already exists");
        }
      }
      if (body.name && body.name !== team.name) {
        // The team's space carries the team's name, so people recognise it in the workspace switcher.
        try {
          await db.query("UPDATE workspaces SET name = $1 WHERE id = $2", [body.name, team.workspace_id]);
        } catch (err: unknown) {
          if ((err as { code?: string }).code === "23505") throw conflict("another space already has this name");
          throw err;
        }
      }
      await db.query(
        `UPDATE teams SET name = coalesce($2, name), description = coalesce($3, description), color = coalesce($4, color),
                archived_at = CASE WHEN $5::boolean IS NULL THEN archived_at WHEN $5 THEN coalesce(archived_at, now()) ELSE NULL END,
                updated_at = now()
          WHERE id = $1`,
        [id, body.name ?? null, body.description ?? null, body.color ?? null, body.archived ?? null],
      );
      await audit(db, t, "team.updated", `team:${id}`, "allow", { fields: Object.keys(body) });
      return teamOrThrow(db, id);
    });
  });

  app.put(`${base}/teams/:id/members/:user`, async (req, reply) => {
    const t = req.tenant!;
    const { id: rawId, user: rawUser } = req.params as { id: string; user: string };
    const id = assertUuid(rawId, "team");
    const user = assertUuid(rawUser, "member");
    requireAdmin(t, "assign people to teams");
    const body = SetMember.parse(req.body ?? {});
    await tx(pool, t, async (db) => {
      const team = await teamOrThrow(db, id);
      const m = await db.query("SELECT role FROM memberships WHERE organization_id=$1 AND user_id=$2 AND status='active'", [t.organizationId, user]);
      if (!m.rowCount) throw notFound("member");
      const defaultAccess = m.rows[0].role === "viewer" ? "reader" : "editor";
      await db.query(
        `INSERT INTO workspace_members (workspace_id, organization_id, user_id, role, team_lead) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (workspace_id, user_id) DO UPDATE
           SET role = coalesce($6, workspace_members.role), team_lead = coalesce($7, workspace_members.team_lead)`,
        [team.workspace_id, t.organizationId, user, body.access ?? defaultAccess, body.lead ?? false, body.access ?? null, body.lead ?? null],
      );
      await audit(db, t, "team.member_set", `team:${id}`, "allow", { user_id: user, ...body });
    });
    reply.code(204);
  });

  app.delete(`${base}/teams/:id/members/:user`, async (req, reply) => {
    const t = req.tenant!;
    const { id: rawId, user: rawUser } = req.params as { id: string; user: string };
    const id = assertUuid(rawId, "team");
    const user = assertUuid(rawUser, "member");
    requireAdmin(t, "assign people to teams");
    await tx(pool, t, async (db) => {
      const team = await teamOrThrow(db, id);
      const target = (await db.query("SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2", [team.workspace_id, user])).rows[0];
      if (!target) throw notFound("member");
      const released = (await db.query("SELECT app.release_team_assignments($1, $2) AS n", [id, user])).rows[0].n as number;
      await db.query("DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2", [team.workspace_id, user]);
      await audit(db, t, "team.member_removed", `team:${id}`, "allow", { user_id: user, released_requests: released });
    });
    reply.code(204);
  });

  // ---------------------------------------------------------------- requests
  app.get(`${base}/requests`, async (req) => {
    const t = req.tenant!;
    const q = ListQuery.parse(req.query);
    return tx(pool, t, async (db) => {
      const mine = await myTeams(db, t.userId);
      const where: string[] = ["true"]; // "all" = everything RLS lets the person see
      const args: unknown[] = [];
      const p = (v: unknown) => `$${args.push(v)}`;
      if (q.view === "for_me") {
        const me = p(t.userId);
        where.push(`(r.assignee_id = ${me} OR (r.assignee_id IS NULL AND r.to_team_id = ANY(${p([...mine.member])}::uuid[])) OR (r.requested_by = ${me} AND r.status = 'waiting'))`);
      } else if (q.view === "team") {
        where.push(`r.to_team_id = ANY(${p([...mine.member])}::uuid[])`);
      } else if (q.view === "sent") {
        where.push(`r.requested_by = ${p(t.userId)}`);
      }
      if (q.team_id) {
        const team = p(q.team_id);
        where.push(`(r.to_team_id = ${team} OR r.from_team_id = ${team})`);
      }
      if (q.closed === "recent") where.push("(r.closed_at IS NULL OR r.closed_at > now() - interval '30 days')");
      if (q.closed === "none") where.push("r.closed_at IS NULL");
      const rows = (
        await db.query(
          `${REQUEST_SELECT} WHERE ${where.join(" AND ")}
            ORDER BY CASE r.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
                     r.due_on NULLS LAST, r.created_at DESC
            LIMIT 300`,
          args,
        )
      ).rows as RequestRow[];
      const items = rows.map((r) => present(r, t.userId, mine, { full: false }));
      return { view: q.view, requests: items, counts: { attention: items.filter((i) => i.my.attention).length }, my_team_ids: [...mine.member] };
    });
  });

  app.post(`${base}/requests`, async (req, reply) => {
    const t = req.tenant!;
    if (t.role === "viewer") throw forbidden("viewers can't send requests");
    const body = CreateRequest.parse(req.body);
    const out = await tx(pool, t, async (db) => {
      const to = await teamOrThrow(db, body.to_team_id);
      if (to.archived_at) throw badRequest("this team is archived and no longer takes requests");
      const mine = await myTeams(db, t.userId);
      let from: string | null = body.from_team_id ?? null;
      if (from && !mine.member.has(from)) throw forbidden("you can only send requests on behalf of your own teams");
      // Not stated and the person is in exactly one team: that's who is asking.
      if (body.from_team_id === undefined && mine.member.size === 1) from = [...mine.member][0] ?? null;
      const n = (
        await db.query(
          `INSERT INTO team_request_counters (organization_id, last_number) VALUES ($1, 1)
           ON CONFLICT (organization_id) DO UPDATE SET last_number = team_request_counters.last_number + 1
           RETURNING last_number`,
          [t.organizationId],
        )
      ).rows[0].last_number as number;
      const id = randomUUID();
      await db.query(
        `INSERT INTO team_requests (id, organization_id, number, from_team_id, to_team_id, requested_by, title, body, priority, due_on)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, t.organizationId, n, from, to.id, t.userId, body.title, body.body, body.priority, body.due_on ?? null],
      );
      await requestEvent(db, t, id, "created");
      await audit(db, t, "team_request.created", `team_request:${id}`, "allow", { number: n, from_team_id: from, to_team_id: to.id, priority: body.priority });
      await emit(db, t.organizationId, "team_request.created", id, id, { request_id: id, number: n, from_team_id: from, to_team_id: to.id, requested_by: t.userId, priority: body.priority });
      return present(await loadRequest(db, id), t.userId, mine, { full: true });
    });
    reply.code(201);
    return out;
  });

  app.get(`${base}/requests/:id`, async (req) => {
    const t = req.tenant!;
    const id = assertUuid((req.params as { id: string }).id, "request");
    return tx(pool, t, async (db) => {
      const row = await loadRequest(db, id);
      const mine = await myTeams(db, t.userId);
      const events = (
        await db.query(
          `SELECT e.id::text, e.kind, e.body, e.data, e.created_at,
                  CASE WHEN e.actor_id IS NULL THEN NULL
                       ELSE json_build_object('id', e.actor_id, 'name', coalesce(u.display_name, u.email, 'Former member')) END AS actor
             FROM team_request_events e LEFT JOIN users u ON u.id = e.actor_id
            WHERE e.request_id = $1 ORDER BY e.id`,
          [id],
        )
      ).rows;
      // Names for the people mentioned in assignment events (who it moved from / to).
      const ids = [...new Set(events.flatMap((e) => (e.kind === "assigned" ? [e.data.from, e.data.to] : [])).filter(Boolean))] as string[];
      const people = ids.length
        ? Object.fromEntries((await db.query("SELECT id, coalesce(display_name, email) AS name FROM users WHERE id = ANY($1::uuid[])", [ids])).rows.map((u) => [u.id, u.name]))
        : {};
      const view = present(row, t.userId, mine, { full: true });
      const assignees = view.my.can_assign
        ? (
            await db.query(
              `SELECT u.id, coalesce(u.display_name, u.email) AS name, u.email, wm.team_lead AS lead
                 FROM teams tm JOIN workspace_members wm ON wm.workspace_id = tm.workspace_id JOIN users u ON u.id = wm.user_id
                WHERE tm.id = $1 ORDER BY wm.team_lead DESC, lower(coalesce(u.display_name, u.email))`,
              [row.to_team_id],
            )
          ).rows
        : [];
      return { ...view, events, people, assignees, viewer_id: t.userId };
    });
  });

  app.patch(`${base}/requests/:id`, async (req) => {
    const t = req.tenant!;
    const id = assertUuid((req.params as { id: string }).id, "request");
    const body = UpdateRequest.parse(req.body);
    return tx(pool, t, async (db) => {
      const cur = (await db.query("SELECT id, status, requested_by, assignee_id, to_team_id, from_team_id, priority, due_on::text AS due_on FROM team_requests WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!cur) throw notFound("request");
      const mine = await myTeams(db, t.userId);
      const who = involvement({ ...cur, body: "" } as RequestRow, t.userId, mine);
      const sets: string[] = [];
      const args: unknown[] = [id];
      const changed: Record<string, unknown> = {};
      let noteUsed = false;

      if (body.status && body.status !== cur.status) {
        if (!allowedTransitions(cur.status, who).includes(body.status)) throw forbidden("you can't move this request there");
        if (NOTE_REQUIRED.has(body.status) && !body.note) {
          throw badRequest(body.status === "waiting" ? "say what you need from the requester" : "say why you're declining");
        }
        args.push(body.status);
        sets.push(`status = $${args.length}`, `closed_at = ${isClosed(body.status) ? "coalesce(closed_at, now())" : "NULL"}`);
        changed.status = { from: cur.status, to: body.status };
      }
      if (body.assignee_id !== undefined && body.assignee_id !== cur.assignee_id) {
        if (!canAssign(cur.status, who)) throw forbidden("only the receiving team can assign this request");
        if (body.assignee_id) {
          const ok = await db.query(
            "SELECT 1 FROM teams tm JOIN workspace_members wm ON wm.workspace_id = tm.workspace_id WHERE tm.id = $1 AND wm.user_id = $2",
            [cur.to_team_id, body.assignee_id],
          );
          if (!ok.rowCount) throw badRequest("pick someone from the receiving team");
        }
        args.push(body.assignee_id);
        sets.push(`assignee_id = $${args.length}`);
        changed.assignee = { from: cur.assignee_id, to: body.assignee_id };
      }
      for (const field of ["priority", "due_on"] as const) {
        const next = body[field];
        if (next === undefined || next === cur[field]) continue;
        if (!canEditDetails(cur.status, who)) throw forbidden("you can't change this request");
        args.push(next);
        sets.push(`${field} = $${args.length}`);
        changed[field] = { from: cur[field], to: next };
      }

      if (sets.length) await db.query(`UPDATE team_requests SET ${sets.join(", ")} WHERE id = $1`, args);
      if (changed.status) {
        const s = changed.status as { from: string; to: string };
        await requestEvent(db, t, id, "status", body.note ?? "", s);
        noteUsed = true;
      }
      if (changed.assignee) await requestEvent(db, t, id, "assigned", "", changed.assignee as Record<string, unknown>);
      if (changed.priority) await requestEvent(db, t, id, "priority", "", changed.priority as Record<string, unknown>);
      if (changed.due_on) await requestEvent(db, t, id, "due", "", changed.due_on as Record<string, unknown>);
      if (body.note && !noteUsed) {
        await requestEvent(db, t, id, "comment", body.note);
        await db.query("UPDATE team_requests SET updated_at = now() WHERE id = $1", [id]);
      }
      if (Object.keys(changed).length) {
        await audit(db, t, "team_request.updated", `team_request:${id}`, "allow", changed);
        await emit(db, t.organizationId, "team_request.updated", id, id, { request_id: id, actor: t.userId, changes: changed });
      }
      return present(await loadRequest(db, id), t.userId, mine, { full: true });
    });
  });

  app.post(`${base}/requests/:id/comments`, async (req, reply) => {
    const t = req.tenant!;
    const id = assertUuid((req.params as { id: string }).id, "request");
    const body = CommentBody.parse(req.body);
    const out = await tx(pool, t, async (db) => {
      const cur = (await db.query("SELECT id, status, requested_by, assignee_id, to_team_id, from_team_id FROM team_requests WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!cur) throw notFound("request");
      const mine = await myTeams(db, t.userId);
      const who = involvement({ ...cur, body: "" } as RequestRow, t.userId, mine);
      await requestEvent(db, t, id, "comment", body.body);
      const next = statusAfterComment(cur.status, who);
      if (next) {
        await db.query("UPDATE team_requests SET status = $2 WHERE id = $1", [id, next]);
        await requestEvent(db, t, id, "status", "", { from: cur.status, to: next, auto: true });
      } else {
        await db.query("UPDATE team_requests SET updated_at = now() WHERE id = $1", [id]);
      }
      await emit(db, t.organizationId, "team_request.commented", id, id, { request_id: id, actor: t.userId, ...(next ? { status: next } : {}) });
      return { status: next ?? cur.status };
    });
    reply.code(201);
    return out;
  });
}
