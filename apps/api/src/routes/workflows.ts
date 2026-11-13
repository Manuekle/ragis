import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../app.js";
import type { Db } from "../db/pool.js";
import { ApiError, badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { bumpVersion } from "../lib/policy.js";
import { assertUuid, audit, hasRole, isAdmin, tx, type TenantContext } from "../lib/tenant.js";
import {
  FUNCTIONAL_ROLES,
  Graph,
  HUMAN_ROLES,
  NODE_TYPES,
  WORKFLOW_POLICY_VERSION,
  WORKFLOW_TEMPLATES,
  graphHash,
  graphNeeds,
  validateGraph,
  type AgentRef,
} from "../lib/workflow-dsl.js";
import { emit, WorkflowRunner } from "../lib/workflow-runner.js";
import { blockedRecipients, loadPolicy, normalizeEmails } from "../lib/external-actions.js";
import { peopleAttentionCount } from "./teams.js";

const CreateWorkflow = z.object({ template: z.string().max(64).optional(), name: z.string().trim().min(2).max(80).optional() }).strict();
const SaveDraft = z.object({ graph: Graph, name: z.string().trim().min(2).max(80).optional(), description: z.string().trim().max(400).optional() }).strict();
const PublishBody = z.object({ bump: z.enum(["major", "minor", "patch"]).default("minor"), changelog: z.string().trim().min(3).max(1000) }).strict();
const StatusBody = z.object({ status: z.enum(["published", "paused", "archived"]) }).strict();
const StartRun = z
  .object({
    task: z.string().trim().min(2).max(2000),
    signers: z.array(z.object({ name: z.string().trim().min(2).max(120), email: z.string().trim().toLowerCase().email() }).strict()).max(10).optional(),
    recipients: z.array(z.string().trim().toLowerCase().email()).max(20).optional(),
  })
  .strict();
const Decision = z.object({ decision: z.enum(["approve", "reject"]), action_hash: z.string().regex(/^[0-9a-f]{64}$/), comment: z.string().trim().max(1000).optional() }).strict();
const SetRoles = z.object({ roles: z.array(z.enum(FUNCTIONAL_ROLES)).max(FUNCTIONAL_ROLES.length) }).strict();

interface WorkflowRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  template_code: string | null;
  owner_id: string;
  status: string;
  draft_graph: Graph;
  draft_hash: string;
  active_version_id: string | null;
  updated_at: string;
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "workflow";

const canEdit = (t: TenantContext, w: Pick<WorkflowRow, "owner_id">) => t.role !== "viewer" && (isAdmin(t) || w.owner_id === t.userId);

async function agentRefs(db: Db): Promise<Map<string, AgentRef & { name: string }>> {
  const r = await db.query(
    `SELECT a.slug, a.name, a.status, a.active_version_id, v.version AS active_version
       FROM agents a LEFT JOIN agent_versions v ON v.id = a.active_version_id WHERE a.status <> 'archived'`,
  );
  return new Map(r.rows.map((x) => [x.slug, x]));
}

async function loadWorkflow(db: Db, t: TenantContext, id: string): Promise<WorkflowRow> {
  assertUuid(id, "workflow");
  const w = (await db.query("SELECT * FROM workflows WHERE id=$1", [id])).rows[0] as WorkflowRow | undefined;
  if (!w || (!w.active_version_id && !isAdmin(t) && w.owner_id !== t.userId)) throw notFound("workflow");
  return w;
}

/** Quién ve un run: iniciador, admin, auditor, o quien tiene (o tuvo) una aprobación asignada por rol. */
async function canSeeRun(db: Db, t: TenantContext, run: { id: string; initiated_by: string }): Promise<boolean> {
  if (run.initiated_by === t.userId || isAdmin(t) || hasRole(t, "auditor")) return true;
  if (!t.functionalRoles.length) return false;
  const r = await db.query("SELECT 1 FROM approvals WHERE run_id=$1 AND assigned_role = ANY($2) LIMIT 1", [run.id, t.functionalRoles]);
  return !!r.rowCount;
}

/**
 * Las salidas de agente se muestran solo si quien mira puede leer todos los documentos citados (RLS). Si no, se
 * ocultan respuesta y fragmentos: un aprobador nunca ve contenido de documentos fuera de su ACL.
 */
async function redactOutputs<T extends { output: Record<string, unknown>; node_type: string }>(db: Db, steps: T[]): Promise<T[]> {
  const ids = [...new Set(steps.flatMap((s) => ((s.output.citations as { document_id: string }[]) ?? []).map((c) => c.document_id)))];
  const visible = new Set(ids.length ? (await db.query("SELECT id FROM documents WHERE id = ANY($1::uuid[])", [ids])).rows.map((r) => r.id as string) : []);
  return steps.map((s) => {
    const cites = (s.output.citations as { document_id: string }[] | undefined) ?? [];
    const hidden = cites.filter((c) => !visible.has(c.document_id)).length;
    if (!hidden) return s;
    return { ...s, output: { ...s.output, answer: null, citations: cites.filter((c) => visible.has(c.document_id)), redacted: { hidden_citations: hidden, reason: "cites documents you can't open" } } };
  });
}

export async function workflowRoutes(app: FastifyInstance, deps: Deps, runner: WorkflowRunner) {
  const { pool } = deps;
  const base = "/v1/organizations/:org";

  // ---------------------------------------------------------------- catálogo y CRUD
  app.get(`${base}/workflows/catalog`, async (req) => {
    const t = req.tenant!;
    const agents = await tx(pool, t, (db) => agentRefs(db));
    return {
      policy_version: WORKFLOW_POLICY_VERSION,
      node_types: NODE_TYPES,
      human_roles: HUMAN_ROLES,
      functional_roles: FUNCTIONAL_ROLES,
      templates: Object.entries(WORKFLOW_TEMPLATES).map(([code, x]) => ({ code, ...x })),
      agents: [...agents.values()].map((a) => ({ slug: a.slug, name: a.name, status: a.status, active_version: a.active_version })),
    };
  });

  app.get(`${base}/workflows`, async (req) => {
    const t = req.tenant!;
    const rows = await tx(pool, t, async (db) =>
      (
        await db.query(
          `SELECT w.id, w.slug, w.name, w.description, w.status, w.owner_id, w.updated_at, w.draft_hash, v.version AS active_version, v.graph_hash,
                  (SELECT count(*)::int FROM workflow_runs r WHERE r.workflow_id = w.id) AS runs,
                  jsonb_array_length(w.draft_graph->'nodes') AS nodes
             FROM workflows w LEFT JOIN workflow_versions v ON v.id = w.active_version_id
            WHERE w.status <> 'archived' AND (w.active_version_id IS NOT NULL OR w.owner_id = $1 OR $2)
            ORDER BY w.updated_at DESC`,
          [t.userId, isAdmin(t)],
        )
      ).rows,
    );
    return { workflows: rows.map((r) => ({ ...r, can_edit: canEdit(t, r), can_run: r.status === "published" && t.role !== "viewer" })) };
  });

  app.post(`${base}/workflows`, async (req, reply) => {
    const t = req.tenant!;
    if (t.role === "viewer") throw forbidden("viewers cannot create workflows");
    const body = CreateWorkflow.parse(req.body ?? {});
    const tpl = body.template ? WORKFLOW_TEMPLATES[body.template] : undefined;
    if (body.template && !tpl) throw badRequest("unknown template");
    const graph: Graph = tpl?.graph ?? Graph.parse({ nodes: [{ id: "start", type: "START" }, { id: "end", type: "END" }], edges: [["start", "end"]] });
    const name = body.name ?? tpl?.name ?? "New workflow";
    return tx(pool, t, async (db) => {
      let slug = slugify(name);
      const taken = new Set((await db.query("SELECT slug FROM workflows WHERE slug LIKE $1", [`${slug}%`])).rows.map((r) => r.slug));
      for (let i = 2; taken.has(slug); i++) slug = `${slug.replace(/-\d+$/, "")}-${i}`;
      const id = randomUUID();
      await db.query(
        `INSERT INTO workflows (id, organization_id, slug, name, description, template_code, owner_id, draft_graph, draft_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
        [id, t.organizationId, slug, name, tpl?.description ?? "", body.template ?? null, t.userId, JSON.stringify(graph), graphHash(graph)],
      );
      await audit(db, t, "workflow.draft_created", `workflow:${id}`, "allow", { template: body.template ?? null });
      reply.code(201);
      return { id, slug, validation: validateGraph(graph, await agentRefs(db)) };
    });
  });

  app.get(`${base}/workflows/:id`, async (req) => {
    const t = req.tenant!;
    return tx(pool, t, async (db) => {
      const w = await loadWorkflow(db, t, (req.params as { id: string }).id);
      const validation = validateGraph(w.draft_graph, await agentRefs(db));
      const active = w.active_version_id
        ? (await db.query("SELECT id, version, graph_hash, published_at, graph FROM workflow_versions WHERE id=$1", [w.active_version_id])).rows[0]
        : null;
      const versions = (
        await db.query(
          `SELECT v.id, v.version, v.changelog, v.published_at, u.email AS published_by FROM workflow_versions v
             LEFT JOIN users u ON u.id = v.published_by WHERE v.workflow_id=$1 ORDER BY v.published_at DESC`,
          [w.id],
        )
      ).rows;
      const editable = canEdit(t, w);
      const unchanged = !!active && active.graph_hash === w.draft_hash;
      return {
        ...w,
        draft: w.draft_graph,
        validation,
        active_version: active ? { id: active.id, version: active.version, graph_hash: active.graph_hash, published_at: active.published_at } : null,
        // Datos que pedirá "Start run" según la versión activa (firmantes, destinatarios).
        run_needs: active ? graphNeeds(active.graph as Graph) : { signers: false, recipients: false },
        versions,
        unpublished_changes: !unchanged,
        can_edit: editable,
        can_run: w.status === "published" && t.role !== "viewer",
        publish: {
          allowed: editable && validation.ok && !unchanged && w.status !== "archived",
          reasons: [
            ...(!editable ? ["only the owner or an admin can publish"] : []),
            ...(!validation.ok ? ["fix the items in the checklist"] : []),
            ...(unchanged ? ["nothing has changed since the live version"] : []),
          ],
          next_version: { major: bumpVersion(active?.version ?? null, "major"), minor: bumpVersion(active?.version ?? null, "minor"), patch: bumpVersion(active?.version ?? null, "patch") },
        },
      };
    });
  });

  app.put(`${base}/workflows/:id/draft`, async (req) => {
    const t = req.tenant!;
    const body = SaveDraft.parse(req.body);
    return tx(pool, t, async (db) => {
      const w = await loadWorkflow(db, t, (req.params as { id: string }).id);
      if (!canEdit(t, w)) throw forbidden("only the owner or an admin can edit");
      if (w.status === "archived") throw conflict("archived workflows are read-only");
      // Las versiones de agente se resuelven al publicar; un draft nunca trae ids fijados por el cliente.
      const graph = { ...body.graph, nodes: body.graph.nodes.map((n) => (n.type === "AGENT_TASK" ? { id: n.id, type: n.type, label: n.label, agent: n.agent } : n)) } as Graph;
      const hash = graphHash(graph);
      await db.query("UPDATE workflows SET draft_graph=$2::jsonb, draft_hash=$3, name=COALESCE($4, name), description=COALESCE($5, description), updated_at=now() WHERE id=$1", [
        w.id,
        JSON.stringify(graph),
        hash,
        body.name ?? null,
        body.description ?? null,
      ]);
      const validation = validateGraph(graph, await agentRefs(db));
      await audit(db, t, "workflow.draft_saved", `workflow:${w.id}`, "allow", { draft_hash: hash, errors: validation.errors.length });
      return { draft_hash: hash, validation };
    });
  });

  app.post(`${base}/workflows/:id/publish`, async (req, reply) => {
    const t = req.tenant!;
    const body = PublishBody.parse(req.body);
    type Out = { denied: ApiError } | Record<string, unknown>;
    const out = await tx(pool, t, async (db): Promise<Out> => {
      const w = await loadWorkflow(db, t, (req.params as { id: string }).id);
      await db.query("SELECT pg_advisory_xact_lock(hashtext('workflow:' || $1))", [w.id]);
      const deny = async (err: ApiError, reason: string) => {
        await audit(db, t, "workflow.publish", `workflow:${w.id}`, "deny", { reason });
        return { denied: err };
      };
      if (!canEdit(t, w)) return deny(forbidden("only the owner or an admin can publish"), "not_editor");
      if (w.status === "archived") return deny(conflict("archived workflows cannot be published"), "archived");
      const agents = await agentRefs(db);
      const v = validateGraph(w.draft_graph, agents);
      if (!v.ok) return deny(new ApiError(400, "publish_denied", "graph has errors", { errors: v.errors }), "graph_errors");
      const active = w.active_version_id ? (await db.query("SELECT graph_hash FROM workflow_versions WHERE id=$1", [w.active_version_id])).rows[0] : null;
      if (active && active.graph_hash === w.draft_hash) return deny(conflict("no changes since the active version"), "unchanged");
      // Fija cada agente a su versión publicada vigente: el run nunca cambia de agente a mitad de camino.
      const pinned = {
        ...w.draft_graph,
        nodes: w.draft_graph.nodes.map((n) => (n.type === "AGENT_TASK" ? { ...n, agent_version: agents.get(n.agent)!.active_version!, agent_version_id: agents.get(n.agent)!.active_version_id! } : n)),
      } as Graph;
      const latest = (await db.query("SELECT version FROM workflow_versions WHERE workflow_id=$1 ORDER BY published_at DESC LIMIT 1", [w.id])).rows[0];
      const version = bumpVersion(latest?.version ?? null, body.bump);
      const vid = randomUUID();
      await db.query(
        `INSERT INTO workflow_versions (id, organization_id, workflow_id, version, graph, graph_hash, policy_version, changelog, published_by)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)`,
        [vid, t.organizationId, w.id, version, JSON.stringify(pinned), w.draft_hash, WORKFLOW_POLICY_VERSION, body.changelog, t.userId],
      );
      await db.query("UPDATE workflows SET active_version_id=$2, status='published', updated_at=now() WHERE id=$1", [w.id, vid]);
      const agentPins = pinned.nodes.flatMap((n) => (n.type === "AGENT_TASK" ? [`${n.agent}@${n.agent_version}`] : []));
      await audit(db, t, "workflow.published", `workflow:${w.id}`, "allow", { version, graph_hash: w.draft_hash, agents: agentPins });
      return { id: vid, version, agents: agentPins };
    });
    if ("denied" in out) throw out.denied;
    reply.code(201);
    return out;
  });

  app.post(`${base}/workflows/:id/status`, async (req) => {
    const t = req.tenant!;
    const body = StatusBody.parse(req.body);
    return tx(pool, t, async (db) => {
      const w = await loadWorkflow(db, t, (req.params as { id: string }).id);
      if (!canEdit(t, w)) throw forbidden("only the owner or an admin can change status");
      if (w.status === "archived") throw conflict("archived workflows are read-only");
      if (body.status === "published" && !w.active_version_id) throw badRequest("publish a version first");
      await db.query("UPDATE workflows SET status=$2, updated_at=now() WHERE id=$1", [w.id, body.status]);
      await audit(db, t, `workflow.${body.status === "published" ? "resumed" : body.status}`, `workflow:${w.id}`);
      return { status: body.status };
    });
  });

  // ---------------------------------------------------------------- ejecuciones
  app.post(`${base}/workflows/:id/runs`, async (req, reply) => {
    const t = req.tenant!;
    if (t.role === "viewer") throw forbidden("viewers cannot start runs");
    const key = String(req.headers["idempotency-key"] ?? "").trim();
    if (key.length < 8 || key.length > 200) throw badRequest("Idempotency-Key header (8–200 chars) is required");
    const body = StartRun.parse(req.body);
    const result = await tx(pool, t, async (db) => {
      const w = await loadWorkflow(db, t, (req.params as { id: string }).id);
      const dup = (await db.query("SELECT id, workflow_id, initiated_by, state FROM workflow_runs WHERE idempotency_key=$1", [key])).rows[0];
      if (dup) {
        if (dup.workflow_id !== w.id || dup.initiated_by !== t.userId) throw conflict("Idempotency-Key already used for another run");
        return { id: dup.id as string, state: dup.state as string, replay: true } as { id?: string; state?: string; replay?: boolean; denied?: string[] };
      }
      if (w.status !== "published" || !w.active_version_id) throw conflict(`workflow is ${w.status}`);
      const version = (await db.query("SELECT graph FROM workflow_versions WHERE id=$1", [w.active_version_id])).rows[0].graph as Graph;
      const needs = graphNeeds(version);
      if (needs.signers && !body.signers?.length) throw badRequest("this workflow prepares a signature: add at least one signer");
      const recipients = normalizeEmails(body.recipients);
      if (needs.recipients) {
        if (!recipients.length) throw badRequest("this workflow shares documents: add at least one recipient");
        const blocked = blockedRecipients(await loadPolicy(db, t.organizationId), recipients);
        if (blocked.length) return { denied: [...new Set(blocked.map((e) => e.split("@")[1]!))] };
      }
      const id = randomUUID();
      await db.query(
        `INSERT INTO workflow_runs (id, organization_id, workflow_id, workflow_version_id, initiated_by, idempotency_key, input, policy_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
        [id, t.organizationId, w.id, w.active_version_id, t.userId, key, JSON.stringify({ task: body.task, ...(needs.signers ? { signers: body.signers } : {}), ...(needs.recipients ? { recipients } : {}) }), WORKFLOW_POLICY_VERSION],
      );
      await emit(db, t.organizationId, "WORKFLOW_RUN_STARTED", id, id, { workflow_id: w.id, workflow_version_id: w.active_version_id, initiated_by: t.userId });
      await audit(db, t, "workflow.run_started", `workflow_run:${id}`, "allow", { workflow_id: w.id });
      return { id, state: "QUEUED", replay: false } as { id?: string; state?: string; replay?: boolean; denied?: string[] };
    });
    if ("denied" in result) {
      // Destinatarios fuera de la allowlist: se rechaza antes de ejecutar nada y el intento queda auditado (caso E2E 7).
      await tx(pool, t, (db) => audit(db, t, "share.denied", `workflow:${(req.params as { id: string }).id}`, "deny", { reason: "domain_not_allowed", domains: result.denied, stage: "run_start" }));
      throw new ApiError(403, "recipient_not_allowed", `recipients outside the allowed domains: ${result.denied!.join(", ")}`);
    }
    if (!result.replay) runner.enqueue(t.organizationId, result.id!);
    reply.code(result.replay ? 200 : 202);
    return result;
  });

  app.get(`${base}/runs`, async (req) => {
    const t = req.tenant!;
    const q = z.object({ state: z.string().max(20).optional(), workflow_id: z.string().uuid().optional() }).parse(req.query ?? {});
    return tx(pool, t, async (db) => {
      await WorkflowRunner.expireStale(db);
      const all = isAdmin(t) || hasRole(t, "auditor");
      const rows = (
        await db.query(
          `SELECT r.id, r.state, r.created_at, r.updated_at, r.completed_at, r.error_code, r.usage, r.initiated_by, u.email AS initiated_by_email,
                  w.id AS workflow_id, w.name AS workflow_name, v.version AS workflow_version,
                  (SELECT count(*)::int FROM approvals a WHERE a.run_id = r.id AND a.status = 'PENDING') AS pending_approvals
             FROM workflow_runs r
             JOIN workflows w ON w.id = r.workflow_id
             JOIN workflow_versions v ON v.id = r.workflow_version_id
             LEFT JOIN users u ON u.id = r.initiated_by
            WHERE ($1 OR r.initiated_by = $2 OR EXISTS (SELECT 1 FROM approvals a WHERE a.run_id = r.id AND a.assigned_role = ANY($3)))
              AND ($4::text IS NULL OR r.state = $4) AND ($5::uuid IS NULL OR r.workflow_id = $5)
            ORDER BY r.created_at DESC LIMIT 100`,
          [all, t.userId, t.functionalRoles, q.state ?? null, q.workflow_id ?? null],
        )
      ).rows;
      return { runs: rows };
    });
  });

  app.get(`${base}/runs/:id`, async (req) => {
    const t = req.tenant!;
    const id = assertUuid((req.params as { id: string }).id, "run");
    return tx(pool, t, async (db) => {
      await WorkflowRunner.expireStale(db);
      const run = (
        await db.query(
          `SELECT r.*, w.name AS workflow_name, v.version AS workflow_version, v.graph, u.email AS initiated_by_email
             FROM workflow_runs r JOIN workflows w ON w.id = r.workflow_id JOIN workflow_versions v ON v.id = r.workflow_version_id
             LEFT JOIN users u ON u.id = r.initiated_by WHERE r.id=$1`,
          [id],
        )
      ).rows[0];
      if (!run || !(await canSeeRun(db, t, run))) throw notFound("run");
      const steps = await redactOutputs(db, (await db.query("SELECT id, seq, node_id, node_type, state, attempt, hop, agent_version_id, output, error, started_at, finished_at FROM run_steps WHERE run_id=$1 ORDER BY seq", [id])).rows);
      const approvals = (
        await db.query(
          `SELECT a.id, a.step_id, a.kind, a.title, a.assigned_role, a.binding, a.action_hash, a.status, a.expires_at, a.decided_at, a.comment, u.email AS decided_by
             FROM approvals a LEFT JOIN users u ON u.id = a.decided_by WHERE a.run_id=$1 ORDER BY a.created_at`,
          [id],
        )
      ).rows.map((a) => ({
        ...a,
        can_decide: a.status === "PENDING" && hasRole(t, a.assigned_role) && !((run.graph as Graph).policies.separation_of_duties && run.initiated_by === t.userId),
      }));
      const events = (await db.query("SELECT event_id, type, aggregate_id, payload, occurred_at FROM outbox_events WHERE correlation_id=$1 ORDER BY occurred_at, event_id", [id])).rows;
      const { input, ...rest } = run;
      return {
        ...rest,
        // La tarea solo la ven el iniciador y quienes deciden o auditan este run.
        input,
        can_cancel: !["COMPLETED", "FAILED", "CANCELLED"].includes(run.state) && (run.initiated_by === t.userId || isAdmin(t)),
        steps,
        approvals,
        events,
      };
    });
  });

  app.post(`${base}/runs/:id/cancel`, async (req) => {
    const t = req.tenant!;
    const id = assertUuid((req.params as { id: string }).id, "run");
    return tx(pool, t, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext('run:' || $1))", [id]);
      const run = (await db.query("SELECT id, initiated_by, state FROM workflow_runs WHERE id=$1", [id])).rows[0];
      if (!run || !(await canSeeRun(db, t, run))) throw notFound("run");
      if (run.initiated_by !== t.userId && !isAdmin(t)) throw forbidden("only the initiator or an admin can cancel");
      if (["COMPLETED", "FAILED", "CANCELLED"].includes(run.state)) throw conflict(`run is ${run.state}`);
      await db.query("UPDATE workflow_runs SET state='CANCELLED', error_code='cancelled', updated_at=now(), completed_at=now() WHERE id=$1", [id]);
      await db.query("UPDATE approvals SET status='REVOKED' WHERE run_id=$1 AND status='PENDING'", [id]);
      await emit(db, t.organizationId, "WORKFLOW_CANCELLED", id, id, { by: t.userId });
      await audit(db, t, "workflow.run_cancelled", `workflow_run:${id}`);
      return { state: "CANCELLED" };
    });
  });

  // ---------------------------------------------------------------- Inbox y decisiones
  app.get(`${base}/inbox`, async (req) => {
    const t = req.tenant!;
    return tx(pool, t, async (db) => {
      await WorkflowRunner.expireStale(db);
      const pending = (
        await db.query(
          `SELECT a.id, a.run_id, a.kind, a.title, a.assigned_role, a.binding, a.action_hash, a.expires_at, a.created_at,
                  r.initiated_by, u.email AS initiated_by_email, w.name AS workflow_name, v.graph->'policies'->>'separation_of_duties' AS sod
             FROM approvals a JOIN workflow_runs r ON r.id = a.run_id JOIN workflows w ON w.id = r.workflow_id
             JOIN workflow_versions v ON v.id = r.workflow_version_id LEFT JOIN users u ON u.id = r.initiated_by
            WHERE a.status = 'PENDING' AND a.assigned_role = ANY($1) ORDER BY a.expires_at`,
          [t.functionalRoles],
        )
      ).rows;
      // Estado del binding: si un documento aprobado cambió, la aprobación se invalidará al decidir.
      const docIds = [...new Set(pending.flatMap((p) => (p.binding.documents ?? []).map((d: { document_id: string }) => d.document_id)))];
      const cur = docIds.length ? (await db.query("SELECT document_id, current_version_id, status FROM app.current_versions($1::uuid[])", [docIds])).rows : [];
      const items = pending.map((p) => {
        const stale = (p.binding.documents ?? []).some((d: { document_id: string; version_id: string }) => {
          const c = cur.find((r) => r.document_id === d.document_id);
          return !c || c.status !== "active" || c.current_version_id !== d.version_id;
        });
        const selfRun = p.sod === "true" && p.initiated_by === t.userId;
        return { id: p.id, run_id: p.run_id, kind: p.kind, title: p.title, assigned_role: p.assigned_role, workflow_name: p.workflow_name, initiated_by_email: p.initiated_by_email, expires_at: p.expires_at, created_at: p.created_at, documents: (p.binding.documents ?? []).length, invalidated: stale, blocked_by_sod: selfRun };
      });
      const mine = (
        await db.query(
          `SELECT r.id, r.state, r.error_code, r.updated_at, w.name AS workflow_name FROM workflow_runs r JOIN workflows w ON w.id = r.workflow_id
            WHERE r.initiated_by = $1 AND (r.state IN ('WAITING_HUMAN', 'RUNNING', 'QUEUED') OR (r.state IN ('FAILED', 'CANCELLED') AND r.updated_at > now() - interval '14 days'))
            ORDER BY r.updated_at DESC LIMIT 20`,
          [t.userId],
        )
      ).rows;
      const agents = items.filter((i) => !i.blocked_by_sod).length;
      // Two inboxes (ADR-035): what agents/workflows need from you, and what colleagues ask you (team requests).
      const people = await peopleAttentionCount(db, t.userId);
      return { roles: t.functionalRoles, approvals: items, my_runs: mine, counts: { actionable: agents, agents, people, total: agents + people } };
    });
  });

  app.post(`${base}/approvals/:id/decision`, async (req) => {
    const t = req.tenant!;
    const id = assertUuid((req.params as { id: string }).id, "approval");
    return runner.decide(t, id, Decision.parse(req.body), { amr: req.user?.amr ?? [] });
  });

  // ---------------------------------------------------------------- roles funcionales
  app.get(`${base}/functional-roles`, async (req) => {
    const t = req.tenant!;
    if (!isAdmin(t)) throw forbidden("requires admin");
    return tx(pool, t, async (db) => {
      const rows = (
        await db.query(
          `SELECT u.id, u.email, u.display_name, m.role AS org_role, coalesce(array_agg(f.role ORDER BY f.role) FILTER (WHERE f.role IS NOT NULL), '{}') AS roles
             FROM memberships m JOIN users u ON u.id = m.user_id
             LEFT JOIN functional_roles f ON f.user_id = m.user_id AND f.organization_id = m.organization_id
            WHERE m.organization_id = $1 AND m.status = 'active' GROUP BY u.id, u.email, u.display_name, m.role ORDER BY u.email`,
          [t.organizationId],
        )
      ).rows;
      return { roles: FUNCTIONAL_ROLES, members: rows };
    });
  });

  app.put(`${base}/members/:user/functional-roles`, async (req) => {
    const t = req.tenant!;
    if (!isAdmin(t)) throw forbidden("requires admin");
    const user = assertUuid((req.params as { user: string }).user, "member");
    const body = SetRoles.parse(req.body);
    return tx(pool, t, async (db) => {
      const m = await db.query("SELECT 1 FROM memberships WHERE organization_id=$1 AND user_id=$2 AND status='active'", [t.organizationId, user]);
      if (!m.rowCount) throw notFound("member");
      const before = (await db.query("SELECT role FROM functional_roles WHERE user_id=$1", [user])).rows.map((r) => r.role as string);
      await db.query("DELETE FROM functional_roles WHERE user_id=$1", [user]);
      for (const role of new Set(body.roles)) {
        await db.query("INSERT INTO functional_roles (organization_id, user_id, role, granted_by) VALUES ($1,$2,$3,$4)", [t.organizationId, user, role, t.userId]);
      }
      await audit(db, t, "member.functional_roles_set", `user:${user}`, "allow", { from: before, to: [...new Set(body.roles)] });
      return { user_id: user, roles: [...new Set(body.roles)] };
    });
  });
}
