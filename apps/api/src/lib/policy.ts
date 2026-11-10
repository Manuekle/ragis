/**
 * Policy Engine de agentes (P0-05, ADR-020).
 *
 * Funciones puras y deterministas: catálogo de herramientas con riesgo, validación de definiciones de agente,
 * decisión por invocación (deny-by-default) y diff de permisos entre versiones. El LLM nunca participa en
 * estas decisiones y ningún texto recuperado de documentos puede alterarlas.
 */
import { createHash } from "node:crypto";
import { z } from "zod";

export const POLICY_VERSION = "agent-policy-v1";

export type Risk = "low" | "medium" | "high" | "critical";
export const RISK_ORDER: Record<Risk, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export type ToolKind = "read" | "write" | "external";

export interface ToolDef {
  id: string;
  label: string;
  description: string;
  risk: Risk;
  kind: ToolKind;
  /** Disponible para agentes en esta fase. Las no disponibles nunca pasan validación. */
  available: boolean;
  /** Por qué no está disponible (fase del roadmap o prohibición). */
  unavailable_reason?: string;
  /** En sandbox: "real" ejecuta (solo lectura, con ACL del usuario); "mock" simula sin efectos. */
  sandbox: "real" | "mock";
}

export const TOOL_CATALOG: readonly ToolDef[] = [
  { id: "search_documents", label: "Search documents", description: "Finds answers in the agent's folders and cites the source. Only documents the person can already see.", risk: "low", kind: "read", available: true, sandbox: "real" },
  { id: "retrieve_evidence", label: "Quote the source", description: "Pulls the exact quoted passage, page and version so anyone can check it.", risk: "low", kind: "read", available: true, sandbox: "mock" },
  { id: "get_document_version", label: "Read document details", description: "Reads basic details of a document: title, version and dates.", risk: "low", kind: "read", available: true, sandbox: "mock" },
  { id: "extract_fields", label: "Pull out key data", description: "Pulls key data (dates, amounts, names) out of documents.", risk: "low", kind: "read", available: true, sandbox: "mock" },
  { id: "compare_versions", label: "Compare versions", description: "Shows what changed between two versions of a document.", risk: "low", kind: "read", available: true, sandbox: "mock" },
  { id: "create_draft", label: "Create draft", description: "Writes a new draft. The original is never touched.", risk: "medium", kind: "write", available: true, sandbox: "mock" },
  { id: "annotate_document", label: "Annotate document", description: "Adds review comments to a draft.", risk: "medium", kind: "write", available: true, sandbox: "mock" },
  { id: "create_review_task", label: "Create review task", description: "Creates a review task for the people you choose.", risk: "medium", kind: "write", available: true, sandbox: "mock" },
  { id: "request_approval", label: "Request approval", description: "Asks a specific person to approve or reject something.", risk: "medium", kind: "write", available: true, sandbox: "mock" },
  { id: "create_signature_draft", label: "Prepare signature request", description: "Prepares a signature request for an approved document. Only happens after a person approves.", risk: "high", kind: "external", available: true, sandbox: "mock" },
  { id: "send_signature_envelope", label: "Send for signature", description: "Sends the signature request to the signers. Only happens right after a person approves it.", risk: "critical", kind: "external", available: true, sandbox: "mock" },
  { id: "send_email", label: "Send email", description: "Emails people at approved domains.", risk: "high", kind: "external", available: false, unavailable_reason: "Coming soon — use share links for now", sandbox: "mock" },
  { id: "share_document", label: "Share document", description: "Shares a link that expires, only with approved domains. Only happens right after a person approves.", risk: "high", kind: "external", available: true, sandbox: "mock" },
  { id: "delete_document", label: "Delete document", description: "Permanently deletes a document.", risk: "critical", kind: "write", available: false, unavailable_reason: "Agents can never do this — only an admin, by hand", sandbox: "mock" },
  { id: "change_acl", label: "Change permissions", description: "Changes who can see a document.", risk: "critical", kind: "write", available: false, unavailable_reason: "Agents can never do this — only an admin, by hand", sandbox: "mock" },
];

const TOOLS = new Map(TOOL_CATALOG.map((t) => [t.id, t]));
export const toolById = (id: string) => TOOLS.get(id);

export const AUTONOMY = ["suggest", "draft_only", "safe_execute", "approval_required"] as const;
export type Autonomy = (typeof AUTONOMY)[number];
export const MODEL_PROFILES = ["fast", "reasoning", "vision", "local"] as const;
export type ModelProfile = (typeof MODEL_PROFILES)[number];
export const OUTPUT_SCHEMAS = ["answer_with_citations.v1", "audit_findings.v1", "review_comments.v1", "version_diff.v1", "extracted_fields.v1", "compliance_deviations.v1"] as const;

