/**
 * DSL declarativo de workflows (hito E, ADR-022).
 *
 * Un workflow es un grafo de pasos: START, AGENT_TASK, HUMAN_REVIEW, APPROVAL_GATE, CONDITION, EXTERNAL_ACTION,
 * WAIT_EVENT y END. El orquestador solo sigue aristas declaradas; los agentes nunca eligen el siguiente paso.
 * Validación pura y determinista (sin BD): la ruta entrega el estado de los agentes referenciados.
 */
import { z } from "zod";
import { canonical, toolById } from "./policy.js";
import { createHash } from "node:crypto";

export const WORKFLOW_POLICY_VERSION = "workflow-policy-v1";
export const HUMAN_ROLES = ["reviewer", "approver", "signatory"] as const;
export const FUNCTIONAL_ROLES = ["reviewer", "approver", "signatory", "auditor", "agent_designer", "knowledge_manager"] as const;

const Id = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "node ids: lowercase, digits and _");
const Label = z.string().trim().max(120).optional();

const StartNode = z.object({ id: Id, type: z.literal("START"), label: Label }).strict();
const EndNode = z.object({ id: Id, type: z.literal("END"), label: Label }).strict();
const AgentNode = z
  .object({
    id: Id,
    type: z.literal("AGENT_TASK"),
    label: Label,
    agent: z.string().regex(/^[a-z0-9][a-z0-9-]{1,60}$/),
    /** Resueltos al publicar: la versión publicada queda fijada. */
    agent_version: z.string().optional(),
    agent_version_id: z.string().uuid().optional(),
  })
  .strict();
const HumanNode = z
  .object({
    id: Id,
    type: z.enum(["HUMAN_REVIEW", "APPROVAL_GATE"]),
    label: Label,
    role: z.enum(HUMAN_ROLES),
    expires_hours: z.number().int().min(1).max(168).default(48),
  })
  .strict();
const ConditionNode = z
  .object({
    id: Id,
    type: z.literal("CONDITION"),
    label: Label,
    source: Id,
    check: z.enum(["has_answer", "has_citations", "answer_contains"]),
    value: z.string().trim().max(200).optional(),
  })
  .strict();
const ExternalNode = z
  .object({
    id: Id,
    type: z.literal("EXTERNAL_ACTION"),
    label: Label,
    tool: z.string().min(1).max(64),
    /** share_document: caducidad pedida (la política del tenant la limita). */
    expires_days: z.number().int().min(1).max(30).optional(),
  })
  .strict();
const WaitNode = z.object({ id: Id, type: z.literal("WAIT_EVENT"), label: Label, event: z.enum(["SIGNATURE_COMPLETED"]) }).strict();

export const Node = z.discriminatedUnion("type", [StartNode, EndNode, AgentNode, HumanNode, ConditionNode, ExternalNode, WaitNode]);
export type Node = z.infer<typeof Node>;
export type NodeType = Node["type"];

export const Edge = z.union([z.tuple([Id, Id]), z.tuple([Id, Id, z.enum(["true", "false"])])]);
export type Edge = z.infer<typeof Edge>;

export const Policies = z
  .object({
    deny_on_reject: z.literal(true).default(true),
    no_external_action_without_approval: z.literal(true).default(true),
    separation_of_duties: z.boolean().default(true),
    max_hops: z.number().int().min(1).max(5).default(3),
    budget: z
      .object({
        max_agent_calls: z.number().int().min(1).max(50).default(10),
        max_retrieval_calls: z.number().int().min(1).max(100).default(20),
      })
      .strict()
      .default({ max_agent_calls: 10, max_retrieval_calls: 20 }),
  })
  .strict();

export const Graph = z
  .object({
    nodes: z.array(Node).min(2).max(30),
    edges: z.array(Edge).max(60),
    policies: Policies.default({ deny_on_reject: true, no_external_action_without_approval: true, separation_of_duties: true, max_hops: 3, budget: { max_agent_calls: 10, max_retrieval_calls: 20 } }),
  })
  .strict();
export type Graph = z.infer<typeof Graph>;

export const graphHash = (g: Graph) => createHash("sha256").update(canonical(g)).digest("hex");

