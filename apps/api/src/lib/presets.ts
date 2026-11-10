/**
 * Presets sectoriales versionados (P0-01, ADR-020).
 *
 * Motor determinista: (sector + objetivos + sensibilidad + tipos de archivo + plan) -> recomendaciones.
 * No hay LLM en este camino: las recomendaciones son editables y nunca conceden permisos ni modifican políticas.
 */
import type { AgentConfig, ModelProfile } from "./policy.js";

export const SECTORS = ["legal", "consulting", "industry", "accounting", "insurance", "construction", "logistics", "education", "other"] as const;
export type Sector = (typeof SECTORS)[number];
export const GOALS = ["ask", "audit", "compare", "review", "approve", "sign", "share"] as const;
export type Goal = (typeof GOALS)[number];
export const DOC_TYPES = ["contracts", "policies", "manuals", "reports", "spreadsheets", "scanned", "drawings", "presentations", "emails", "other"] as const;

export const TEMPLATE_SET_VERSION = "v1";

export interface SectorTemplate {
  sector: Sector;
  label: string;
  /** Pregunta adaptada al sector para el paso de documentos. */
  docs_question: string;
  spaces: string[];
  agents: string[];
  guardrail: string;
  rag_profile: "hybrid_with_citations" | "multimodal_with_citations" | "basic_with_citations";
  /** Técnicas recomendadas para el sector (ADR-021). `planned`: aún no disponible en la plataforma. */
  approach: { label: string; planned?: boolean }[];
  /** Despliegue probable según el sector. `default` solo se muestra como sugerencia: nunca se preselecciona. */
  deployment: { label: string; default: "cloud" | "private_cloud" | "on_prem" };
}

export const SECTOR_TEMPLATES: Record<Sector, SectorTemplate> = {
  legal: { sector: "legal", label: "Legal", docs_question: "Which documents does your firm review?", spaces: ["Case files", "Contracts", "Regulations"], agents: ["contract_auditor", "comparator", "reviewer", "signature_coordinator"], guardrail: "Citations to clause/page; human signatory only.", rag_profile: "hybrid_with_citations", approach: [{ label: "Smart search" }, { label: "Links between documents" }, { label: "Exact clause and page" }], deployment: { label: "Private cloud", default: "private_cloud" } },
  consulting: { sector: "consulting", label: "Consulting / audit", docs_question: "Which client deliverables do you reuse most?", spaces: ["Clients", "Projects", "Methodologies"], agents: ["researcher", "reviewer", "reporter"], guardrail: "Separation by client/project.", rag_profile: "hybrid_with_citations", approach: [{ label: "Smart search" }, { label: "Best-match ranking" }], deployment: { label: "Cloud", default: "cloud" } },
  industry: { sector: "industry", label: "Engineering / industry", docs_question: "Which manuals and technical records do you consult?", spaces: ["Manuals", "Maintenance", "Quality"], agents: ["inspector", "technical_auditor"], guardrail: "Reads scans and diagrams; safety warnings always stay visible.", rag_profile: "multimodal_with_citations", approach: [{ label: "Reads tables, drawings and scans" }, { label: "Links between documents" }], deployment: { label: "Dedicated cloud", default: "private_cloud" } },
  accounting: { sector: "accounting", label: "Accounting", docs_question: "Which supports and tax documents do you handle?", spaces: ["Tax", "Supports", "Policies"], agents: ["extractor", "reconciler", "reviewer"], guardrail: "Numbers are checked by rules, never guessed by the AI.", rag_profile: "hybrid_with_citations", approach: [{ label: "Smart search" }, { label: "Verified figures", planned: true }], deployment: { label: "Private cloud", default: "private_cloud" } },
  insurance: { sector: "insurance", label: "Insurance", docs_question: "Which policies and claims do you process?", spaces: ["Policies", "Claims", "Incidents"], agents: ["classifier", "comparator", "reviewer"], guardrail: "Never auto-approve coverage without a human.", rag_profile: "hybrid_with_citations", approach: [{ label: "Smart search" }, { label: "Links between documents" }], deployment: { label: "Dedicated cloud", default: "private_cloud" } },
  construction: { sector: "construction", label: "Construction", docs_question: "Which contracts, drawings and site records do you manage?", spaces: ["Contracts", "Drawings", "Site"], agents: ["drawing_auditor", "comparator"], guardrail: "Every version is kept, with drawings and photos as evidence.", rag_profile: "multimodal_with_citations", approach: [{ label: "Reads tables, drawings and scans" }, { label: "Documents per project" }], deployment: { label: "Cloud", default: "cloud" } },
  logistics: { sector: "logistics", label: "Logistics", docs_question: "Which shipping, customs and carrier documents do you handle?", spaces: ["Shipments", "Carriers", "Operations"], agents: ["extractor", "classifier", "searcher"], guardrail: "Operational data is read-only.", rag_profile: "hybrid_with_citations", approach: [{ label: "Smart search" }, { label: "Connections to your systems", planned: true }], deployment: { label: "Cloud", default: "cloud" } },
  education: { sector: "education", label: "Education", docs_question: "Which regulations and academic processes do you document?", spaces: ["Regulations", "Registrar", "Quality"], agents: ["searcher", "document_reviewer"], guardrail: "Access by area; student data protected.", rag_profile: "hybrid_with_citations", approach: [{ label: "Smart search" }, { label: "Permissions per area" }], deployment: { label: "Cloud or on-premise", default: "cloud" } },
  other: { sector: "other", label: "Other / mixed", docs_question: "Which documents does your team work with?", spaces: ["General", "Team", "Projects"], agents: ["searcher", "summarizer"], guardrail: "Simple defaults you can change anytime.", rag_profile: "basic_with_citations", approach: [{ label: "Simple search" }], deployment: { label: "Cloud", default: "cloud" } },
};

