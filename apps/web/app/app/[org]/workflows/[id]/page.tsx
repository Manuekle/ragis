"use client";

import { useParams, useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { PageBreadcrumbs } from "@/components/PageBreadcrumbs";
import { SkeletonEditor } from "@/components/skeletons";
import { IconAlert, IconArchive, IconCheck, IconChevronDown, IconLock, IconPause, IconPlay, IconPlus, IconRocket, IconShield, IconSpinner, IconTrash, IconWorkflow, IconX } from "@/components/icons";
import { Checkbox, Seg, SoftText, Toast, useDropdown } from "@/components/motion";
import { Disclosure, Select, TextField, useConfirm } from "@/components/ui";
import { StatusBadge, versionLabel } from "../../agents/shared";
import { NODE_COPY, NodeIcon, ROLE_COPY, when, type GraphIssue, type NodeType, type Policies, type WfGraph, type WfNode } from "../shared";
import { useT, tNow } from "@/lib/use-t";

interface Detail {
  id: string;
  slug: string;
  name: string;
  description: string;
  status: string;
  draft: WfGraph;
  draft_hash: string;
  validation: { ok: boolean; errors: GraphIssue[]; warnings: GraphIssue[]; max_hops_found: number };
  active_version: { id: string; version: string; published_at: string } | null;
  versions: { id: string; version: string; changelog: string; published_at: string; published_by: string | null }[];
  unpublished_changes: boolean;
  can_edit: boolean;
  can_run: boolean;
  run_needs: { signers: boolean; recipients: boolean };
  publish: { allowed: boolean; reasons: string[]; next_version: Record<"major" | "minor" | "patch", string> };
}
interface Catalog {
  node_types: { type: NodeType; label: string; available: boolean; reason?: string }[];
  agents: { slug: string; name: string; status: string; active_version: string | null }[];
}

/** El builder edita una cadena lineal; una condición envía su rama "false" a un END propio. */
interface Step {
  node: WfNode;
  falseEnd?: WfNode;
}

function toSteps(g: WfGraph): Step[] | null {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const steps: Step[] = [];
  let cur = g.nodes.find((n) => n.type === "START");
  while (cur) {
    if (seen.has(cur.id)) return null;
    seen.add(cur.id);
    const out = g.edges.filter((e) => e[0] === cur!.id);
    if (cur.type === "CONDITION") {
      const t = out.find((e) => e[2] === "true");
      const f = out.find((e) => e[2] === "false");
      const fn = f ? byId.get(f[1]) : undefined;
      if (!fn || fn.type !== "END") return null;
      seen.add(fn.id);
      steps.push({ node: cur, falseEnd: fn });
      cur = t ? byId.get(t[1]) : undefined;
      continue;
    }
    steps.push({ node: cur });
    if (cur.type === "END") break;
    cur = out[0] ? byId.get(out[0][1]) : undefined;
  }
  if (steps.at(-1)?.node.type !== "END" || seen.size !== g.nodes.length) return null;
  return steps;
}

function fromSteps(steps: Step[], policies: Policies): WfGraph {
  const nodes = steps.flatMap((s) => (s.falseEnd ? [s.node, s.falseEnd] : [s.node]));
  const edges: WfGraph["edges"] = [];
  for (let i = 0; i < steps.length - 1; i++) {
    const s = steps[i]!;
    const next = steps[i + 1]!.node.id;
    if (s.node.type === "CONDITION") {
      edges.push([s.node.id, next, "true"]);
      edges.push([s.node.id, s.falseEnd!.id, "false"]);
    } else edges.push([s.node.id, next]);
  }
  return { nodes, edges, policies };
}

function newNode(type: NodeType, taken: Set<string>): Step {
  const prefix = { AGENT_TASK: "agent", HUMAN_REVIEW: "review", APPROVAL_GATE: "gate", CONDITION: "check", EXTERNAL_ACTION: "action", WAIT_EVENT: "wait" }[type as string] ?? "step";
  let i = 1;
  while (taken.has(`${prefix}_${i}`)) i++;
  const id = `${prefix}_${i}`;
  if (type === "AGENT_TASK") return { node: { id, type, agent: "", label: "" } };
  if (type === "EXTERNAL_ACTION") return { node: { id, type, tool: "create_signature_draft", label: "" } };
  if (type === "WAIT_EVENT") return { node: { id, type, event: "SIGNATURE_COMPLETED", label: "" } };
  if (type === "CONDITION") {
    let j = 1;
    while (taken.has(`end_${j}`)) j++;
    return { node: { id, type, source: "", check: "has_citations", label: "" }, falseEnd: { id: `end_${j}`, type: "END", label: "Closed by condition" } };
  }
  return { node: { id, type, role: type === "APPROVAL_GATE" ? "approver" : "reviewer", expires_hours: 48, label: "" } };
}

const INSERTABLE = (): NodeType[] => { const tr = useT(); return (["AGENT_TASK", tr("HUMAN_REVIEW"), tr("APPROVAL_GATE"), "CONDITION", tr("EXTERNAL_ACTION"), "WAIT_EVENT"]); };
const EXTERNAL_TOOLS = (): { value: string; label: string; hint: string; locked?: string }[] => ([
  { value: "create_signature_draft", label: tNow("Prepare for signature"), hint: tNow("Only documents a person approved") },
  { value: "send_signature_envelope", label: tNow("Send to signers"), hint: tNow("Must come right after an approval") },
  { value: "share_document", label: tNow("Share a link that expires"), hint: tNow("Must come right after an approval · approved companies only") },
  { value: "send_email", label: tNow("Send email"), hint: tNow("Coming soon"), locked: tNow("Coming soon") },
]);
const CHECK_COPY = () => ({ has_citations: tNow("found sources"), has_answer: tNow("gave an answer"), answer_contains: tNow("answer mentions…") });

function Insert({ onPick, types }: { onPick: (t: NodeType) => void; types: Catalog["node_types"] }) {
  const tr = useT();
  const dd = useDropdown();
  return (
    <div className="flow-insert" ref={dd.ref} style={{ position: "relative" }}>
      <button type="button" className="ghost icon small" aria-label={tr("Add step here")} aria-haspopup="menu" aria-expanded={dd.isOpen} onClick={dd.toggle}>
        <IconPlus size={14} />
      </button>
      <div className={`menu ${dd.cls}`} role="menu" data-origin="top-left" inert={!dd.isOpen} style={{ left: "50%", transform: "translateX(-50%)" }}>
        <div className="menu-label">{tr("Add step")}</div>
        {INSERTABLE().map((t) => {
          const meta = types.find((x) => x.type === t);
          return (
            <button
              key={t}
              type="button"
              role="menuitem"
              className="menu-item"
              disabled={!meta?.available}
              title={meta?.reason}
              onClick={() => {
                onPick(t);
                dd.close();
              }}
            >
              <NodeIcon type={t} size={15} />
              {tr(NODE_COPY[t])}
              {!meta?.available && <IconLock size={12} className="check" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function WorkflowEditor() {
  const tr = useT();
  const { org, id } = useParams<{ org: string; id: string }>();
  const router = useRouter();
  const confirm = useConfirm();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [policies, setPolicies] = useState<Policies | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [bump, setBump] = useState<"major" | "minor" | "patch">("minor");
  const [changelog, setChangelog] = useState("");
  const [task, setTask] = useState("");
  const [signers, setSigners] = useState<{ name: string; email: string }[]>([{ name: "", email: "" }]);
  const [recipients, setRecipients] = useState("");
  const [starting, setStarting] = useState(false);
  const runKey = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const clearNotice = useCallback(() => setNotice(null), []);

  const load = useCallback(
    async (reset = true) => {
      try {
        const d = await api<Detail>(`organizations/${org}/workflows/${id}`);
        setDetail(d);
        if (reset) {
          setSteps(toSteps(d.draft));
          setPolicies(d.draft.policies);
          setName(d.name);
          setDescription(d.description);
          setDirty(false);
        }
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [org, id],
  );

  useEffect(() => {
    load();
    api<Catalog>(`organizations/${org}/workflows/catalog`).then(setCatalog).catch(() => undefined);
  }, [org, load]);

  if (!detail || !policies) {
    if (!error) return <SkeletonEditor label={tr("Loading workflow…")} workflow />;
    return (
      <div className="page">
        <div className="main">
          <div className="alert">
            <IconAlert size={16} />
            {error}
          </div>
        </div>
      </div>
    );
  }

  const ro = !detail.can_edit || detail.status === "archived";
  const touch = (fn: (s: Step[]) => Step[]) => {
    setSteps((cur) => (cur ? fn(structuredClone(cur)) : cur));
    setDirty(true);
  };
  const patchNode = (i: number, patch: Partial<WfNode>) => touch((s) => s.map((x, j) => (j === i ? { ...x, node: { ...x.node, ...patch } } : x)));
  const errorsFor = (nodeId: string) => detail.validation.errors.filter((e) => e.node === nodeId);
  const v = detail.validation;
  const agents = catalog?.agents ?? [];

  async function save(): Promise<boolean> {
    if (!steps || !policies) return false;
    setSaving(true);
    setError(null);
    try {
      await api(`organizations/${org}/workflows/${id}/draft`, { method: "PUT", body: { graph: fromSteps(steps, policies), name, description } });
      await load(false);
      setDirty(false);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function publish() {
    setError(null);
    try {
      const r = await api<{ version: string; agents: string[] }>(`organizations/${org}/workflows/${id}/publish`, { method: "POST", body: { bump, changelog } });
      setNotice(tr("Version {version} published · {v2}", { version: r.version, v2: r.agents.join(", ") }));
      setChangelog("");
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function startRun(e: React.FormEvent) {
    e.preventDefault();
    if (task.trim().length < 2) return;
    // Una clave por envío: reintentar el mismo envío (doble clic, red) no crea un segundo run.
    runKey.current ??= crypto.randomUUID();
    setStarting(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { task };
      if (detail?.run_needs?.signers) body.signers = signers.filter((x) => x.email.trim());
      if (detail?.run_needs?.recipients) body.recipients = recipients.split(/[\s,;]+/).filter(Boolean);
      const r = await api<{ id: string }>(`organizations/${org}/workflows/${id}/runs`, { method: "POST", body, headers: { "idempotency-key": runKey.current } });
      runKey.current = null;
      router.push(`/app/${org}/activity/${r.id}`);
    } catch (err) {
      setError((err as Error).message);
      setStarting(false);
    }
  }

  async function setStatus(status: "published" | "paused" | "archived") {
    if (status === "archived" && !(await confirm({ title: tr("Archive this workflow?"), body: tr("No new runs can start. Past runs and versions are kept."), confirmLabel: tr("Archive"), tone: "danger" }))) return;
    try {
      await api(`organizations/${org}/workflows/${id}/status`, { method: "POST", body: { status } });
      await load(false);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="page">
      <header className="page-bar">
        <PageBreadcrumbs section={tr("Workflows")} href={`/app/${org}/workflows`} context={detail.name} icon={IconWorkflow} />
        <div className="row page-bar-actions">
          {detail.can_edit && detail.status === "published" && (
            <button type="button" className="quiet small" onClick={() => setStatus("paused")}>
              <IconPause size={14} />{tr("Pause")}</button>
          )}
          {detail.can_edit && detail.status === "paused" && (
            <button type="button" className="quiet small" onClick={() => setStatus("published")}>
              <IconPlay size={14} />{tr("Resume")}</button>
          )}
          {detail.can_edit && detail.status !== "archived" && (
            <button type="button" className="quiet small" onClick={() => setStatus("archived")}>
              <IconArchive size={14} />{tr("Archive")}</button>
          )}
          {!ro && (
            <button type="button" className="primary small" disabled={!dirty || saving || !steps} onClick={save}>
              {saving ? <IconSpinner size={14} /> : dirty ? null : <IconCheck size={14} />}
              <SoftText text={saving ? tr("Saving…") : dirty ? tr("Save draft") : tr("Saved")} />
            </button>
          )}
        </div>
      </header>

      <div className="main" style={{ maxWidth: 1240 }}>
        <header className="page-head" style={{ marginBottom: 20 }}>
          <div>
            <h1>{detail.name}</h1>
            <div className="row" style={{ gap: 6, marginTop: 6 }}>
              <StatusBadge status={detail.status} />
              <span className="badge">{versionLabel(detail.active_version?.version)}</span>
              {detail.unpublished_changes && detail.active_version && <span className="badge">{tr("Changes not published")}</span>}
            </div>
          </div>
        </header>

        {error && (
          <div className="alert" style={{ marginBottom: 16 }}>
            <IconAlert size={16} />
            <span style={{ flex: 1 }}>{error}</span>
            <button type="button" className="quiet icon small" onClick={() => setError(null)} aria-label={tr("Dismiss")}>
              <IconX size={14} />
            </button>
          </div>
        )}

        <div className="ed">
          <fieldset disabled={ro} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }} className="stack">
            <section className="card ed-section">
              <div className="ob-fields">
                <TextField label={tr("Name")} value={name} maxLength={80} onChange={(e) => (setName(e.target.value), setDirty(true))} />
                <TextField label={tr("Description")} value={description} maxLength={400} onChange={(e) => (setDescription(e.target.value), setDirty(true))} />
              </div>
            </section>

            {!steps ? (
              <div className="notice">
                <IconAlert size={16} />{tr("This workflow has branches the editor can't show yet. It still works; ask your admin to change it.")}</div>
            ) : (
              <div className="flow" aria-label={tr("Workflow steps")}>
                {steps.map((s, i) => {
                  const n = s.node;
                  const errs = errorsFor(n.id);
                  const middle = n.type !== "START" && n.type !== "END";
                  const priorAgents = steps.slice(0, i).filter((x) => x.node.type === "AGENT_TASK");
                  return (
                    <Fragment key={n.id}>
                      <div className="flow-node" data-type={n.type} data-invalid={errs.length ? "" : undefined}>
                        <span className="kind">
                          <NodeIcon type={n.type} />
                        </span>
                        <div className="body">
                          <strong>{tr(NODE_COPY[n.type])}</strong>
                          {n.type === "AGENT_TASK" && (
                            <div className="fields">
                              <div className="field">
                                <label>{tr("Agent")}</label>
                                <Select
                                  value={n.agent ?? ""}
                                  placeholder={tr("Choose a published agent")}
                                  onChange={(x) => patchNode(i, { agent: x })}
                                  ariaLabel={tr("Agent")}
                                  options={agents.map((a) => ({ value: a.slug, label: a.name, hint: a.active_version ? `v${a.active_version}${a.status !== "published" ? ` · ${a.status}` : ""}` : "Not published yet" }))}
                                />
                              </div>
                              <TextField label={tr("Label")} value={n.label ?? ""} maxLength={120} placeholder={tr("What this step does")} onChange={(e) => patchNode(i, { label: e.target.value })} />
                            </div>
                          )}
                          {(n.type === "HUMAN_REVIEW" || n.type === "APPROVAL_GATE") && (
                            <>
                              <small>{n.type === "HUMAN_REVIEW" ? tr("A person reviews what the agents did. Rejecting stops the workflow.") : tr("A person approves before the next step, for these exact documents.")}</small>
                              <div className="fields">
                                <div className="field">
                                  <label>{tr("Assigned role")}</label>
                                  <Select value={n.role ?? "reviewer"} onChange={(x) => patchNode(i, { role: x as WfNode["role"] })} ariaLabel={tr("Assigned role")} options={["reviewer", "approver", "signatory"].map((r) => ({ value: r, label: ROLE_COPY[r]! }))} />
                                </div>
                                <TextField label={tr("Time to decide (hours)")} type="number" min={1} max={168} value={n.expires_hours ?? 48} onChange={(e) => patchNode(i, { expires_hours: Number(e.target.value) })} />
                                <TextField label={tr("Label")} value={n.label ?? ""} maxLength={120} onChange={(e) => patchNode(i, { label: e.target.value })} />
                              </div>
                            </>
                          )}
                          {n.type === "CONDITION" && (
                            <>
                              <div className="fields">
                                <div className="field">
                                  <label>{tr("If agent")}</label>
                                  <Select value={n.source ?? ""} placeholder={tr("Earlier agent step")} onChange={(x) => patchNode(i, { source: x })} ariaLabel={tr("Condition source")} options={priorAgents.map((a) => ({ value: a.node.id, label: a.node.label || a.node.agent || a.node.id }))} />
                                </div>
                                <div className="field">
                                  <label>{tr("Check")}</label>
                                  <Select value={n.check ?? "has_citations"} onChange={(x) => patchNode(i, { check: x as WfNode["check"] })} ariaLabel={tr("Condition check")} options={Object.entries(CHECK_COPY()).map(([value, label]) => ({ value, label }))} />
                                </div>
                                {n.check === "answer_contains" && <TextField label={tr("Text")} value={n.value ?? ""} maxLength={200} onChange={(e) => patchNode(i, { value: e.target.value })} />}
                              </div>
                              <small>{tr("If not, the workflow ends here (“")}{tr(s.falseEnd?.label) ?? tr("Closed by check")}”).</small>
                            </>
                          )}
                          {n.type === "EXTERNAL_ACTION" && (
                            <>
                              <small>{tr("Only happens after a person approves. Agents never send anything on their own.")}</small>
                              <div className="fields">
                                <div className="field">
                                  <label>{tr("Action")}</label>
                                  <Select
                                    value={n.tool ?? "create_signature_draft"}
                                    onChange={(x) => patchNode(i, { tool: x })}
                                    ariaLabel={tr("External action")}
                                    options={EXTERNAL_TOOLS().filter((x) => !x.locked).map((x) => ({ value: x.value, label: x.label, hint: x.hint }))}
                                  />
                                </div>
                                {n.tool === "share_document" && (
                                  <TextField label={tr("Link expires after (days)")} type="number" min={1} max={30} value={n.expires_days ?? 7} onChange={(e) => patchNode(i, { expires_days: Number(e.target.value) })} />
                                )}
                                <TextField label={tr("Label")} value={n.label ?? ""} maxLength={120} onChange={(e) => patchNode(i, { label: e.target.value })} />
                              </div>
                            </>
                          )}
                          {n.type === "WAIT_EVENT" && <small>{tr("Waits until everyone has signed, then continues.")}</small>}
                          {n.type === "START" && <small>{tr("Starts when someone runs it and describes the task.")}</small>}
                          {n.type === "END" && <small>{tr("Done.")}</small>}
                          {errs.map((e, k) => (
                            <div key={k} className="issue err">
                              <IconAlert size={14} />
                              <span>{e.message}</span>
                            </div>
                          ))}
                        </div>
                        {middle && !ro && (
                          <div className="tools">
                            <button type="button" className="quiet icon small" aria-label={tr("Move up")} disabled={i <= 1} onClick={() => touch((x) => (([x[i - 1], x[i]] = [x[i]!, x[i - 1]!]), x))}>
                              <IconChevronDown size={14} style={{ transform: "rotate(180deg)" }} />
                            </button>
                            <button type="button" className="quiet icon small" aria-label={tr("Move down")} disabled={i >= steps.length - 2} onClick={() => touch((x) => (([x[i], x[i + 1]] = [x[i + 1]!, x[i]!]), x))}>
                              <IconChevronDown size={14} />
                            </button>
                            <button type="button" className="danger icon small" aria-label={tr("Remove step")} onClick={() => touch((x) => x.filter((_, j) => j !== i))}>
                              <IconTrash size={14} />
                            </button>
                          </div>
                        )}
                      </div>
                      {n.type !== "END" && (
                        <>
                          <span className="flow-link" aria-hidden="true">
                            {n.type === "CONDITION" && <span className="branch">{tr("if yes")}</span>}
                          </span>
                          {!ro && catalog && (
                            <>
                              <Insert
                                types={catalog.node_types}
                                onPick={(t) =>
                                  touch((x) => {
                                    const taken = new Set(x.flatMap((y) => [y.node.id, y.falseEnd?.id ?? ""]));
                                    x.splice(i + 1, 0, newNode(t, taken));
                                    return x;
                                  })
                                }
                              />
                              <span className="flow-link" aria-hidden="true" />
                            </>
                          )}
                        </>
                      )}
                    </Fragment>
                  );
                })}
              </div>
            )}
          </fieldset>

          <aside className="ed-side">
            <section className="card ed-section">
              <header>
                <h2>{tr("Checklist")}</h2>
                {v.ok ? (
                  <span className="badge ok">
                    <IconCheck size={12} />{tr("All good")}</span>
                ) : (
                  <span className="badge err">{v.errors.length === 1 ? tr("1 thing to fix") : tr("{length} things to fix", { length: v.errors.length })}</span>
                )}
              </header>
              {dirty && <p className="muted" style={{ fontSize: 12.5 }}>{tr("Save your changes to check them again.")}</p>}
              <div className="issues">
                {v.errors
                  .filter((e) => !e.node)
                  .map((e, k) => (
                    <div key={k} className="issue err">
                      <IconAlert size={14} />
                      <span>{e.message}</span>
                    </div>
                  ))}
                {v.warnings.map((e, k) => (
                  <div key={k} className="issue warn">
                    <IconShield size={14} />
                    <span>{e.message}</span>
                  </div>
                ))}
                {v.ok && !v.warnings.length && <p className="muted" style={{ fontSize: 13 }}>{tr("Everything looks right. Any rejection stops the workflow.")}</p>}
              </div>
            </section>

            <section className="card ed-section">
              <header>
                <h2>{tr("Rules")}</h2>
              </header>
              <fieldset disabled={ro} style={{ border: 0, padding: 0, margin: 0 }} className="stack">
                <Checkbox
                  checked={policies.separation_of_duties}
                  onChange={(on) => !ro && (setPolicies({ ...policies, separation_of_duties: on }), setDirty(true))}
                  label={tr("Whoever starts the workflow can't approve it (recommended)")}
                />
                <p className="muted" style={{ fontSize: 12.5 }}>{tr("Always on: a rejection stops the workflow, and nothing is sent outside without a person's approval.")}</p>
              </fieldset>
            </section>

            <Disclosure title={tr("Advanced limits")} hint={tr("Recommended values are already set.")}>
              <fieldset disabled={ro} style={{ border: 0, padding: 0, margin: 0 }} className="stack">
                <TextField label={tr("Agents in a row (max)")} type="number" min={1} max={5} value={policies.max_hops} onChange={(e) => (setPolicies({ ...policies, max_hops: Number(e.target.value) }), setDirty(true))} />
                <TextField label={tr("Agent steps per run (max)")} type="number" min={1} max={50} value={policies.budget.max_agent_calls} onChange={(e) => (setPolicies({ ...policies, budget: { ...policies.budget, max_agent_calls: Number(e.target.value) } }), setDirty(true))} />
                <TextField label={tr("Document searches per run (max)")} type="number" min={1} max={100} value={policies.budget.max_retrieval_calls} onChange={(e) => (setPolicies({ ...policies, budget: { ...policies.budget, max_retrieval_calls: Number(e.target.value) } }), setDirty(true))} />
                <span className="setting-hint">{tr("These keep a workflow from running too long or costing too much.")}</span>
              </fieldset>
            </Disclosure>

            {detail.can_run && (
              <section className="card ed-section">
                <header>
                  <h2>{tr("Run it")}</h2>
                  <span className="badge mono">v{detail.active_version?.version}</span>
                </header>
                <form className="stack" style={{ gap: 10 }} onSubmit={startRun}>
                  <textarea rows={3} maxLength={2000} placeholder={tr("What should the agents do? e.g. Review the notice period in the master agreement")} value={task} onChange={(e) => ((runKey.current = null), setTask(e.target.value))} aria-label={tr("Run task")} />
                  {detail.run_needs?.signers && (
                    <div className="ob-group">
                      <span className="label">{tr("Signers")}{" "}<small>{tr("each person signs in Ragsis")}</small></span>
                      {signers.map((sg, k) => (
                        <div className="inline-form" key={k}>
                          <TextField placeholder={tr("Full name")} value={sg.name} aria-label={tr("Signer {v1} name", { v1: k + 1 })} onChange={(e) => ((runKey.current = null), setSigners(signers.map((x, j) => (j === k ? { ...x, name: e.target.value } : x))))} />
                          <TextField type="email" placeholder="email@company.com" value={sg.email} aria-label={tr("Signer {v1} email", { v1: k + 1 })} onChange={(e) => ((runKey.current = null), setSigners(signers.map((x, j) => (j === k ? { ...x, email: e.target.value } : x))))} />
                        </div>
                      ))}
                      <div>
                        <button type="button" className="quiet small" disabled={signers.length >= 10} onClick={() => setSigners([...signers, { name: "", email: "" }])}>
                          <IconPlus size={14} />{tr("Add signer")}</button>
                      </div>
                    </div>
                  )}
                  {detail.run_needs?.recipients && (
                    <div className="field">
                      <label htmlFor="run-recipients">{tr("Share with (approved companies only)")}</label>
                      <textarea id="run-recipients" rows={2} placeholder={tr("legal@partner.com, cfo@partner.com")} value={recipients} onChange={(e) => ((runKey.current = null), setRecipients(e.target.value))} />
                    </div>
                  )}
                  <button type="submit" className="primary small" disabled={starting || task.trim().length < 2}>
                    {starting ? <IconSpinner size={14} /> : <IconPlay size={14} />}{tr("Start")}</button>
                </form>
                <p className="muted" style={{ fontSize: 12.5 }}>{tr("Agents only see what you can see. Reviewers only see what they're allowed to read.")}</p>
              </section>
            )}

            {!ro && (
              <section className="card ed-section">
                <header>
                  <h2>{tr("Publish")}</h2>
                </header>
                {!detail.publish.allowed ? (
                  <ul style={{ listStyle: "none", padding: 0, display: "flex", flexDirection: "column", gap: 4, fontSize: 13, color: "var(--muted)" }}>
                    {(dirty ? ["save your changes", ...detail.publish.reasons] : detail.publish.reasons).map((r) => (
                      <li key={r}>· {r}</li>
                    ))}
                  </ul>
                ) : (
                  <div className="dialog-form">
                    {detail.active_version && (
                      <div className="field">
                        <label>{tr("Type of change")}</label>
                        <Seg role="group" aria-label={tr("Type of change")}>
                          {([["patch", tr("Small fix")], ["minor", tr("Improvement")], ["major", tr("Big change")]] as const).map(([b, l]) => (
                            <button key={b} type="button" aria-pressed={bump === b} onClick={() => setBump(b)}>
                              {l}
                            </button>
                          ))}
                        </Seg>
                      </div>
                    )}
                    <div className="field">
                      <label htmlFor="wf-changelog">{tr("What changed?")}</label>
                      <textarea id="wf-changelog" rows={2} maxLength={1000} value={changelog} onChange={(e) => setChangelog(e.target.value)} placeholder={tr("e.g. Added a legal review step")} />
                    </div>
                    <button type="button" className="primary" disabled={dirty || changelog.trim().length < 3} onClick={publish}>
                      <IconRocket size={16} />{tr("Publish")}{" "}{detail.active_version ? versionLabel(detail.publish.next_version[bump]) : "v1.0.0"}
                    </button>
                    <p className="muted" style={{ fontSize: 12.5 }}>{tr("Each agent stays on the version that is live today.")}</p>
                  </div>
                )}
              </section>
            )}

            {detail.versions.length > 0 && (
              <section className="card ed-section">
                <header>
                  <h2>{tr("Versions")}</h2>
                </header>
                <ul className="versions">
                  {detail.versions.map((ver) => (
                    <li key={ver.id}>
                      <span className="badge mono">v{ver.version}</span>
                      <span className="meta">
                        <strong style={{ fontWeight: 500, fontSize: 13.5 }}>{ver.changelog}</strong>
                        <small>
                          {when(ver.published_at)} · {ver.published_by ?? "—"}
                        </small>
                      </span>
                      {detail.active_version?.id === ver.id && <span className="badge ok">{tr("Live")}</span>}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </aside>
        </div>
      </div>
      <Toast message={notice} onDone={clearNotice} />
    </div>
  );
}
