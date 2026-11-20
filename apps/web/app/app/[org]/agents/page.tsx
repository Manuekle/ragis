"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Skel, SkeletonCardGrid, SkeletonStatus } from "@/components/skeletons";
import { useOrg } from "../layout";
import { PageBreadcrumbs } from "@/components/PageBreadcrumbs";
import { IconAgent, IconAlert, IconArrowRight, IconBuilding, IconLock, IconPlus, IconSpinner, IconTool, IconX } from "@/components/icons";
import { StateIllustration } from "@/components/AppState";
import { AgentGlyph, AUTONOMY_COPY, RiskBadge, StatusBadge, StudioCard, versionLabel } from "./shared";
import { SoftText } from "@/components/motion";
import { useT } from "@/lib/use-t";

interface AgentSummary {
  id: string;
  slug: string;
  name: string;
  purpose: string;
  icon: string;
  category: string;
  status: string;
  owner_email: string | null;
  active_version: string | null;
  risk: string;
  autonomy: string;
  tools: string[];
  unpublished_changes: boolean;
  draft_test_status: string | null;
  can_edit: boolean;
}
interface Template {
  code: string;
  name: string;
  purpose: string;
  icon: string;
  tools: string[];
  autonomy: string;
  blocked?: string;
}

type Tab = "mine" | "catalog";