/** Plantillas de agente: definiciones declarativas parciales (se completan con espacios al activarse). */
export interface AgentTemplate {
  code: string;
  slug: string;
  name: string;
  purpose: string;
  category: AgentConfig["category"];
  icon: string;
  objective: string;
  boundaries: string;
  checklist: string[];
  output_schema: AgentConfig["instructions"]["output_schema"];
  tools: string[];
  autonomy: AgentConfig["autonomy"];
  model_profile: ModelProfile;
  /** Plantillas cuya herramienta clave aún no está disponible (fase F). Se muestran, no se activan. */
  blocked?: string;
}

const READ = ["search_documents", "retrieve_evidence"];

const T = (t: AgentTemplate) => t;
export const AGENT_TEMPLATES: Record<string, AgentTemplate> = Object.fromEntries(
  [
    T({ code: "searcher", slug: "searcher", name: "Searcher", purpose: "Answers questions from your documents with sources, and says so when it can't find the answer.", category: "search", icon: "search", objective: "Answer the user's question using only the authorized spaces. Cite every claim with document and page.", boundaries: "If evidence is insufficient, say so. Do not give definitive legal or financial advice.", checklist: ["Every claim has a citation", "Abstain without evidence"], output_schema: "answer_with_citations.v1", tools: ["search_documents"], autonomy: "suggest", model_profile: "fast" }),
    T({ code: "contract_auditor", slug: "contract-auditor", name: "Contract auditor", purpose: "Compares clauses against the approved policy and flags discrepancies with evidence and severity.", category: "audit", icon: "doc-check", objective: "Compare contract clauses with the approved policy. Flag discrepancies with severity and cite clause and page.", boundaries: "Flag, do not decide. No definitive legal advice; a human reviewer validates every finding.", checklist: ["Cite clause and page", "Severity per finding", "Mark missing clauses"], output_schema: "audit_findings.v1", tools: [...READ, "get_document_version", "compare_versions", "create_review_task"], autonomy: "draft_only", model_profile: "reasoning" }),
    T({ code: "comparator", slug: "comparator", name: "Comparator", purpose: "Lists changes between two or more versions by clause or page.", category: "compare", icon: "compare", objective: "Compare the given versions and list every change by clause or page with before/after evidence.", boundaries: "Report differences only; do not judge their legal effect.", checklist: ["Before/after per change", "Page or clause reference"], output_schema: "version_diff.v1", tools: [...READ, "get_document_version", "compare_versions"], autonomy: "suggest", model_profile: "reasoning" }),
    T({ code: "reviewer", slug: "reviewer", name: "Reviewer", purpose: "Produces review comments and a proposed revised draft without overwriting the original.", category: "review", icon: "review", objective: "Review the document against the policies in scope and propose comments and a revised draft.", boundaries: "Never overwrite the original. Proposals go to a human reviewer.", checklist: ["Comment per issue with citation", "Draft is a new version"], output_schema: "review_comments.v1", tools: [...READ, "annotate_document", "create_draft"], autonomy: "draft_only", model_profile: "reasoning" }),
    T({ code: "signature_coordinator", slug: "signature-coordinator", name: "Signature coordinator", purpose: "Prepares signature requests for approved documents; a person always signs.", category: "coordination", icon: "signature", objective: "Prepare a DRAFT envelope for an APPROVED document and track its status.", boundaries: "The AI never signs or simulates consent. Sending requires explicit human approval.", checklist: ["Document is APPROVED", "Signers confirmed"], output_schema: "answer_with_citations.v1", tools: ["get_document_version", "create_signature_draft"], autonomy: "approval_required", model_profile: "fast" }),
    T({ code: "distributor", slug: "distributor", name: "Distributor", purpose: "Shares approved documents with approved recipients through links that expire.", category: "coordination", icon: "share", objective: "Share approved artifacts with allowlisted recipients.", boundaries: "Only allowlisted recipients, with expiry, after approval.", checklist: ["Recipients allowlisted", "Expiry set"], output_schema: "answer_with_citations.v1", tools: ["share_document"], autonomy: "approval_required", model_profile: "fast" }),
    T({ code: "approvals_coordinator", slug: "approvals-coordinator", name: "Approvals coordinator", purpose: "Opens approval and review tasks for named people and tracks reminders.", category: "coordination", icon: "approval", objective: "Create review and approval tasks for the responsible people on the given artifact.", boundaries: "Never approves anything itself. An agent report is not a human approval.", checklist: ["Explicit assignees", "Artifact version referenced"], output_schema: "answer_with_citations.v1", tools: ["get_document_version", "create_review_task", "request_approval"], autonomy: "approval_required", model_profile: "fast" }),
    T({ code: "researcher", slug: "researcher", name: "Researcher", purpose: "Consolidates historical information across projects with traceable sources.", category: "search", icon: "search", objective: "Research the question across the spaces in scope and consolidate findings with citations.", boundaries: "Stay within the client/project in scope.", checklist: ["Sources per finding"], output_schema: "answer_with_citations.v1", tools: READ, autonomy: "suggest", model_profile: "reasoning" }),
    T({ code: "reporter", slug: "reporter", name: "Reporter", purpose: "Drafts structured reports from findings, ready for human review.", category: "review", icon: "review", objective: "Draft a structured report from the findings in scope.", boundaries: "Drafts only; a human validates before delivery.", checklist: ["Executive summary", "Cited findings"], output_schema: "review_comments.v1", tools: [...READ, "create_draft"], autonomy: "draft_only", model_profile: "reasoning" }),
    T({ code: "inspector", slug: "inspector", name: "Document inspector", purpose: "Checks manuals, diagrams and records for gaps and safety warnings.", category: "audit", icon: "doc-check", objective: "Inspect technical documents for missing steps, inconsistencies and safety warnings.", boundaries: "Safety warnings are always reported; no operational decisions.", checklist: ["Safety warnings surfaced", "Diagram references"], output_schema: "audit_findings.v1", tools: [...READ, "extract_fields"], autonomy: "suggest", model_profile: "vision" }),
    T({ code: "technical_auditor", slug: "technical-auditor", name: "Technical auditor", purpose: "Audits quality and maintenance records against procedures.", category: "audit", icon: "doc-check", objective: "Audit records against the procedures in scope and report deviations with evidence.", boundaries: "Report, do not certify.", checklist: ["Deviation with evidence"], output_schema: "audit_findings.v1", tools: [...READ, "create_review_task"], autonomy: "draft_only", model_profile: "reasoning" }),
    T({ code: "extractor", slug: "extractor", name: "Extractor", purpose: "Pulls key data out of receipts, supports and invoices.", category: "extract", icon: "extract", objective: "Extract the requested fields with confidence scores from the documents in scope.", boundaries: "Figures are verified by rules, not by the model.", checklist: ["Confidence per field"], output_schema: "extracted_fields.v1", tools: [...READ, "extract_fields"], autonomy: "suggest", model_profile: "fast" }),
    T({ code: "reconciler", slug: "reconciler", name: "Reconciler", purpose: "Flags mismatches between supports and records for human reconciliation.", category: "compliance", icon: "compare", objective: "Compare supports with records and list mismatches with references.", boundaries: "Never posts entries; flags only.", checklist: ["Reference both sides"], output_schema: "compliance_deviations.v1", tools: [...READ, "extract_fields", "create_review_task"], autonomy: "draft_only", model_profile: "reasoning" }),
    T({ code: "classifier", slug: "classifier", name: "Classifier", purpose: "Classifies policies and claims and extracts key fields.", category: "extract", icon: "extract", objective: "Classify each document and extract key fields with confidence.", boundaries: "Never auto-approves coverage.", checklist: ["Class + confidence"], output_schema: "extracted_fields.v1", tools: [...READ, "extract_fields"], autonomy: "suggest", model_profile: "fast" }),
    T({ code: "drawing_auditor", slug: "drawing-auditor", name: "Drawing auditor", purpose: "Audits drawings and site records, using images and plans as evidence.", category: "audit", icon: "doc-check", objective: "Audit drawings and site records against the contract and report deviations with figure references.", boundaries: "Report, do not approve changes.", checklist: ["Figure/page reference"], output_schema: "audit_findings.v1", tools: [...READ, "compare_versions", "create_review_task"], autonomy: "draft_only", model_profile: "vision" }),
    T({ code: "document_reviewer", slug: "document-reviewer", name: "Document reviewer", purpose: "Reviews regulations and procedures for consistency.", category: "review", icon: "review", objective: "Review documents for inconsistencies with the regulations in scope.", boundaries: "Protect personal data; comments only.", checklist: ["Cited inconsistency"], output_schema: "review_comments.v1", tools: [...READ, "annotate_document"], autonomy: "draft_only", model_profile: "reasoning" }),
    T({ code: "summarizer", slug: "summarizer", name: "Summarizer", purpose: "Summarizes documents and shows where each point comes from.", category: "search", icon: "summary", objective: "Summarize the requested documents, citing the passages each point comes from.", boundaries: "No claims beyond the sources.", checklist: ["Citation per point"], output_schema: "answer_with_citations.v1", tools: ["search_documents"], autonomy: "suggest", model_profile: "fast" }),
    T({ code: "compliance_checker", slug: "compliance-checker", name: "Compliance checker", purpose: "Lists verifiable deviations from an approved policy.", category: "compliance", icon: "shield", objective: "Check documents against the approved policy and list verifiable deviations.", boundaries: "Deviations must be verifiable against cited text.", checklist: ["Policy clause + document evidence"], output_schema: "compliance_deviations.v1", tools: [...READ, "create_review_task"], autonomy: "draft_only", model_profile: "reasoning" }),
  ].map((t) => [t.code, t]),
);