/** Límites duros por tenant: el agente puede pedir menos, nunca más. */
export const TENANT_LIMITS = { max_steps: 20, timeout_seconds: 600, usd_per_run: 5, max_retries: 3, concurrency: 5 } as const;

const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,60}$/);

export const AgentConfig = z
  .object({
    name: z.string().trim().min(2).max(80),
    purpose: z.string().trim().min(10).max(400),
    icon: z.string().trim().max(32).default("sparkles"),
    category: z.enum(["search", "audit", "review", "compare", "extract", "compliance", "coordination", "monitoring", "custom"]).default("custom"),
    instructions: z
      .object({
        objective: z.string().trim().min(10).max(4000),
        boundaries: z.string().trim().max(2000).default(""),
        tone: z.enum(["neutral", "formal", "concise", "didactic"]).default("neutral"),
        checklist: z.array(z.string().trim().min(1).max(300)).max(30).default([]),
        output_schema: z.enum(OUTPUT_SCHEMAS).default("answer_with_citations.v1"),
      })
      .strict(),
    knowledge: z
      .object({
        space_ids: z.array(z.string().uuid()).max(20).default([]),
        require_citations: z.boolean().default(true),
      })
      .strict(),
    model: z
      .object({
        profile: z.enum(MODEL_PROFILES).default("reasoning"),
        temperature: z.number().min(0).max(1).default(0.1),
        token_budget: z.number().int().min(500).max(64_000).default(8000),
      })
      .strict(),
    tools: z.array(z.string().min(1).max(64)).max(20).default([]),
    autonomy: z.enum(AUTONOMY).default("suggest"),
    triggers: z.array(z.enum(["manual", "event", "schedule", "workflow"])).min(1).max(4).default(["manual"]),
    limits: z
      .object({
        max_steps: z.number().int().min(1).max(50).default(8),
        timeout_seconds: z.number().int().min(5).max(3600).default(120),
        usd_per_run: z.number().min(0).max(100).default(0.2),
        max_retries: z.number().int().min(0).max(10).default(1),
        concurrency: z.number().int().min(1).max(50).default(1),
      })
      .strict(),
    tests: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(120),
            input: z.string().trim().min(2).max(2000),
            expect_contains: z.string().trim().max(200).optional(),
            expect_citations: z.boolean().default(true),
          })
          .strict(),
      )
      .max(10)
      .default([]),
  })
  .strict();
export type AgentConfig = z.infer<typeof AgentConfig>;

export { Slug as AgentSlug };

/** JSON canónico (claves ordenadas) para hashes estables de configuración. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as object)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export const configHash = (c: AgentConfig) => createHash("sha256").update(canonical(c)).digest("hex");

export function riskOf(c: Pick<AgentConfig, "tools">): Risk {
  let r: Risk = "low";
  for (const id of c.tools) {
    const t = TOOLS.get(id);
    if (t && RISK_ORDER[t.risk] > RISK_ORDER[r]) r = t.risk;
  }
  return r;
}

/** Contexto del diseñador/ejecutor (subconjunto de TenantContext, para mantener esto puro y testeable). */
export interface PolicySubject {
  role: "owner" | "admin" | "member" | "viewer";
  dataClass: string;
  /** Workspaces que el usuario puede leer. */
  workspaces: ReadonlySet<string> | ReadonlyMap<string, unknown>;
  /** Política LLM declarada en el perfil de onboarding (si existe). */
  llmPolicy?: "cloud_allowed" | "local_only" | "ask" | null;
}

export interface Issue {
  path: string;
  code: string;
  message: string;
}

export interface Validation {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
  risk: Risk;
}

/**
 * Instrucciones que intentan contradecir la política del tenant. Heurística conservadora: bloquea, no reescribe.
 * Los documentos recuperados nunca se evalúan aquí: no son instrucciones (son datos no confiables).
 */
const FORBIDDEN_INSTRUCTIONS: { re: RegExp; message: string }[] = [
  { re: /\bignor(a|e|ar|en)\b.{0,30}\b(pol[ií]tica|policy|policies|reglas?|rules?|instrucciones|instructions|permis)/i, message: "Instructions can't tell the agent to ignore your organization's rules" },
  { re: /\b(sin|without|skip(ping)?|omit(ir)?|salt(a|ar)(se)?)\b.{0,20}\b(aprobaci[oó]n|approval|revisi[oó]n|review|human)/i, message: "Instructions can't skip a person's approval or review" },
  { re: /\bfirm(a|ar|e)\b.{0,25}\b(en nombre|por (el|la|los)|como si)|\bsign\b.{0,20}\b(on behalf|as the|for the (client|user|signer))/i, message: "Agents can never sign on behalf of a person" },
  { re: /\b(conced|otorg|grant|elev|escalat)\w*\b.{0,25}\b(permis|acces|access|privileg|admin)/i, message: "Instructions can't give anyone more access" },
  { re: /\bbypass\b|\bjailbreak\b|\bdisable (the )?(guardrail|polic|acl)/i, message: "Instructions can't turn off safety rules" },
];