export default function AgentsPage() {
  const tr = useT();
  const { org } = useParams<{ org: string }>();
  const router = useRouter();
  const { org: orgInfo, workspaceId, workspaces } = useOrg();
  const [agents, setAgents] = useState<AgentSummary[] | null>();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [sectorTemplates, setSectorTemplates] = useState<Record<string, string[]>>({});
  const [tab, setTab] = useState<Tab>("mine");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([api<{ agents: AgentSummary[] }>(`organizations/${org}/agents`), api<{ templates: Template[]; sector_templates?: Record<string, string[]> }>(`organizations/${org}/agents/catalog`)])
      .then(([a, c]) => {
        if (!active) return;
        setAgents(a.agents);
        setTemplates(c.templates);
        setSectorTemplates(c.sector_templates ?? {});
        if (!a.agents.length) setTab("catalog");
      })
      .catch((e) => {
        if (!active) return;
        setAgents(null);
        setError(e.message);
      });
    return () => { active = false; };
  }, [org]);

  const canCreate = orgInfo?.role !== "viewer";
  // Solo espacios donde el usuario es miembro: la selección nunca amplía su acceso.
  const readable = workspaces.filter((w) => w.my_role);
  const defaultSpace = readable.find((w) => w.id === workspaceId)?.id ?? readable[0]?.id;

  // The org's sector templates first (a law firm sees its own before construction or logistics ones), then the rest.
  const suggestedCodes = (orgInfo?.sector && sectorTemplates[orgInfo.sector]) || [];
  const suggested = suggestedCodes.map((code) => templates.find((t) => t.code === code)).filter((t): t is Template => !!t);
  const others = templates.filter((t) => !suggestedCodes.includes(t.code));

  async function create(template?: Template) {
    setBusy(template?.code ?? "blank");
    setError(null);
    try {
      // Name and purpose go in the reader's language, so the agent is saved the way they read it.
      const body = template ? { template: template.code, name: tr(template.name), purpose: tr(template.purpose) } : {};
      const r = await api<{ id: string }>(`organizations/${org}/agents`, { method: "POST", body: { ...body, space_ids: defaultSpace ? [defaultSpace] : [] } });
      router.push(`/app/${org}/agents/${r.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  }

  return (
    <div className="page">
      <header className="page-bar">
        <PageBreadcrumbs section={tr("Agent Studio")} context={orgInfo?.name} icon={IconBuilding} />
        {canCreate && (
          <button type="button" className="primary small" onClick={() => create()} disabled={!!busy}>
            {busy === "blank" ? <IconSpinner size={14} /> : <IconPlus size={15} />}{tr("New agent")}</button>
        )}
      </header>

      <div className="main">
        <header className="page-head" style={{ marginBottom: 20 }}>
          <div>
            <h1>{tr("Agent Studio")}</h1>
            <p className="sub">{tr("Assistants that work with your documents. Try each one safely before you publish it to your team.")}</p>
          </div>
        </header>

        <div className="tabs" role="tablist" aria-label={tr("Agent Studio sections")}>
          {(
            [
              ["mine", tr("Agents"), agents?.length ?? 0],
              ["catalog", tr("Templates"), templates.length],
            ] as [Tab, string, number][]
          ).map(([id, label, n]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)}>
              {label}
              {agents === undefined ? <Skel w={16} h={13} r={999} /> : agents !== null && <span className="count"><SoftText text={String(n)} /></span>}
            </button>
          ))}
        </div>

        {error && (
          <div className="alert" style={{ marginTop: 20 }}>
            <IconAlert size={16} />
            <span style={{ flex: 1 }}>{error}</span>
            <button type="button" className="quiet icon small" onClick={() => setError(null)} aria-label={tr("Dismiss")}>
              <IconX size={14} />
            </button>
          </div>
        )}

        <section className="tab-panel agent-panel" role="tabpanel" key={tab} style={{ marginTop: 20 }}>
          {agents === undefined && (
            <SkeletonStatus label={tab === "mine" ? tr("Loading agents…") : tr("Loading templates…")}>
              <SkeletonCardGrid />
            </SkeletonStatus>
          )}
          {tab === "mine" && agents != null &&
            (agents.length === 0 ? (
              <div className="card empty">
                <StateIllustration kind="agents" />
                <strong>{tr("No agents yet")}</strong>
                <span>{tr("Start from a template or create one from scratch. Agents only see documents you can see.")}</span>
                {canCreate && (
                  <button type="button" className="ghost small" onClick={() => setTab("catalog")}>{tr("Browse templates")}</button>
                )}
              </div>
            ) : (
              <div className="agent-grid">
                {agents.map((a, i) => (
                  <StudioCard
                    key={a.id}
                    href={`/app/${org}/agents/${a.id}`}
                    seed={a.name}
                    index={i}
                    icon={<AgentGlyph icon={a.icon} size={20} />}
                    title={a.name}
                    subtitle={versionLabel(a.active_version)}
                    corner={
                      <>
                        <StatusBadge status={a.status} />
                        {a.unpublished_changes && a.can_edit && (
                          <span className={`badge${a.draft_test_status === "passed" ? " accent" : ""}`} data-tip={tr("The draft has changes that aren't live yet")}>
                            {a.draft_test_status === "passed" ? tr("Ready to publish") : tr("Changes not published")}
                          </span>
                        )}
                      </>
                    }
                    meta={
                      <>
                        <RiskBadge risk={a.risk} />
                        <span className="sc-meta-item">
                          <IconAgent size={14} />
                          {AUTONOMY_COPY()[a.autonomy] ?? a.autonomy}
                        </span>
                      </>
                    }
                  >
                    {a.purpose}
                  </StudioCard>
                ))}
              </div>
            ))}

          {tab === "catalog" && agents != null && (
            <div className="stack" style={{ gap: 24 }}>
              {[
                { key: "suggested", items: suggested, title: tr("Suggested for your sector"), lead: tr("The templates Setup recommends for an organization like yours.") },
                { key: "others", items: others, title: suggested.length ? tr("More templates") : null, lead: null },
              ]
                .filter((g) => g.items.length)
                .map((g) => (
                  <section key={g.key} className="stack" style={{ gap: 12 }}>
                    {g.title && (
                      <div className="section-head">
                        <div>
                          <h2 style={{ fontSize: 16, fontWeight: 400 }}>{g.title}</h2>
                          {g.lead && <p>{g.lead}</p>}
                        </div>
                      </div>
                    )}
                    <div className="agent-grid">
                      {g.items.map((t, i) => (
                        <StudioCard
                          key={t.code}
                          seed={t.name}
                          index={i}
                          icon={<AgentGlyph icon={t.icon} size={20} />}
                          title={tr(t.name)}
                          subtitle={AUTONOMY_COPY()[t.autonomy] ?? t.autonomy}
                          corner={
                            t.blocked && (
                              <span className="badge" data-tip={t.blocked}>
                                <IconLock size={12} />{tr("Coming later")}</span>
                            )
                          }
                          meta={
                            <span className="sc-meta-item">
                              <IconTool size={14} />
                              {t.tools.length === 1 ? tr("1 action") : tr("{n} actions", { n: t.tools.length })}
                            </span>
                          }
                          action={
                            !t.blocked &&
                            canCreate && (
                              <button type="button" className="ghost small sc-cta" disabled={!!busy} onClick={() => create(t)}>{tr("Use template")}{busy === t.code ? <IconSpinner size={14} /> : <IconArrowRight size={14} />}
                              </button>
                            )
                          }
                        >
                          {tr(t.purpose)}
                        </StudioCard>
                      ))}
                    </div>
                  </section>
                ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
