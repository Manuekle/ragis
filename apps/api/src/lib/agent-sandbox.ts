/**
 * Ejecución de agentes (Agent Studio · Playground y pasos AGENT_TASK de workflows, ADR-020/021).
 *
 *  - search_documents corre de verdad contra el RAG, con los principals del usuario que ejecuta (en workflows: el
 *    iniciador del run, resuelto de nuevo en cada paso) y solo sobre (espacios del agente ∩ espacios legibles).
 *    La ACL la aplica la BD antes del retrieval.
 *  - En sandbox toda otra herramienta se simula (decision = mock). Fuera del sandbox las escrituras quedan como
 *    propuestas sin efecto: los efectos los autoriza un paso humano del workflow, nunca el agente.
 *  - El contenido recuperado es dato: nunca decide qué herramienta se invoca ni con qué argumentos.
 */
import type { Deps } from "../app.js";
import { runRagQuery } from "../routes/query.js";
import { ApiError } from "./errors.js";
import { decideTool, effectiveSpaces, toolById, validateAgent, type AgentConfig, type Decision, type PolicySubject } from "./policy.js";
import type { TenantContext } from "./tenant.js";

export interface SandboxStep {
  n: number;
  type: "validate" | "scope" | "tool" | "output";
  tool?: string;
  decision?: Decision;
  reason: string;
  ms: number;
  detail?: Record<string, unknown>;
}

export interface SandboxCitation {
  n: number;
  space_id: string;
  document_id: string;
  version_id?: string;
  title: string;
  page: number | null;
  snippet: string;
}

export interface Proposal {
  tool: string;
  decision: Decision;
  effect: "none";
  note: string;
}

export interface AgentExecution {
  failed: boolean;
  failure?: string;
  /** Error recuperable (servicio caído/limitado): el runner puede reintentar. */
  retryable?: boolean;
  steps: SandboxStep[];
  answer: string | null;
  abstained: boolean;
  citations: SandboxCitation[];
  proposals: Proposal[];
  retrieval_calls: number;
  spaces: string[];
}

export interface SandboxCase {
  name: string;
  status: "passed" | "failed";
  answer: string | null;
  abstained: boolean;
  citations: SandboxCitation[];
  steps: SandboxStep[];
  checks: { name: string; ok: boolean; detail?: string }[];
}

interface RagAnswer {
  answer?: string;
  abstained?: boolean;
  abstain_reason?: string | null;
  citations?: { n: number; document_id: string; version_id?: string; title: string; page: number | null; snippet: string }[];
}

const MAX_SPACES_PER_RUN = 3;

/** Plain-language reason a run stopped, shown in the Studio trace. */
const FAILURE_COPY: Record<string, string> = {
  policy_errors: "some settings need fixing",
  no_space: "no folder to read",
  tool_denied: "an action was blocked",
  max_steps: "reached the step limit",
  timeout: "took too long",
  budget_exhausted: "reached the spending cap",
};

