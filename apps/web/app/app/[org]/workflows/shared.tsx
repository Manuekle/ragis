"use client";

import { IconAgent, IconBranch, IconCheck, IconFlag, IconHourglass, IconPlay, IconShield, IconSignature, IconUserCheck } from "@/components/icons";

/* ───────────── types (mirror apps/api/src/lib/workflow-dsl.ts) ───────────── */
export type NodeType = "START" | "END" | "AGENT_TASK" | "HUMAN_REVIEW" | "APPROVAL_GATE" | "CONDITION" | "EXTERNAL_ACTION" | "WAIT_EVENT";
export interface WfNode {
  id: string;
  type: NodeType;
  label?: string;
  agent?: string;
  agent_version?: string;
  role?: "reviewer" | "approver" | "signatory";
  expires_hours?: number;
  source?: string;
  check?: "has_answer" | "has_citations" | "answer_contains";
  value?: string;
  tool?: string;
  event?: string;
  expires_days?: number;
}
export type WfEdge = [string, string] | [string, string, "true" | "false"];
export interface Policies {
  deny_on_reject: true;
  no_external_action_without_approval: true;
  separation_of_duties: boolean;
  max_hops: number;
  budget: { max_agent_calls: number; max_retrieval_calls: number };
}
export interface WfGraph {
  nodes: WfNode[];
  edges: WfEdge[];
  policies: Policies;
}
export interface GraphIssue {
  node?: string;
  code: string;
  message: string;
}

export const NODE_COPY: Record<NodeType, string> = {
  START: "Start",
  END: "End",
  AGENT_TASK: "Agent task",
  HUMAN_REVIEW: "Human review",
  APPROVAL_GATE: "Approval",
  CONDITION: "Check",
  EXTERNAL_ACTION: "Send or share",
  WAIT_EVENT: "Wait for signatures",
};

export const ROLE_COPY: Record<string, string> = {
  reviewer: "Reviewer",
  approver: "Approver",
  signatory: "Authorized signatory",
  auditor: "Auditor",
  agent_designer: "Agent designer",
  knowledge_manager: "Knowledge manager",
};

export const STATE_COPY: Record<string, string> = {
  QUEUED: "starting",
  RUNNING: "running",
  WAITING_HUMAN: "waiting for a person",
  WAITING_EXTERNAL: "waiting for signature",
  DRAFT: "draft",
  SENT: "sent",
  DELIVERED: "delivered",
  DECLINED: "declined",
  VOIDED: "cancelled",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
  EXPIRED: "expired",
  REVOKED: "revoked",
  WAITING: "waiting",
  SUCCEEDED: "done",
  SKIPPED: "skipped",
};

export const ERROR_COPY: Record<string, string> = {
  rejected_by_human: "A person rejected it; nothing downstream ran.",
  approval_invalidated: "A document changed after the approval was requested, so the approval was invalidated.",
  approval_expired: "The approval expired before anyone decided.",
  budget_exhausted: "It reached its spending limit and stopped safely.",
  delegation_denied: "The next agent can't read any of the folders you can, so nothing was passed to it.",
  agent_inactive: "An agent in this workflow is paused or archived.",
  initiator_access_revoked: "The person who started it lost access.",
  cancelled: "Cancelled.",
  signature_declined: "A signer declined to sign.",
  signature_voided: "The signature request was cancelled.",
  recipient_not_allowed: "A recipient is outside the allowed domains; nothing was shared.",
  dlp_restricted: "Restricted documents can't be shared outside your organization.",
  approval_stale: "The approval was too old for this external action; approve again.",
  approval_mismatch: "The approval doesn't match what was about to be sent.",
  document_changed: "A document changed after it was approved, so the signature request was cancelled.",
  document_not_approved: "Documents must be approved by a person before preparing a signature.",
  signers_missing: "No signers were added.",
  esign_disabled: "Ragsis Sign is disabled.",
  signature_pdf_required: "Only PDF documents can be signed.",
  signature_email_unavailable: "Email for signatures isn't set up yet, so outside signers can't be invited. Ask your admin.",
  duplicate_signers: "Each signer needs a unique email.",
  provider_error: "Sending failed several times. Try again later.",
};

export function StateBadge({ state }: { state: string }) {
  return (
    <span className="state" data-s={state}>
      {STATE_COPY[state] ?? state.toLowerCase()}
    </span>
  );
}

export function NodeIcon({ type, size = 17 }: { type: NodeType | string; size?: number }) {
  if (type === "AGENT_TASK") return <IconAgent size={size} variant="duotone" />;
  if (type === "HUMAN_REVIEW") return <IconUserCheck size={size} variant="duotone" />;
  if (type === "APPROVAL_GATE") return <IconShield size={size} variant="duotone" />;
  if (type === "CONDITION") return <IconBranch size={size} />;
  if (type === "EXTERNAL_ACTION") return <IconSignature size={size} variant="duotone" />;
  if (type === "WAIT_EVENT") return <IconHourglass size={size} />;
  if (type === "START") return <IconPlay size={size} />;
  if (type === "END") return <IconFlag size={size} />;
  return <IconCheck size={size} />;
}

export const when = (s: string | null | undefined) => (s ? new Date(s).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "—");
export const ago = (s: string) => {
  const m = Math.round((Date.now() - new Date(s).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
};