export interface AgentRef {
  slug: string;
  status: string;
  active_version_id: string | null;
  active_version: string | null;
}

export interface GraphIssue {
  node?: string;
  code: string;
  message: string;
}

export interface GraphValidation {
  ok: boolean;
  errors: GraphIssue[];
  warnings: GraphIssue[];
  max_hops_found: number;
}

export const NODE_TYPES: { type: NodeType; label: string; available: boolean; reason?: string }[] = [
  { type: "START", label: "Start", available: true },
  { type: "AGENT_TASK", label: "Agent task", available: true },
  { type: "HUMAN_REVIEW", label: "Human review", available: true },
  { type: "APPROVAL_GATE", label: "Approval gate", available: true },
  { type: "CONDITION", label: "Condition", available: true },
  { type: "EXTERNAL_ACTION", label: "External action", available: true },
  { type: "WAIT_EVENT", label: "Wait for event", available: true },
  { type: "END", label: "End", available: true },
];

/** Herramientas que salen de la organización: exigen un APPROVAL_GATE inmediatamente antes. */
export const SENDING_TOOLS = new Set(["send_signature_envelope", "share_document", "send_email"]);

/** Datos que un run debe aportar según los pasos del grafo. */
export function graphNeeds(g: Pick<Graph, "nodes">): { signers: boolean; recipients: boolean } {
  return {
    signers: g.nodes.some((n) => n.type === "EXTERNAL_ACTION" && n.tool === "create_signature_draft"),
    recipients: g.nodes.some((n) => n.type === "EXTERNAL_ACTION" && (n.tool === "share_document" || n.tool === "send_email")),
  };
}

export function outgoing(g: Pick<Graph, "edges">, id: string): Edge[] {
  return g.edges.filter((e) => e[0] === id);
}

/** Siguiente nodo según aristas declaradas. CONDITION exige el resultado booleano. */
export function nextNode(g: Pick<Graph, "edges">, id: string, condition?: boolean): string | null {
  const out = outgoing(g, id);
  if (condition === undefined) return out[0]?.[1] ?? null;
  return out.find((e) => e[2] === String(condition))?.[1] ?? null;
}

