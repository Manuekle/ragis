"use client";

import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { IconAgent, IconArrowRight, IconCompare, IconDocCheck, IconFile, IconSearch, IconShare, IconShield, IconSignature, IconSparkles, IconTask } from "@/components/icons";
import { grainVars } from "@/components/ui";
import { useT, tNow } from "@/lib/use-t";

const GLYPHS: Record<string, typeof IconAgent> = {
  search: IconSearch,
  "doc-check": IconDocCheck,
  compare: IconCompare,
  review: IconFile,
  signature: IconSignature,
  share: IconShare,
  approval: IconTask,
  extract: IconFile,
  summary: IconFile,
  shield: IconShield,
  sparkles: IconSparkles,
};

export function AgentGlyph({ icon, size = 18 }: { icon: string; size?: number }) {
  const G = GLYPHS[icon] ?? IconAgent;
  return <G size={size} variant="duotone" />;
}

const RISK_COPY = (): Record<string, string> => ({ low: tNow("Low risk"), medium: tNow("Medium risk"), high: tNow("High risk"), critical: tNow("Critical risk") });
const RISK_TIP = (): Record<string, string> => ({
  low: tNow("Only reads documents"),
  medium: tNow("Can write drafts or create tasks"),
  high: tNow("Can prepare things that leave your organization — always with approval"),
  critical: tNow("Can send things outside your organization — always with approval"),
});

export function RiskBadge({ risk }: { risk: string }) {
  const t = useT();
  return (
    <span className={`badge risk-${risk}`} data-tip={t(RISK_TIP()[risk])}>
      {t(RISK_COPY()[risk]) ?? t("{risk} risk", { risk })}
    </span>
  );
}

const STATUS: Record<string, string> = { draft: "", published: "ok", paused: "warn", archived: "" };
const STATUS_COPY = (): Record<string, string> => ({ draft: tNow("Draft"), published: tNow("Live"), paused: tNow("Paused"), archived: tNow("Archived") });

export function StatusBadge({ status }: { status: string }) {
  const t = useT();
  return (
    <span className={`badge ${STATUS[status] ?? ""}`}>
      <span className="dot" />
      {t(STATUS_COPY()[status]) ?? status}
    </span>
  );
}

/** How much an agent may do on its own, in the words the editor uses. */
// Functions, not constants: the words depend on the page's language, known only when they are shown.
export const AUTONOMY = (): [string, string, string][] => [
  ["suggest", tNow("Only suggest"), tNow("Reads and recommends. Never changes anything.")],
  ["draft_only", tNow("Prepare drafts"), tNow("Writes drafts and tasks for you to review. Originals stay untouched.")],
  ["safe_execute", tNow("Act on safe tasks"), tNow("Does low-risk internal tasks on its own. An admin must publish it.")],
  ["approval_required", tNow("Ask before acting"), tNow("Every action waits for a person to approve it.")],
];
export const AUTONOMY_COPY = (): Record<string, string> => Object.fromEntries(AUTONOMY().map(([k, l]) => [k, l]));

/** Human-friendly version label: "v1.2.0" or "Not published yet". */
export const versionLabel = (v: string | null | undefined) => (v ? `v${v}` : tNow("Not published yet"));

/**
 * Card used by the Agent Studio and Workflows grids (agents, workflows and their templates).
 * Layout: grainy icon tile + corner badges / title + subtitle / description / hairline / meta + action.
 * `seed` drives the tile gradient and the hover tint (same seed → same hue, like <Avatar>).
 * With `href` the whole card is a link and, without an `action`, ends in an arrow.
 */
export function StudioCard({
  href,
  seed,
  index,
  icon,
  title,
  subtitle,
  corner,
  preview,
  meta,
  action,
  children,
}: {
  href?: string;
  seed: string;
  index: number;
  icon: ReactNode;
  title: string;
  subtitle?: ReactNode;
  corner?: ReactNode;
  /** Optional strip between the description and the footer (e.g. a workflow's steps). */
  preview?: ReactNode;
  meta?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  const style = { ...grainVars(seed), "--i": index } as CSSProperties;
  const body = (
    <>
      <div className="sc-top">
        <span className="grain-tile" aria-hidden="true">
          {icon}
        </span>
        {corner && <div className="sc-corner">{corner}</div>}
      </div>
      <div className="sc-title">
        <strong>{title}</strong>
        {subtitle && <small>{subtitle}</small>}
      </div>
      <p className="sc-desc">{children}</p>
      {preview && <div className="sc-preview">{preview}</div>}
      <div className="sc-foot">
        <div className="sc-meta">{meta}</div>
        {action ??
          (href && (
            <span className="sc-go" aria-hidden="true">
              <IconArrowRight size={15} />
            </span>
          ))}
      </div>
    </>
  );
  return href ? (
    <Link href={href} className="agent-card" style={style}>
      {body}
    </Link>
  ) : (
    <div className="agent-card" style={style}>
      {body}
    </div>
  );
}
