/**
 * Orquestador durable de workflows (hito E, ADR-022).
 *
 * Cada transición se persiste en Postgres (workflow_runs / run_steps / approvals) con un lock por run antes de
 * ejecutar la siguiente; los eventos de dominio salen por outbox en la misma transacción. Un paso AGENT_TASK marca
 * RUNNING, ejecuta fuera de la transacción y vuelve a persistir: si el proceso cae, `resumePending()` lo reintenta.
 * Las esperas humanas no ocupan ningún proceso: el run queda WAITING_HUMAN hasta una decisión.
 *
 * Producción: este runner en proceso es la costura para Step Functions Standard (callback de aprobación) o un
 * consumidor SQS; el modelo de datos y las reglas no cambian.
 */
import { createHash } from "node:crypto";
import type { Deps } from "../app.js";
import { withContext, type Db } from "../db/pool.js";
import { executeAgent, type AgentExecution } from "./agent-sandbox.js";
import { ApiError, conflict, forbidden, notFound } from "./errors.js";
import { canonical, effectiveSpaces, type AgentConfig } from "./policy.js";
import { hasRole, resolveTenant, tx, type TenantContext } from "./tenant.js";
import { nextNode, WORKFLOW_POLICY_VERSION, type Graph, type Node } from "./workflow-dsl.js";
import { actionDetails, loadPolicy, runExternal, setLifecycle, type RunInput } from "./external-actions.js";

const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
const sha = (v: unknown) => createHash("sha256").update(canonical(v)).digest("hex");

interface RunRow {
  id: string;
  organization_id: string;
  workflow_id: string;
  workflow_version_id: string;
  initiated_by: string;
  state: string;
  input: RunInput;
  usage: { agent_calls: number; retrieval_calls: number };
}

interface StepRow {
  id: string;
  seq: number;
  node_id: string;
  node_type: string;
  state: string;
  attempt: number;
  hop: number;
  agent_version_id: string | null;
  output: Record<string, unknown>;
}