export function validateGraph(g: Graph, agents: ReadonlyMap<string, AgentRef>): GraphValidation {
  const errors: GraphIssue[] = [];
  const warnings: GraphIssue[] = [];
  const err = (code: string, message: string, node?: string) => errors.push({ code, message, node });
  const byId = new Map<string, Node>();
  for (const n of g.nodes) {
    if (byId.has(n.id)) err("duplicate_node", `Duplicate node id ${n.id}`, n.id);
    byId.set(n.id, n);
  }
  const starts = g.nodes.filter((n) => n.type === "START");
  const ends = g.nodes.filter((n) => n.type === "END");
  if (starts.length !== 1) err("start", "Exactly one START node is required");
  if (ends.length < 1) err("end", "At least one END node is required");

  for (const [from, to] of g.edges) {
    if (!byId.has(from)) err("edge_unknown", `Edge from unknown node ${from}`);
    if (!byId.has(to)) err("edge_unknown", `Edge to unknown node ${to}`);
  }
  const seenEdges = new Set<string>();
  for (const e of g.edges) {
    const k = e.join(">");
    if (seenEdges.has(k)) err("duplicate_edge", `Duplicate edge ${e[0]} → ${e[1]}`);
    seenEdges.add(k);
  }

  for (const n of g.nodes) {
    const out = outgoing(g, n.id);
    if (n.type === "END") {
      if (out.length) err("end_outgoing", "END cannot have outgoing edges", n.id);
      continue;
    }
    if (n.type === "CONDITION") {
      const labels = out.map((e) => e[2]).sort().join(",");
      if (out.length !== 2 || labels !== "false,true") err("condition_edges", "A condition needs exactly one 'true' and one 'false' edge", n.id);
    } else {
      if (out.length !== 1) err("single_edge", "Each step needs exactly one outgoing edge (no parallel branches in v1)", n.id);
      if (out.some((e) => e[2])) err("label_on_plain_edge", "Only conditions can have labelled edges", n.id);
    }

    switch (n.type) {
      case "AGENT_TASK": {
        const a = agents.get(n.agent);
        if (!a) err("agent_unknown", "Choose an agent for this step", n.id);
        else if (!a.active_version_id) err("agent_unpublished", "This agent isn't published yet — publish it in Agent Studio first", n.id);
        else if (a.status !== "published") err("agent_inactive", `This agent is ${a.status} — resume it in Agent Studio`, n.id);
        break;
      }
      case "CONDITION": {
        const src = byId.get(n.source);
        if (!src || src.type !== "AGENT_TASK") err("condition_source", "Choose which earlier agent step to check", n.id);
        if (n.check === "answer_contains" && !n.value) err("condition_value", "Type the text the answer should mention", n.id);
        break;
      }
      case "EXTERNAL_ACTION": {
        const t = toolById(n.tool);
        if (!t || t.kind !== "external") err("external_tool", "Choose what to send or share", n.id);
        else if (!t.available) err("external_unavailable", `${t.label}: ${t.unavailable_reason}`, n.id);
        break;
      }
    }
  }
  if (errors.length) return { ok: false, errors, warnings, max_hops_found: 0 };

  // Topología: DAG, todo alcanzable desde START, hops por camino y orden de las acciones externas.
  const start = starts[0]!.id;
  let maxHops = 0;
  const reachable = new Set<string>();
  const tool = (id: string) => {
    const n = byId.get(id);
    return n?.type === "EXTERNAL_ACTION" ? n.tool : null;
  };
  const visit = (id: string, stack: string[], hops: number): void => {
    if (stack.includes(id)) {
      err("cycle", `Cycle detected: ${[...stack, id].join(" → ")}`, id);
      return;
    }
    reachable.add(id);
    const n = byId.get(id)!;
    const h = n.type === "AGENT_TASK" ? hops + 1 : hops;
    maxHops = Math.max(maxHops, h);
    if (n.type === "CONDITION" && !stack.includes(n.source)) err("condition_order", "A condition must come after its source agent", id);
    if (n.type === "EXTERNAL_ACTION") {
      const prev = byId.get(stack.at(-1) ?? "");
      // Envío y compartición: el gate inmediatamente anterior es el que queda atado a ESTA acción (hash).
      if (SENDING_TOOLS.has(n.tool) && prev?.type !== "APPROVAL_GATE") err("ungated_external", "Add an Approval step right before sending or sharing", id);
      if (n.tool === "create_signature_draft") {
        if (!stack.some((s) => ["HUMAN_REVIEW", "APPROVAL_GATE"].includes(byId.get(s)!.type))) err("draft_needs_approval", "Add a review or approval step before preparing documents for signature", id);
        if (stack.some((s) => tool(s) === "create_signature_draft")) err("multiple_drafts", "Only one signature request per workflow", id);
      }
      if (n.tool === "send_signature_envelope" && !stack.some((s) => tool(s) === "create_signature_draft")) err("send_needs_draft", "Add a “Prepare for signature” step before sending to signers", id);
    }
    if (n.type === "WAIT_EVENT" && !stack.some((s) => tool(s) === "send_signature_envelope")) err("wait_needs_send", "Add a “Send to signers” step before waiting for signatures", id);
    for (const e of outgoing(g, id)) visit(e[1], [...stack, id], h);
  };
  visit(start, [], 0);
  for (const n of g.nodes) if (!reachable.has(n.id)) err("unreachable", `Node ${n.id} is unreachable from START`, n.id);
  if (maxHops > g.policies.max_hops) err("max_hops", `${maxHops} agents in a row; the limit is ${g.policies.max_hops} (change it in Advanced limits)`);
  if (maxHops === 0) warnings.push({ code: "no_agents", message: "The workflow has no agent step yet" });
  if (!g.nodes.some((n) => n.type === "HUMAN_REVIEW" || n.type === "APPROVAL_GATE")) {
    warnings.push({ code: "no_human_step", message: "No person reviews or approves the result — consider adding a review step" });
  }
  if (!g.policies.separation_of_duties) warnings.push({ code: "sod_off", message: "Whoever starts the workflow could approve it themselves" });
  return { ok: errors.length === 0, errors, warnings, max_hops_found: maxHops };
}