export async function executeAgent(
  deps: Deps,
  t: TenantContext,
  subject: PolicySubject,
  config: AgentConfig,
  input: string,
  opts: { sandbox: boolean; maxRetrievalCalls?: number },
): Promise<AgentExecution> {
  const started = Date.now();
  const steps: SandboxStep[] = [];
  const proposals: Proposal[] = [];
  let failed = false;
  let failure: string | undefined;
  let retryable = false;
  let retrievalCalls = 0;
  const fail = (why: string) => {
    failed = true;
    failure ??= why;
  };
  const step = (s: Omit<SandboxStep, "n" | "ms">, since: number) => steps.push({ ...s, n: steps.length + 1, ms: Date.now() - since });

  let s0 = Date.now();
  const v = validateAgent(config, subject);
  step({ type: "validate", reason: v.ok ? `settings look good · ${v.risk} risk` : `${v.errors.length} setting(s) to fix`, detail: { errors: v.errors, warnings: v.warnings } }, s0);
  if (!v.ok) fail("policy_errors");

  s0 = Date.now();
  const spaces = effectiveSpaces(config, subject).slice(0, MAX_SPACES_PER_RUN);
  step({ type: "scope", reason: spaces.length ? `can read ${spaces.length} folder(s) you also have access to` : "none of the agent's folders are shared with you", detail: { spaces } }, s0);

  let answer: string | null = null;
  const citations: SandboxCitation[] = [];

  if (!failed) {
    for (const toolId of config.tools) {
      if (steps.length >= config.limits.max_steps) {
        fail("max_steps");
        break;
      }
      if (Date.now() - started > config.limits.timeout_seconds * 1000) {
        fail("timeout");
        break;
      }
      s0 = Date.now();
      const d = decideTool(toolId, config, { sandbox: opts.sandbox });
      if (d.decision === "deny") {
        fail("tool_denied");
        step({ type: "tool", tool: toolId, decision: "deny", reason: d.reason }, s0);
        continue;
      }
      if (toolId === "search_documents" && d.decision === "allow") {
        if (!spaces.length) {
          fail("no_space");
          step({ type: "tool", tool: toolId, decision: "deny", reason: "no folder it can read" }, s0);
          continue;
        }
        const per: { space_id: string; abstained: boolean; citations: number }[] = [];
        for (const ws of spaces) {
          if (opts.maxRetrievalCalls !== undefined && retrievalCalls >= opts.maxRetrievalCalls) {
            fail("budget_exhausted");
            break;
          }
          let r: RagAnswer;
          try {
            retrievalCalls++;
            r = (await runRagQuery(deps, t, ws, { question: input, top_k: 5 })) as RagAnswer;
          } catch (e) {
            if (e instanceof ApiError) {
              fail(`retrieval_${e.code}`);
              retryable = e.status === 503 || e.code === "rate_limited";
              step({ type: "tool", tool: toolId, decision: "allow", reason: "search failed in one folder", detail: { space_id: ws } }, s0);
              break;
            }
            throw e;
          }
          per.push({ space_id: ws, abstained: !!r.abstained, citations: r.citations?.length ?? 0 });
          if (!r.abstained && answer === null) answer = r.answer ?? null;
          for (const c of r.citations ?? []) {
            citations.push({ n: citations.length + 1, space_id: ws, document_id: c.document_id, version_id: c.version_id, title: c.title, page: c.page, snippet: (c.snippet ?? "").slice(0, 400) });
          }
        }
        step({ type: "tool", tool: toolId, decision: "allow", reason: d.reason, detail: { results: per } }, s0);
        continue;
      }
      if (opts.sandbox) {
        // Simulada: sin efectos. Argumentos derivados de la definición, nunca del texto recuperado.
        step({ type: "tool", tool: toolId, decision: "mock", reason: d.reason, detail: { simulated: true, would_call: { tool: toolId, kind: toolById(toolId)?.kind, autonomy: config.autonomy, spaces } } }, s0);
      } else {
        const kind = toolById(toolId)?.kind;
        proposals.push({ tool: toolId, decision: d.decision, effect: "none", note: kind === "read" ? "read adapter pending; not executed" : "write proposed for the next human step; not executed" });
        step({ type: "tool", tool: toolId, decision: d.decision, reason: `${d.reason} · saved as a suggestion, nothing changed` }, s0);
      }
    }
  }

  s0 = Date.now();
  const hasRead = config.tools.includes("search_documents");
  const abstained = hasRead && answer === null;
  step({
    type: "output",
    reason: failed ? `stopped: ${FAILURE_COPY[failure!] ?? failure}` : !hasRead ? "no search action — recommendation only" : abstained ? "not enough evidence to answer" : `answered with ${citations.length} source(s)`,
    detail: { output_schema: config.instructions.output_schema },
  }, s0);

  return { failed, failure, retryable, steps, answer, abstained, citations, proposals, retrieval_calls: retrievalCalls, spaces };
}

export async function runCase(
  deps: Deps,
  t: TenantContext,
  subject: PolicySubject,
  config: AgentConfig,
  test: { name: string; input: string; expect_contains?: string; expect_citations?: boolean },
): Promise<SandboxCase> {
  const x = await executeAgent(deps, t, subject, config, test.input, { sandbox: true });
  const checks: SandboxCase["checks"] = [];
  if (x.failure === "max_steps") checks.push({ name: "max_steps", ok: false, detail: `stopped after ${config.limits.max_steps} steps` });
  if (x.failure === "timeout") checks.push({ name: "timeout", ok: false, detail: `took longer than ${config.limits.timeout_seconds} seconds` });
  checks.push({ name: "no_policy_denials", ok: !x.steps.some((s) => s.decision === "deny") && x.failure !== "policy_errors" });
  const hasRead = config.tools.includes("search_documents");
  const wantCites = (test.expect_citations ?? true) && config.knowledge.require_citations && hasRead;
  if (wantCites && x.answer !== null) checks.push({ name: "answer_has_citations", ok: x.citations.length > 0 });
  if (test.expect_contains) {
    const ok = !!x.answer && x.answer.toLowerCase().includes(test.expect_contains.toLowerCase());
    checks.push({ name: "expected_content", ok, detail: `expects "${test.expect_contains}"` });
  }
  if (test.expect_citations && hasRead) checks.push({ name: "expected_citations", ok: x.citations.length > 0 });
  const status = !x.failed && checks.every((c) => c.ok) ? "passed" : "failed";
  return { name: test.name, status, answer: x.answer, abstained: x.abstained, citations: x.citations, steps: x.steps, checks };
}