export function validateAgent(c: AgentConfig, s: PolicySubject): Validation {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const err = (path: string, code: string, message: string) => errors.push({ path, code, message });
  const warn = (path: string, code: string, message: string) => warnings.push({ path, code, message });

  // Instrucciones
  const text = [c.instructions.objective, c.instructions.boundaries, ...c.instructions.checklist, c.purpose].join("\n");
  for (const f of FORBIDDEN_INSTRUCTIONS) if (f.re.test(text)) err("instructions", "policy_conflict", f.message);

  // Conocimiento: intersección, nunca ampliación.
  if (c.knowledge.space_ids.length === 0 && c.tools.some((t) => TOOLS.get(t)?.kind === "read")) {
    err("knowledge.space_ids", "no_spaces", "Choose at least one folder for the agent to read");
  }
  for (const id of c.knowledge.space_ids) {
    if (!s.workspaces.has(id)) err("knowledge.space_ids", "scope_expansion", "You don't have access to one of the selected folders — remove it or ask an admin for access");
  }
  if (!c.knowledge.require_citations) warn("knowledge.require_citations", "citations_off", "Answers without sources are harder to check");

  // Herramientas: deny-by-default.
  const seen = new Set<string>();
  for (const id of c.tools) {
    if (seen.has(id)) err("tools", "duplicate_tool", "The same action is selected twice");
    seen.add(id);
    const t = TOOLS.get(id);
    if (!t) {
      err("tools", "unknown_tool", "One of the selected actions no longer exists — remove it");
      continue;
    }
    if (!t.available) err("tools", "tool_unavailable", `${t.label}: ${t.unavailable_reason}`);
    if (t.kind !== "read" && c.autonomy === "suggest") err("autonomy", "autonomy_mismatch", `"${t.label}" makes changes, so the agent can't be set to "Only suggest"`);
    if (RISK_ORDER[t.risk] >= RISK_ORDER.high && c.autonomy !== "approval_required") {
      err("autonomy", "approval_required", `"${t.label}" is sensitive — set the agent to "Ask before acting"`);
    }
  }
  if (c.tools.length === 0) warn("tools", "no_tools", "With no actions turned on, the agent can only give recommendations");
  if (c.autonomy === "safe_execute" && c.tools.some((t) => TOOLS.get(t)?.kind !== "read")) {
    warn("autonomy", "safe_execute_writes", "The agent will make changes without asking each time. An admin must publish it");
  }

  // Modelo: ruta permitida por residencia y sensibilidad.
  const localOnly = s.dataClass === "restricted" || s.llmPolicy === "local_only";
  if (localOnly && c.model.profile !== "local") {
    err("model.profile", "model_policy", "Your data policy only allows the Private AI engine — change it in Advanced settings");
  }
  if (s.llmPolicy === "ask" && c.model.profile !== "local") warn("model.profile", "model_policy_ask", "Your organization hasn't approved cloud AI yet — an admin needs to confirm it in Setup");

  // Disparadores: solo manual hasta el hito E (workflows).
  for (const tr of c.triggers) if (tr !== "manual") err("triggers", "trigger_unavailable", "Automatic starts are set up in Workflows; agents here start manually");

  // Límites del tenant.
  for (const [k, max] of Object.entries(TENANT_LIMITS) as [keyof typeof TENANT_LIMITS, number][]) {
    if (c.limits[k] > max) err(`limits.${k}`, "limit_exceeded", `Above your plan's limit (max ${max})`);
  }

  const risk = riskOf(c);
  return { ok: errors.length === 0, errors, warnings, risk };
}

export type Decision = "allow" | "deny" | "mock" | "require_approval";

export interface ToolDecision {
  tool: string;
  decision: Decision;
  reason: string;
}

/**
 * Decisión por invocación. Permisos efectivos = intersección de: catálogo disponible ∩ allowlist del agente ∩
 * autonomía ∩ (sandbox ⇒ escrituras simuladas). La ACL documental se aplica además en la BD (RLS) al recuperar.
 */