/** Plantillas de workflow (sección 07): sin pasos de fase F. */
export const WORKFLOW_TEMPLATES: Record<string, { name: string; description: string; graph: Graph }> = {
  contract_review: {
    name: "Contract review",
    description: "Auditor flags discrepancies, reviewer proposes comments, a human reviewer approves the exact version.",
    graph: Graph.parse({
      nodes: [
        { id: "start", type: "START" },
        { id: "audit", type: "AGENT_TASK", label: "Audit clauses", agent: "contract-auditor" },
        { id: "review", type: "AGENT_TASK", label: "Propose comments", agent: "reviewer" },
        { id: "approve", type: "HUMAN_REVIEW", label: "Reviewer approves hash + version", role: "reviewer", expires_hours: 48 },
        { id: "end", type: "END" },
      ],
      edges: [["start", "audit"], ["audit", "review"], ["review", "approve"], ["approve", "end"]],
    }),
  },
  answer_with_approval: {
    name: "Answer with approval",
    description: "A searcher drafts a cited answer; an approver signs off before it is shared internally.",
    graph: Graph.parse({
      nodes: [
        { id: "start", type: "START" },
        { id: "search", type: "AGENT_TASK", label: "Draft cited answer", agent: "searcher" },
        { id: "gate", type: "APPROVAL_GATE", label: "Approver signs off", role: "approver", expires_hours: 24 },
        { id: "end", type: "END" },
      ],
      edges: [["start", "search"], ["search", "gate"], ["gate", "end"]],
    }),
  },
  contract_signature: {
    name: "Contract review, signature and distribution",
    description: "Audit and review, a person approves the final version, it goes out for signature after approval, then the signed copy is shared.",
    graph: Graph.parse({
      nodes: [
        { id: "start", type: "START" },
        { id: "audit", type: "AGENT_TASK", label: "Audit clauses", agent: "contract-auditor" },
        { id: "approve", type: "HUMAN_REVIEW", label: "Reviewer approves hash + version", role: "reviewer", expires_hours: 48 },
        { id: "envelope", type: "EXTERNAL_ACTION", label: "Prepare signature envelope (draft)", tool: "create_signature_draft" },
        { id: "send_gate", type: "APPROVAL_GATE", label: "Authorized signatory approves sending", role: "signatory", expires_hours: 24 },
        { id: "dispatch", type: "EXTERNAL_ACTION", label: "Send envelope to signers", tool: "send_signature_envelope" },
        { id: "signed", type: "WAIT_EVENT", label: "Wait for verified signature", event: "SIGNATURE_COMPLETED" },
        { id: "share_gate", type: "APPROVAL_GATE", label: "Approver authorizes distribution", role: "approver", expires_hours: 48 },
        { id: "share", type: "EXTERNAL_ACTION", label: "Share signed copy (expiring link)", tool: "share_document", expires_days: 7 },
        { id: "end", type: "END" },
      ],
      edges: [["start", "audit"], ["audit", "approve"], ["approve", "envelope"], ["envelope", "send_gate"], ["send_gate", "dispatch"], ["dispatch", "signed"], ["signed", "share_gate"], ["share_gate", "share"], ["share", "end"]],
    }),
  },
  audit_if_evidence: {
    name: "Audit when there is evidence",
    description: "Run the auditor; only send to human review when it found cited evidence, otherwise close.",
    graph: Graph.parse({
      nodes: [
        { id: "start", type: "START" },
        { id: "audit", type: "AGENT_TASK", label: "Audit", agent: "contract-auditor" },
        { id: "has_evidence", type: "CONDITION", label: "Cited evidence?", source: "audit", check: "has_citations" },
        { id: "approve", type: "HUMAN_REVIEW", label: "Review findings", role: "reviewer", expires_hours: 48 },
        { id: "end", type: "END" },
        { id: "no_evidence", type: "END", label: "Closed without evidence" },
      ],
      edges: [["start", "audit"], ["audit", "has_evidence"], ["has_evidence", "approve", "true"], ["has_evidence", "no_evidence", "false"], ["approve", "end"]],
    }),
  },
};
