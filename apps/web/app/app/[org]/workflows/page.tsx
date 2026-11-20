"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { SkeletonCardGrid, SkeletonStatus } from "@/components/skeletons";
import { useOrg } from "../layout";
import { PageBreadcrumbs } from "@/components/PageBreadcrumbs";
import { IconAlert, IconArrowRight, IconBuilding, IconLayers, IconPlay, IconPlus, IconSpinner, IconUserCheck, IconWorkflow, IconX } from "@/components/icons";
import { StateIllustration } from "@/components/AppState";
import { NODE_COPY, NodeIcon, type WfGraph } from "./shared";
import { StatusBadge, StudioCard, versionLabel } from "../agents/shared";
import { useT } from "@/lib/use-t";

interface WorkflowSummary {
  id: string;
  slug: string;
  name: string;
  description: string;
  status: string;
  active_version: string | null;
  runs: number;
  nodes: number;
  can_edit: boolean;
  can_run: boolean;
}
interface Template {
  code: string;
  name: string;
  description: string;
  graph: WfGraph;
}

export default function WorkflowsPage() {
  const tr = useT();
  const { org } = useParams<{ org: string }>();
  const router = useRouter();
  const { org: orgInfo } = useOrg();
  const [items, setItems] = useState<WorkflowSummary[] | null>();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([api<{ workflows: WorkflowSummary[] }>(`organizations/${org}/workflows`), api<{ templates: Template[] }>(`organizations/${org}/workflows/catalog`)])
      .then(([w, c]) => {
        if (!active) return;
        setItems(w.workflows);
        setTemplates(c.templates);
      })
      .catch((e) => {
        if (!active) return;
        setItems(null);
        setError(e.message);
      });
    return () => { active = false; };
  }, [org]);

  const canCreate = orgInfo?.role !== "viewer";

  async function create(template?: Template) {
    setBusy(template?.code ?? "blank");
    setError(null);
    try {
      // Name and description in the reader's language, so the workflow is saved the way they read it.
      const labels = template ? Object.fromEntries(template.graph.nodes.filter((n) => n.label).map((n) => [n.id, tr(n.label!)])) : {};
      const body = template ? { template: template.code, name: tr(template.name), description: tr(template.description), labels } : {};
      const r = await api<{ id: string }>(`organizations/${org}/workflows`, { method: "POST", body });
      router.push(`/app/${org}/workflows/${r.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  }

  return (
    <div className="page">
      <header className="page-bar">
        <PageBreadcrumbs section={tr("Workflows")} context={orgInfo?.name} icon={IconBuilding} />
        {canCreate && (
          <button type="button" className="primary small" onClick={() => create()} disabled={!!busy}>
            {busy === "blank" ? <IconSpinner size={14} /> : <IconPlus size={15} />}{tr("New workflow")}</button>
        )}
      </header>

      <div className="main">
        <header className="page-head" style={{ marginBottom: 20 }}>
          <div>
            <h1>{tr("Workflows")}</h1>
            <p className="sub">{tr("Connect agents and people step by step: an agent does the work, a person reviews and approves. A rejection always stops it.")}</p>
          </div>
        </header>

        {error && (
          <div className="alert" style={{ marginBottom: 20 }}>
            <IconAlert size={16} />
            <span style={{ flex: 1 }}>{error}</span>
            <button type="button" className="quiet icon small" onClick={() => setError(null)} aria-label={tr("Dismiss")}>
              <IconX size={14} />
            </button>
          </div>
        )}

        <section className="stack" style={{ gap: 28 }}>
          {items === undefined ? (
            <SkeletonStatus label={tr("Loading workflows…")}>
              <SkeletonCardGrid />
            </SkeletonStatus>
          ) : items === null ? null : items.length === 0 ? (
            <div className="card empty">
              <StateIllustration kind="workflows" />
              <strong>{tr("No workflows yet")}</strong>
              <span>{tr("Start from a template below. An agent must be published before a workflow can use it.")}</span>
            </div>
          ) : (
            <div className="agent-grid">
              {items.map((w, i) => (
                <StudioCard
                  key={w.id}
                  href={`/app/${org}/workflows/${w.id}`}
                  seed={w.name}
                  index={i}
                  icon={<IconWorkflow size={20} variant="duotone" />}
                  title={w.name}
                  subtitle={versionLabel(w.active_version)}
                  corner={<StatusBadge status={w.status} />}
                  meta={
                    <>
                      <span className="sc-meta-item">
                        <IconLayers size={14} />
                        {w.nodes}{" "}{tr("steps")}</span>
                      <span className="sc-meta-item">
                        <IconPlay size={14} />
                        {w.runs}{" "}{tr("runs")}</span>
                    </>
                  }
                >
                  {w.description || tr("No description")}
                </StudioCard>
              ))}
            </div>
          )}

          <div className="stack" style={{ gap: 12 }}>
            <div className="section-head">
              <div>
                <h2 style={{ fontSize: 16, fontWeight: 400 }}>{tr("Templates")}</h2>
                <p>{tr("Start from a ready-made workflow and adjust it to your team.")}</p>
              </div>
            </div>
            {items === undefined && (
              <SkeletonStatus label={tr("Loading workflow templates…")}>
                <SkeletonCardGrid count={3} />
              </SkeletonStatus>
            )}
            <div className="agent-grid">
              {templates.map((t, i) => {
                const steps = t.graph.nodes.filter((n) => n.type !== "START" && n.type !== "END");
                const stepName = (n: (typeof steps)[number]) => (n.label ? tr(n.label) : tr(NODE_COPY[n.type]));
                const checks = steps.filter((n) => n.type === "HUMAN_REVIEW" || n.type === "APPROVAL_GATE").length;
                return (
                  <StudioCard
                    key={t.code}
                    seed={t.name}
                    index={i}
                    icon={<IconWorkflow size={20} variant="duotone" />}
                    title={tr(t.name)}
                    subtitle={tr(steps.length === 1 ? "1 step" : "{n} steps", { n: steps.length })}
                    preview={
                      <span className="sc-steps" role="img" aria-label={tr("Steps: {v1}", { v1: steps.map(stepName).join(tr(", then ")) })}>
                        {steps.map((n) => (
                          <span key={n.id} className="step-chip" data-type={n.type} title={stepName(n)}>
                            <NodeIcon type={n.type} size={12} />
                          </span>
                        ))}
                      </span>
                    }
                    meta={
                      <span className="sc-meta-item">
                        <IconUserCheck size={14} />
                        {checks === 0 ? tr("No human checks") : tr(checks === 1 ? "1 human check" : "{checks} human checks", { checks })}
                      </span>
                    }
                    action={
                      canCreate && (
                        <button type="button" className="ghost small sc-cta" disabled={!!busy} onClick={() => create(t)}>{tr("Use template")}{busy === t.code ? <IconSpinner size={14} /> : <IconArrowRight size={14} />}
                        </button>
                      )
                    }
                  >
                    {tr(t.description)}
                  </StudioCard>
                );
              })}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