/** Objetivo -> plantilla que lo resuelve. */
const GOAL_AGENTS: Record<Goal, string> = {
  ask: "searcher",
  audit: "contract_auditor",
  compare: "comparator",
  review: "reviewer",
  approve: "approvals_coordinator",
  sign: "signature_coordinator",
  share: "distributor",
};

export interface ProfileInput {
  sector_primary: Sector | null;
  sector_secondary: string[];
  goals: string[];
  data_classification: string | null;
  llm_policy: string | null;
  doc_types: string[];
  deployment_preference: string | null;
}

export interface Recommendation {
  template_version: string;
  sector: Sector;
  knowledge_spaces: string[];
  rag_profile: SectorTemplate["rag_profile"];
  suggested_agents: { template: string; name: string; reason: string; blocked: string | null }[];
  approval_policy: "required_for_external_actions";
  model_policy: "local_only" | "region_and_provider_approved" | "confirm_before_cloud";
  guardrails: string[];
  warnings: string[];
}

export function recommend(p: ProfileInput, opts: { plan: string; orgDataClass: string }): Recommendation {
  const sector: Sector = p.sector_primary ?? "other";
  const base = SECTOR_TEMPLATES[sector];
  const spaces = [...base.spaces];
  for (const s of p.sector_secondary) {
    const sec = SECTOR_TEMPLATES[s as Sector];
    if (sec && s !== sector) for (const name of sec.spaces.slice(0, 1)) if (!spaces.includes(name)) spaces.push(name);
  }

  const agents: Recommendation["suggested_agents"] = [];
  const add = (code: string, reason: string) => {
    const t = AGENT_TEMPLATES[code];
    if (!t || agents.some((a) => a.template === code)) return;
    agents.push({ template: code, name: t.name, reason, blocked: t.blocked ?? null });
  };
  for (const g of p.goals) if ((GOALS as readonly string[]).includes(g)) add(GOAL_AGENTS[g as Goal], `Goal: ${g}`);
  for (const code of base.agents) add(code, `${base.label} preset`);
  if (agents.length === 0) add("searcher", "Default");

  const restricted = p.data_classification === "restricted" || opts.orgDataClass === "restricted";
  const model_policy: Recommendation["model_policy"] =
    restricted || p.llm_policy === "local_only" || p.deployment_preference === "on_prem" ? "local_only" : p.llm_policy === "ask" ? "confirm_before_cloud" : "region_and_provider_approved";

  const multimodal = p.doc_types.some((d) => d === "scanned" || d === "drawings" || d === "presentations");
  const rag_profile: Recommendation["rag_profile"] = multimodal ? "multimodal_with_citations" : base.rag_profile;

  const warnings: string[] = [];
  if (p.goals.includes("sign") || p.goals.includes("share")) {
    warnings.push("Signing and external sharing always require a named human approver; agents only prepare and coordinate.");
  }
  if (restricted) warnings.push("Restricted data stays private: cloud AI will be blocked.");
  if (p.llm_policy === "ask") warnings.push("Agents will use private AI until you approve cloud AI.");
  if (opts.plan === "team" && rag_profile === "multimodal_with_citations") warnings.push("Describing drawings and figures needs an AI that can read images, allowed by your data policy.");

  return {
    template_version: `${sector}-${TEMPLATE_SET_VERSION}`,
    sector,
    knowledge_spaces: spaces,
    rag_profile,
    suggested_agents: agents,
    approval_policy: "required_for_external_actions",
    model_policy,
    guardrails: [base.guardrail, "Agents never follow instructions written inside documents.", "Agents only do what you allow; by default they just recommend."],
    warnings,
  };
}