export function decideTool(toolId: string, c: Pick<AgentConfig, "tools" | "autonomy">, opts: { sandbox: boolean }): ToolDecision {
  const t = TOOLS.get(toolId);
  if (!t) return { tool: toolId, decision: "deny", reason: "unknown action, blocked" };
  if (!c.tools.includes(toolId)) return { tool: toolId, decision: "deny", reason: "not turned on for this agent" };
  if (!t.available) return { tool: toolId, decision: "deny", reason: t.unavailable_reason ?? "unavailable" };
  if (t.kind === "read") {
    const real = t.sandbox === "real" || !opts.sandbox;
    return { tool: toolId, decision: real ? "allow" : "mock", reason: real ? "read only, limited to documents you can see" : "read only, simulated in the test" };
  }
  if (c.autonomy === "suggest") return { tool: toolId, decision: "deny", reason: "this agent can only suggest" };
  if (opts.sandbox) return { tool: toolId, decision: "mock", reason: "simulated in the test, nothing was changed" };
  if (c.autonomy === "approval_required" || RISK_ORDER[t.risk] >= RISK_ORDER.high) return { tool: toolId, decision: "require_approval", reason: "needs a person's approval first" };
  return { tool: toolId, decision: "allow", reason: c.autonomy === "draft_only" ? "writes drafts only" : "safe internal action" };
}

/** Espacios efectivos en ejecución: los del agente ∩ los que el ejecutor puede leer. */
export function effectiveSpaces(c: Pick<AgentConfig, "knowledge">, s: Pick<PolicySubject, "workspaces">): string[] {
  return c.knowledge.space_ids.filter((id) => s.workspaces.has(id));
}

/** Quién puede publicar: el owner del agente o admin; riesgo medio+ con ejecución directa exige admin. */
export function canPublish(c: AgentConfig, s: Pick<PolicySubject, "role">, isAgentOwner: boolean): { ok: boolean; reason?: string } {
  const admin = s.role === "owner" || s.role === "admin";
  if (!admin && !isAgentOwner) return { ok: false, reason: "only the agent's owner or an admin can publish" };
  if (!admin && c.autonomy === "safe_execute" && RISK_ORDER[riskOf(c)] >= RISK_ORDER.medium) {
    return { ok: false, reason: "an admin must publish agents that act without asking" };
  }
  return { ok: true };
}

export interface ConfigDiff {
  tools_added: string[];
  tools_removed: string[];
  spaces_added: string[];
  spaces_removed: string[];
  changed: { path: string; from: unknown; to: unknown }[];
  risk: { from: Risk | null; to: Risk };
  permissions_expanded: boolean;
}

export function diffConfigs(prev: AgentConfig | null, next: AgentConfig): ConfigDiff {
  const p = prev;
  const minus = (a: string[], b: string[]) => a.filter((x) => !b.includes(x));
  const changed: ConfigDiff["changed"] = [];
  const cmp = (path: string, a: unknown, b: unknown) => {
    if (canonical(a) !== canonical(b)) changed.push({ path, from: a, to: b });
  };
  if (p) {
    cmp("name", p.name, next.name);
    cmp("purpose", p.purpose, next.purpose);
    cmp("instructions", p.instructions, next.instructions);
    cmp("model", p.model, next.model);
    cmp("autonomy", p.autonomy, next.autonomy);
    cmp("limits", p.limits, next.limits);
    cmp("knowledge.require_citations", p.knowledge.require_citations, next.knowledge.require_citations);
    cmp("triggers", p.triggers, next.triggers);
  }
  const tools_added = minus(next.tools, p?.tools ?? []);
  const spaces_added = minus(next.knowledge.space_ids, p?.knowledge.space_ids ?? []);
  const fromRisk = p ? riskOf(p) : null;
  const toRisk = riskOf(next);
  const autonomyUp = p ? AUTONOMY.indexOf(next.autonomy) > AUTONOMY.indexOf(p.autonomy) && next.autonomy !== "approval_required" : false;
  return {
    tools_added,
    tools_removed: minus(p?.tools ?? [], next.tools),
    spaces_added,
    spaces_removed: minus(p?.knowledge.space_ids ?? [], next.knowledge.space_ids),
    changed,
    risk: { from: fromRisk, to: toRisk },
    permissions_expanded: !p || tools_added.length > 0 || spaces_added.length > 0 || autonomyUp || (fromRisk !== null && RISK_ORDER[toRisk] > RISK_ORDER[fromRisk]),
  };
}

export function bumpVersion(prev: string | null, bump: "major" | "minor" | "patch"): string {
  if (!prev) return "1.0.0";
  const [ma = 1, mi = 0, pa = 0] = prev.split(".").map(Number);
  if (bump === "major") return `${ma + 1}.0.0`;
  if (bump === "minor") return `${ma}.${mi + 1}.0`;
  return `${ma}.${mi}.${pa + 1}`;
}