export async function emit(db: Db, orgId: string, type: string, correlationId: string, aggregateId: string, payload: Record<string, unknown>) {
  await db.query(
    `INSERT INTO outbox_events (organization_id, type, correlation_id, aggregate_id, payload, payload_hash) VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
    [orgId, type, correlationId, aggregateId, JSON.stringify(payload), sha(payload)],
  );
}

export async function auditAs(db: Db, orgId: string, actor: string | null, action: string, resource: string, decision: "allow" | "deny", metadata: Record<string, unknown>) {
  await db.query("INSERT INTO audit_events (organization_id, actor_id, action, resource, decision, metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb)", [
    orgId,
    actor,
    action,
    resource,
    decision,
    JSON.stringify(actor ? metadata : { ...metadata, system: "workflow-runner" }),
  ]);
}

export async function failRun(db: Db, run: Pick<RunRow, "id" | "organization_id">, code: string, detail: string) {
  await db.query("UPDATE workflow_runs SET state='FAILED', error_code=$2, error_detail=$3, updated_at=now(), completed_at=now() WHERE id=$1", [run.id, code, detail]);
  await db.query("UPDATE approvals SET status='REVOKED' WHERE run_id=$1 AND status='PENDING'", [run.id]);
  await emit(db, run.organization_id, "WORKFLOW_FAILED", run.id, run.id, { error_code: code, detail });
  await auditAs(db, run.organization_id, null, "workflow.run_failed", `workflow_run:${run.id}`, "allow", { error_code: code });
}

function evalCondition(node: Extract<Node, { type: "CONDITION" }>, out: Record<string, unknown>): boolean {
  const answer = typeof out.answer === "string" ? out.answer : "";
  if (node.check === "has_answer") return !!answer && out.abstained !== true;
  if (node.check === "has_citations") return Array.isArray(out.citations) && out.citations.length > 0;
  return !!answer && answer.toLowerCase().includes((node.value ?? "").toLowerCase());
}

type Plan =
  | { kind: "continue" }
  | { kind: "stop" }
  | { kind: "agent"; run: RunRow; step: StepRow; node: Extract<Node, { type: "AGENT_TASK" }>; graph: Graph; prior: StepRow[] }
  | { kind: "external"; run: RunRow; step: StepRow; node: Extract<Node, { type: "EXTERNAL_ACTION" }>; graph: Graph; prior: StepRow[] };

export class WorkflowRunner {
  private inflight = new Set<Promise<void>>();
  private chains = new Map<string, Promise<void>>();
  /** Backoff entre reintentos (ms base); los tests lo reducen. */
  backoffMs = 250;

  constructor(private readonly deps: Deps) {}

  private sys<T>(orgId: string, fn: (db: Db) => Promise<T>) {
    return withContext(this.deps.pool, { organizationId: orgId }, fn);
  }

  /** Encola el avance de un run; serializa por run dentro del proceso. */
  enqueue(orgId: string, runId: string): void {
    const prev = this.chains.get(runId) ?? Promise.resolve();
    const p = prev
      .then(() => this.advance(orgId, runId))
      .catch((err) => console.error(JSON.stringify({ level: "error", msg: "workflow advance failed", run_id: runId, err: String(err) })))
      .finally(() => {
        this.inflight.delete(p);
        if (this.chains.get(runId) === p) this.chains.delete(runId);
      });
    this.chains.set(runId, p);
    this.inflight.add(p);
  }

  /** Espera a que no haya avances en curso (tests y apagado ordenado). */
  async drain(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  /** Reanuda runs en ejecución y esperas cuyo sobre se cerró antes del reinicio. */
  async resumePending(): Promise<number> {
    const r = await withContext(this.deps.pool, {}, (db) => db.query("SELECT organization_id, run_id FROM app.pending_workflow_runs()"));
    for (const row of r.rows) {
      if (!(await this.signal(row.organization_id, row.run_id))) this.enqueue(row.organization_id, row.run_id);
    }
    return r.rowCount ?? 0;
  }

  async advance(orgId: string, runId: string): Promise<void> {
    for (let i = 0; i < 64; i++) {
      const plan = await this.tick(orgId, runId);
      if (plan.kind === "stop") return;
      if (plan.kind === "agent") await this.runAgent(orgId, plan);
      if (plan.kind === "external") await runExternal(this, this.deps, orgId, plan);
    }
  }

  private async tick(orgId: string, runId: string): Promise<Plan> {
    return this.sys(orgId, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext('run:' || $1))", [runId]);
      const run = (await db.query("SELECT * FROM workflow_runs WHERE id=$1", [runId])).rows[0] as RunRow | undefined;
      if (!run || TERMINAL.has(run.state) || run.state === "WAITING_HUMAN" || run.state === "WAITING_EXTERNAL") return { kind: "stop" };
      const graph = (await db.query("SELECT graph FROM workflow_versions WHERE id=$1", [run.workflow_version_id])).rows[0].graph as Graph;
      const steps = (await db.query("SELECT * FROM run_steps WHERE run_id=$1 ORDER BY seq", [runId])).rows as StepRow[];
      const byId = new Map(graph.nodes.map((n) => [n.id, n]));
      const last = steps.at(-1);

      if (last?.state === "RUNNING") {
        const node = byId.get(last.node_id);
        if (node?.type === "AGENT_TASK") return { kind: "agent", run, step: last, node, graph, prior: steps.slice(0, -1) };
        if (node?.type === "EXTERNAL_ACTION") return { kind: "external", run, step: last, node, graph, prior: steps.slice(0, -1) };
        return { kind: "stop" };
      }
      if (last && last.state !== "SUCCEEDED") return { kind: "stop" };

      const nodeId = !last
        ? graph.nodes.find((n) => n.type === "START")!.id
        : nextNode(graph, last.node_id, last.node_type === "CONDITION" ? last.output.result === true : undefined);
      const node = nodeId ? byId.get(nodeId) : undefined;
      if (!node) {
        await failRun(db, run, "graph_dead_end", `no edge after ${last?.node_id}`);
        return { kind: "stop" };
      }
      if (run.state === "QUEUED") await db.query("UPDATE workflow_runs SET state='RUNNING', updated_at=now() WHERE id=$1", [runId]);
      const seq = steps.length + 1;
      const insertStep = async (state: string, output: Record<string, unknown> = {}, extra: { hop?: number; agent_version_id?: string } = {}) =>
        (
          await db.query(
            `INSERT INTO run_steps (organization_id, run_id, seq, node_id, node_type, state, hop, agent_version_id, output, finished_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb, CASE WHEN $6 IN ('SUCCEEDED','FAILED','REJECTED','SKIPPED') THEN now() END) RETURNING *`,
            [orgId, runId, seq, node.id, node.type, state, extra.hop ?? 0, extra.agent_version_id ?? null, JSON.stringify(output)],
          )
        ).rows[0] as StepRow;

      switch (node.type) {
        case "START":
          await insertStep("SUCCEEDED");
          return { kind: "continue" };
        case "END":
          await insertStep("SUCCEEDED", { outcome: node.label ?? "completed" });
          await db.query("UPDATE workflow_runs SET state='COMPLETED', updated_at=now(), completed_at=now() WHERE id=$1", [runId]);
          await emit(db, orgId, "WORKFLOW_COMPLETED", runId, runId, { end_node: node.id, usage: run.usage });
          await auditAs(db, orgId, null, "workflow.run_completed", `workflow_run:${runId}`, "allow", { end_node: node.id });
          return { kind: "stop" };
        case "CONDITION": {
          const src = steps.find((s) => s.node_id === node.source);
          const result = src ? evalCondition(node, src.output) : false;
          await insertStep("SUCCEEDED", { result, check: node.check });
          return { kind: "continue" };
        }
        case "HUMAN_REVIEW":
        case "APPROVAL_GATE": {
          const agentSteps = steps.filter((s) => s.node_type === "AGENT_TASK");
          const docs = new Map<string, string>();
          for (const s of agentSteps) {
            for (const c of (s.output.citations as { document_id: string; version_id?: string }[] | undefined) ?? []) {
              if (c.version_id) docs.set(c.document_id, c.version_id);
            }
          }
          const next = nextNode(graph, node.id);
          const binding = {
            run_id: runId,
            node_id: node.id,
            action: { kind: node.type, next: next ? { id: next, type: byId.get(next)?.type } : null },
            purpose: node.label ?? node.type,
            // Detalle de la acción siguiente (sobre a enviar, destinatarios a compartir): parte del hash aprobado.
            details: await actionDetails(db, orgId, run, next ? byId.get(next) : undefined),
            documents: [...docs].map(([document_id, version_id]) => ({ document_id, version_id })).sort((a, b) => a.document_id.localeCompare(b.document_id)),
            outputs_hash: sha(agentSteps.map((s) => ({ node: s.node_id, answer: s.output.answer ?? null, citations: ((s.output.citations as { document_id: string; version_id?: string; page?: number | null }[]) ?? []).map((c) => [c.document_id, c.version_id ?? null, c.page ?? null]) }))),
          };
          const actionHash = sha(binding);
          const step = await insertStep("WAITING", { awaiting: node.role });
          const a = await db.query(
            `INSERT INTO approvals (organization_id, run_id, step_id, kind, title, assigned_role, binding, action_hash, expires_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8, now() + make_interval(hours => $9)) RETURNING id, expires_at`,
            [orgId, runId, step.id, node.type === "HUMAN_REVIEW" ? "review" : "approval", node.label ?? node.type, node.role, JSON.stringify(binding), actionHash, node.expires_hours],
          );
          await db.query("UPDATE workflow_runs SET state='WAITING_HUMAN', updated_at=now() WHERE id=$1", [runId]);
          await emit(db, orgId, "APPROVAL_REQUESTED", runId, `approval:${a.rows[0].id}`, {
            action: node.type,
            assigned_role: node.role,
            document_version_ids: binding.documents.map((d) => d.version_id),
            action_hash: actionHash,
            expires_at: a.rows[0].expires_at,
          });
          await auditAs(db, orgId, null, "approval.requested", `approval:${a.rows[0].id}`, "allow", { run_id: runId, role: node.role, action_hash: actionHash });
          return { kind: "stop" };
        }
        case "AGENT_TASK": {
          const policies = graph.policies;
          if (run.usage.agent_calls >= policies.budget.max_agent_calls) {
            await insertStep("FAILED", { reason: "budget_exhausted" });
            await failRun(db, run, "budget_exhausted", `agent call budget (${policies.budget.max_agent_calls}) exhausted`);
            return { kind: "stop" };
          }
          const hop = steps.filter((s) => s.node_type === "AGENT_TASK").length + 1;
          const step = await insertStep("RUNNING", {}, { hop, agent_version_id: node.agent_version_id });
          const usage = { ...run.usage, agent_calls: run.usage.agent_calls + 1 };
          await db.query("UPDATE workflow_runs SET usage=$2::jsonb, updated_at=now() WHERE id=$1", [runId, JSON.stringify(usage)]);
          await emit(db, orgId, "AGENT_RUN_STARTED", runId, `run_step:${step.id}`, { node_id: node.id, agent: node.agent, agent_version: node.agent_version, hop });
          return { kind: "agent", run: { ...run, usage }, step, node, graph, prior: steps };
        }
        case "EXTERNAL_ACTION": {
          const step = await insertStep("RUNNING", { tool: node.tool });
          return { kind: "external", run, step, node, graph, prior: steps };
        }
        case "WAIT_EVENT": {
          const env = (await db.query("SELECT id, state FROM signature_envelopes WHERE run_id=$1 ORDER BY created_at DESC LIMIT 1", [runId])).rows[0];
          if (!env) {
            await insertStep("FAILED", { reason: "envelope_missing" });
            await failRun(db, run, "envelope_missing", "nothing to wait for");
            return { kind: "stop" };
          }
          // El evento pudo llegar antes que este paso: se resuelve sin esperar.
          if (env.state === "COMPLETED") {
            await insertStep("SUCCEEDED", { event: node.event, envelope_id: env.id, state: env.state });
            return { kind: "continue" };
          }
          if (env.state === "DECLINED" || env.state === "VOIDED") {
            await insertStep("FAILED", { event: node.event, envelope_id: env.id, state: env.state });
            await failRun(db, run, env.state === "DECLINED" ? "signature_declined" : "signature_voided", `envelope ${env.state.toLowerCase()}`);
            return { kind: "stop" };
          }
          await insertStep("WAITING", { event: node.event, envelope_id: env.id, state: env.state });
          await db.query("UPDATE workflow_runs SET state='WAITING_EXTERNAL', updated_at=now() WHERE id=$1", [runId]);
          await auditAs(db, orgId, null, "workflow.waiting_external", `workflow_run:${runId}`, "allow", { event: node.event, envelope_id: env.id });
          return { kind: "stop" };
        }
        default:
          await insertStep("FAILED", { reason: "node_unavailable" });
          await failRun(db, run, "node_unavailable", `${(node as Node).type} is not available in this phase`);
          return { kind: "stop" };
      }
    });
  }

  private async runAgent(orgId: string, plan: Extract<Plan, { kind: "agent" }>): Promise<void> {
    const { run, step, node, graph, prior } = plan;
    const finish = (fn: (db: Db) => Promise<void>) => this.sys(orgId, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext('run:' || $1))", [run.id]);
      const cur = (await db.query("SELECT state FROM workflow_runs WHERE id=$1", [run.id])).rows[0];
      if (!cur || TERMINAL.has(cur.state)) return; // cancelado mientras se ejecutaba: no se persiste el resultado
      await fn(db);
    });
    const stepFail = (code: string, detail: string, output: Record<string, unknown> = {}) =>
      finish(async (db) => {
        await db.query("UPDATE run_steps SET state='FAILED', error=$2, output=$3::jsonb, finished_at=now() WHERE id=$1", [step.id, code, JSON.stringify(output)]);
        await failRun(db, run, code, detail);
      });

    // Permisos del iniciador resueltos de nuevo en cada paso: si perdió acceso, el run no continúa con privilegios viejos.
    let t: TenantContext;
    try {
      t = await resolveTenant(this.deps.pool, run.initiated_by, orgId);
    } catch {
      return stepFail("initiator_access_revoked", "the run initiator is no longer an active member");
    }
    const meta = await this.sys(orgId, async (db) => {
      const v = (await db.query("SELECT v.config, a.status FROM agent_versions v JOIN agents a ON a.id = v.agent_id WHERE v.id=$1", [node.agent_version_id])).rows[0];
      const p = (await db.query("SELECT llm_policy FROM organization_profiles WHERE organization_id=$1", [orgId])).rows[0];
      return { config: v?.config as AgentConfig | undefined, status: v?.status as string | undefined, llmPolicy: p?.llm_policy ?? null };
    });
    if (!meta.config) return stepFail("agent_version_missing", `pinned version of ${node.agent} not found`);
    if (meta.status !== "published") return stepFail("agent_inactive", `agent ${node.agent} is ${meta.status}`);
    const subject = { role: t.role, dataClass: t.dataClass, workspaces: t.workspaces, llmPolicy: meta.llmPolicy };

    // Delegación: el agente siguiente recibe solo fragmentos de espacios que él mismo puede usar (∩ iniciador).
    const calleeSpaces = new Set(effectiveSpaces(meta.config, subject));
    const priorAgents = prior.filter((s) => s.node_type === "AGENT_TASK" && s.state === "SUCCEEDED");
    let passed = 0;
    let withheld = 0;
    for (const s of priorAgents) {
      for (const c of (s.output.citations as { space_id: string }[] | undefined) ?? []) calleeSpaces.has(c.space_id) ? passed++ : withheld++;
    }
    const context_received = { from: priorAgents.map((s) => s.node_id), hop: step.hop, citations_passed: passed, citations_withheld: withheld };
    if (!calleeSpaces.size) {
      return stepFail("delegation_denied", `${node.agent} has no space in common with the run initiator's access`, { context_received });
    }

    const remaining = Math.max(0, graph.policies.budget.max_retrieval_calls - run.usage.retrieval_calls);
    if (remaining === 0) return stepFail("budget_exhausted", "retrieval call budget exhausted", { context_received });

    let x: AgentExecution;
    try {
      x = await executeAgent(this.deps, t, subject, meta.config, run.input.task, { sandbox: false, maxRetrievalCalls: remaining });
    } catch (err) {
      x = { failed: true, failure: "agent_error", retryable: true, steps: [], answer: null, abstained: false, citations: [], proposals: [], retrieval_calls: 0, spaces: [] };
      console.error(JSON.stringify({ level: "error", msg: "agent execution error", run_id: run.id, err: String(err) }));
    }

    if (x.failed && x.retryable && step.attempt <= meta.config.limits.max_retries) {
      await finish(async (db) => {
        await db.query("UPDATE run_steps SET attempt=attempt+1, error=$2 WHERE id=$1", [step.id, x.failure]);
        await db.query("UPDATE workflow_runs SET usage = jsonb_set(usage, '{retrieval_calls}', to_jsonb((usage->>'retrieval_calls')::int + $2)) WHERE id=$1", [run.id, x.retrieval_calls]);
      });
      await new Promise((r) => setTimeout(r, this.backoffMs * 2 ** (step.attempt - 1)));
      return;
    }

    const output = {
      answer: x.answer,
      abstained: x.abstained,
      citations: x.citations,
      proposals: x.proposals,
      spaces: x.spaces,
      context_received,
      trace: x.steps.map(({ detail: _d, ...s }) => s),
    };
    if (x.failed) {
      const code = x.failure === "budget_exhausted" ? "budget_exhausted" : `agent_${x.failure}`;
      await finish(async (db) => {
        await db.query("UPDATE workflow_runs SET usage = jsonb_set(usage, '{retrieval_calls}', to_jsonb((usage->>'retrieval_calls')::int + $2)) WHERE id=$1", [run.id, x.retrieval_calls]);
        await db.query("UPDATE run_steps SET state='FAILED', error=$2, output=$3::jsonb, finished_at=now() WHERE id=$1", [step.id, code, JSON.stringify(output)]);
        await failRun(db, run, code, `${node.agent}: ${x.failure}`);
      });
      return;
    }
    await finish(async (db) => {
      await db.query("UPDATE workflow_runs SET usage = jsonb_set(usage, '{retrieval_calls}', to_jsonb((usage->>'retrieval_calls')::int + $2)), updated_at=now() WHERE id=$1", [run.id, x.retrieval_calls]);
      await db.query("UPDATE run_steps SET state='SUCCEEDED', output=$2::jsonb, finished_at=now() WHERE id=$1", [step.id, JSON.stringify(output)]);
      await emit(db, orgId, "AGENT_RUN_COMPLETED", run.id, `run_step:${step.id}`, { node_id: node.id, abstained: x.abstained, citations: x.citations.length, proposals: x.proposals.length, withheld });
    });
  }

  /** Un evento verificado del proveedor reanuda (o termina) el run que espera ese sobre. */
  async signal(orgId: string, runId: string): Promise<boolean> {
    const resume = await this.sys(orgId, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext('run:' || $1))", [runId]);
      const run = (await db.query("SELECT id, organization_id, state FROM workflow_runs WHERE id=$1", [runId])).rows[0];
      if (!run || run.state !== "WAITING_EXTERNAL") return false;
      const step = (await db.query("SELECT id, output FROM run_steps WHERE run_id=$1 AND state='WAITING' AND node_type='WAIT_EVENT' ORDER BY seq DESC LIMIT 1", [runId])).rows[0];
      if (!step) return false;
      const env = (await db.query("SELECT id, state FROM signature_envelopes WHERE id=$1", [step.output.envelope_id])).rows[0];
      if (env?.state === "COMPLETED") {
        await db.query("UPDATE run_steps SET state='SUCCEEDED', output = output || jsonb_build_object('state', 'COMPLETED'), finished_at=now() WHERE id=$1", [step.id]);
        await db.query("UPDATE workflow_runs SET state='RUNNING', updated_at=now() WHERE id=$1", [runId]);
        return true;
      }
      if (env?.state === "DECLINED" || env?.state === "VOIDED") {
        await db.query("UPDATE run_steps SET state='FAILED', error=$2, finished_at=now() WHERE id=$1", [step.id, env.state.toLowerCase()]);
        await failRun(db, run, env.state === "DECLINED" ? "signature_declined" : "signature_voided", `envelope ${env.state.toLowerCase()}`);
      }
      return false;
    });
    if (resume) this.enqueue(orgId, runId);
    return resume;
  }

  /**
   * Decisión humana sobre una aprobación. Autoridad humana + hash exacto + vigencia + separación de funciones.
   * Las denegaciones se auditan y hacen commit; el error se lanza fuera de la transacción.
   */
  async decide(t: TenantContext, approvalId: string, body: { decision: "approve" | "reject"; action_hash: string; comment?: string }, actor: { amr: string[] } = { amr: [] }) {
    type Out = { error: ApiError } | { run_id: string; status: string };
    const out = await tx(this.deps.pool, t, async (db): Promise<Out> => {
      const a = (await db.query("SELECT * FROM approvals WHERE id=$1", [approvalId])).rows[0];
      if (!a) return { error: notFound("approval") };
      await db.query("SELECT pg_advisory_xact_lock(hashtext('run:' || $1))", [a.run_id]);
      const run = (await db.query("SELECT r.*, v.graph FROM workflow_runs r JOIN workflow_versions v ON v.id = r.workflow_version_id WHERE r.id=$1", [a.run_id])).rows[0];
      const deny = async (err: ApiError, reason: string) => {
        await auditAs(db, t.organizationId, t.userId, "approval.decision", `approval:${a.id}`, "deny", { reason, run_id: a.run_id });
        return { error: err };
      };
      if (!hasRole(t, a.assigned_role)) return deny(forbidden(`requires the ${a.assigned_role} role`), "missing_role");
      if (a.status !== "PENDING") return deny(conflict(`approval is ${a.status}`), "not_pending");
      if ((run.graph as Graph).policies.separation_of_duties && run.initiated_by === t.userId) {
        return deny(forbidden("separation of duties: you started this run"), "self_approval");
      }
      if (new Date(a.expires_at).getTime() < Date.now()) {
        await db.query("UPDATE approvals SET status='EXPIRED' WHERE id=$1", [a.id]);
        await db.query("UPDATE run_steps SET state='FAILED', error='approval_expired', finished_at=now() WHERE id=$1", [a.step_id]);
        await failRun(db, run, "approval_expired", "approval expired before a decision");
        return deny(new ApiError(409, "approval_expired", "approval expired"), "expired");
      }
      // Envío de firma: MFA reciente si la política del tenant lo exige (claim `amr` del IdP).
      if (body.decision === "approve" && a.binding.details?.kind === "send_signature" && (await loadPolicy(db, t.organizationId)).require_mfa_for_signature && !actor.amr.some((m) => ["mfa", "otp", "hwk", "swk"].includes(m))) {
        return deny(new ApiError(403, "mfa_required", "approving a signature send requires multi-factor authentication"), "mfa_required");
      }
      if (body.action_hash !== a.action_hash) return deny(new ApiError(409, "stale_action_hash", "what you reviewed no longer matches this approval"), "hash_mismatch");
      const docs = (a.binding.documents ?? []) as { document_id: string; version_id: string }[];
      if (docs.length) {
        const cur = (await db.query("SELECT document_id, current_version_id, status FROM app.current_versions($1::uuid[])", [docs.map((d) => d.document_id)])).rows;
        const changed = docs.filter((d) => {
          const c = cur.find((r) => r.document_id === d.document_id);
          return !c || c.status !== "active" || c.current_version_id !== d.version_id;
        });
        if (changed.length) {
          await db.query("UPDATE approvals SET status='REVOKED', comment='document changed after the approval was requested' WHERE id=$1", [a.id]);
          await db.query("UPDATE run_steps SET state='FAILED', error='approval_invalidated', finished_at=now() WHERE id=$1", [a.step_id]);
          await failRun(db, run, "approval_invalidated", `${changed.length} document(s) changed since the approval was requested`);
          return deny(new ApiError(409, "approval_invalidated", "a bound document changed; the approval was invalidated"), "binding_changed");
        }
      }
      const approve = body.decision === "approve";
      await db.query("UPDATE approvals SET status=$2, decided_by=$3, decided_at=now(), comment=$4 WHERE id=$1", [a.id, approve ? "APPROVED" : "REJECTED", t.userId, body.comment ?? null]);
      await db.query("UPDATE run_steps SET state=$2, output=$3::jsonb, finished_at=now() WHERE id=$1", [a.step_id, approve ? "SUCCEEDED" : "REJECTED", JSON.stringify({ decision: body.decision, by: t.userId, comment: body.comment ?? null })]);
      if (approve) {
        // Las versiones revisadas y aprobadas por una persona quedan APPROVED (requisito para preparar una firma).
        if (docs.length && a.binding.details?.kind !== "send_signature" && a.binding.details?.kind !== "share") {
          const cur = (await db.query("SELECT version_id, state FROM document_lifecycle WHERE version_id = ANY($1::uuid[])", [docs.map((d) => d.version_id)])).rows;
          // Una revisión nueva re-aprueba la versión, salvo que tenga una firma en curso o esté archivada.
          const fresh = docs.filter((d) => !cur.some((c) => c.version_id === d.version_id && ["SIGNATURE_PENDING", "ARCHIVED"].includes(c.state)));
          await setLifecycle(db, t.organizationId, fresh, "APPROVED", a.id);
        }
        await db.query("UPDATE workflow_runs SET state='RUNNING', updated_at=now() WHERE id=$1", [a.run_id]);
      } else {
        // deny_on_reject: nada aguas abajo se ejecuta.
        await db.query("UPDATE workflow_runs SET state='CANCELLED', error_code='rejected_by_human', updated_at=now(), completed_at=now() WHERE id=$1", [a.run_id]);
      }
      await emit(db, t.organizationId, "APPROVAL_DECIDED", a.run_id, `approval:${a.id}`, { decision: body.decision, decided_by: t.userId, action_hash: a.action_hash });
      await auditAs(db, t.organizationId, t.userId, "approval.decision", `approval:${a.id}`, "allow", { decision: body.decision, run_id: a.run_id, action_hash: a.action_hash });
      return { run_id: a.run_id, status: approve ? "APPROVED" : "REJECTED" };
    });
    if ("error" in out) throw out.error;
    if (out.status === "APPROVED") this.enqueue(t.organizationId, out.run_id);
    return out;
  }

  /** Expira aprobaciones vencidas del tenant (perezoso: al listar Inbox/runs). */
  static async expireStale(db: Db): Promise<void> {
    const r = await db.query("UPDATE approvals SET status='EXPIRED' WHERE status='PENDING' AND expires_at < now() RETURNING run_id, step_id, organization_id");
    for (const row of r.rows) {
      await db.query("UPDATE run_steps SET state='FAILED', error='approval_expired', finished_at=now() WHERE id=$1", [row.step_id]);
      const run = (await db.query("SELECT id, organization_id, state FROM workflow_runs WHERE id=$1", [row.run_id])).rows[0];
      if (run && !TERMINAL.has(run.state)) await failRun(db, run, "approval_expired", "approval expired before a decision");
    }
  }
}

export { WORKFLOW_POLICY_VERSION };