/** Construye la definición declarativa inicial de un agente desde una plantilla. */
export function configFromTemplate(t: AgentTemplate, spaceIds: string[], localOnly: boolean): AgentConfig {
  return {
    name: t.name,
    purpose: t.purpose,
    icon: t.icon,
    category: t.category,
    instructions: { objective: t.objective, boundaries: t.boundaries, tone: "neutral", checklist: t.checklist, output_schema: t.output_schema },
    knowledge: { space_ids: spaceIds, require_citations: true },
    model: { profile: localOnly ? "local" : t.model_profile, temperature: 0.1, token_budget: 8000 },
    tools: t.tools,
    autonomy: t.autonomy,
    triggers: ["manual"],
    limits: { max_steps: 8, timeout_seconds: 120, usd_per_run: 0.2, max_retries: 1, concurrency: 1 },
    tests: [],
  };
}

export function blankConfig(spaceIds: string[], localOnly: boolean): AgentConfig {
  return configFromTemplate(
    { code: "custom", slug: "custom", name: "New agent", purpose: "Describe what this agent does for your team.", category: "custom", icon: "sparkles", objective: "Answer questions from the selected spaces with citations.", boundaries: "", checklist: [], output_schema: "answer_with_citations.v1", tools: ["search_documents"], autonomy: "suggest", model_profile: "fast" },
    spaceIds,
    localOnly,
  );
}
