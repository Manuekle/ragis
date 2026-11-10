"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { PageBreadcrumbs } from "@/components/PageBreadcrumbs";
import { RunDetailSkeleton } from "@/components/skeletons";
import { IconActivity, IconAlert, IconCheck, IconHourglass, IconLock, IconSpinner, IconStop, IconX } from "@/components/icons";
import { Toast } from "@/components/motion";
import { useConfirm } from "@/components/ui";
import { ERROR_COPY, NODE_COPY, NodeIcon, ROLE_COPY, STATE_COPY, StateBadge, when, type WfGraph, type WfNode } from "../../workflows/shared";
import { humanize } from "@/lib/plain";

interface Citation { n: number; title: string; page: number | null; snippet: string; document_id: string }
interface Step {
  id: string;
  seq: number;
  node_id: string;
  node_type: string;
  state: string;
  attempt: number;
  hop: number;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  output: {
    answer?: string | null;
    abstained?: boolean;
    citations?: Citation[];
    proposals?: { tool: string; decision: string; note: string }[];
    context_received?: { from: string[]; citations_passed: number; citations_withheld: number };
    redacted?: { hidden_citations: number; reason: string };
    result?: boolean;
    envelope_id?: string;
    provider?: string;
    state?: string;
    signers?: { name: string; email: string }[];
    shares?: { id: string; title: string; expires_at: string }[];
    recipients?: string[];
    event?: string;
    decision?: string;
    comment?: string | null;
    reason?: string;
  };
}
interface Approval {
  id: string;
  step_id: string;
  kind: string;
  title: string;
  assigned_role: string;
  binding: {
    documents: { document_id: string; version_id: string }[];
    purpose: string;
    outputs_hash: string;
    details?: {
      kind: "send_signature" | "share";
      envelope?: { id: string; provider: string; signers: { name: string; email: string }[]; documents: { sha256: string }[] } | null;
      recipients?: string[];
      artifact?: { kind: "signed" | "document" };
      expires_days?: number;
    } | null;
  };
  action_hash: string;
  status: string;
  expires_at: string;
  decided_at: string | null;
  decided_by: string | null;
  comment: string | null;
  can_decide: boolean;
}
interface Run {
  id: string;
  state: string;
  workflow_id: string;
  workflow_name: string;
  workflow_version: string;
  graph: WfGraph;
  initiated_by_email: string | null;
  created_at: string;
  completed_at: string | null;
  error_code: string | null;
  error_detail: string | null;
  usage: { agent_calls: number; retrieval_calls: number };
  input: { task: string };
  can_cancel: boolean;
  steps: Step[];
  approvals: Approval[];
  events: { event_id: string; type: string; occurred_at: string; aggregate_id: string }[];
}

function Decision({ a, onDone }: { a: Approval; onDone: (msg: string) => void }) {
  const { org } = useParams<{ org: string }>();
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function decide(decision: "approve" | "reject") {
    setBusy(decision);
    setError(null);
    try {
      // El hash enviado es el que esta pantalla mostró: si el artefacto cambió, el servidor rechaza la decisión.
      await api(`organizations/${org}/approvals/${a.id}/decision`, { method: "POST", body: { decision, action_hash: a.action_hash, comment: comment || undefined } });
      window.dispatchEvent(new Event("ragsis:inbox"));
      onDone(decision === "approve" ? "Approved — the run continues" : "Rejected — the run stopped");
    } catch (e) {
      setError((e as Error).message);
      onDone("");
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="approval">
      <textarea rows={2} maxLength={1000} placeholder="Comment (optional, saved in the activity log)" value={comment} onChange={(e) => setComment(e.target.value)} aria-label="Decision comment" />
      <div className="actions">
        <button type="button" className="primary small" disabled={!!busy} onClick={() => decide("approve")}>
          {busy === "approve" ? <IconSpinner size={14} /> : <IconCheck size={14} />}
          Approve
        </button>
        <button type="button" className="ghost small" disabled={!!busy} onClick={() => decide("reject")}>
          {busy === "reject" ? <IconSpinner size={14} /> : <IconX size={14} />}
          Reject
        </button>
        <span className="hash">hash {a.action_hash.slice(0, 12)}…</span>
      </div>
      {error && (
        <div className="alert">
          <IconAlert size={16} />
          {error}
        </div>
      )}
    </div>
  );
}

export default function RunPage() {
  const { org, id } = useParams<{ org: string; id: string }>();
  const confirm = useConfirm();
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const clearNotice = useCallback(() => setNotice(null), []);

  const load = useCallback(async () => {
    try {
      setRun(await api<Run>(`organizations/${org}/runs/${id}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [org, id]);

  useEffect(() => {
    load();
  }, [load]);

  // Mientras el runner trabaja, refresco corto; en espera humana o terminado, no hay polling.
  useEffect(() => {
    if (!run || !["QUEUED", "RUNNING"].includes(run.state)) return;
    const t = setTimeout(load, 1200);
    return () => clearTimeout(t);
  }, [run, load]);

  if (!run) {
    if (!error) return <RunDetailSkeleton />;
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

  const nodes = new Map<string, WfNode>(run.graph.nodes.map((n) => [n.id, n]));
  const approvalFor = (stepId: string) => run.approvals.find((a) => a.step_id === stepId);

  async function cancel() {
    if (!(await confirm({ title: "Cancel this run?", body: "Pending approvals are revoked. Completed steps stay in the history.", confirmLabel: "Cancel run", tone: "danger" }))) return;
    try {
      await api(`organizations/${org}/runs/${id}/cancel`, { method: "POST" });
      setNotice("Run cancelled");
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="page">
      <header className="page-bar">
        <PageBreadcrumbs section="Activity" href={`/app/${org}/activity`} context={run.workflow_name} icon={IconActivity} />
        {run.can_cancel && (
          <button type="button" className="primary small" onClick={cancel}>
            <IconStop size={14} />
            Cancel run
          </button>
        )}
      </header>

      <div className="main" style={{ maxWidth: 1240 }}>
        <header className="page-head" style={{ marginBottom: 20 }}>
          <div>
            <h1>{run.workflow_name}</h1>
            <div className="row" style={{ gap: 6, marginTop: 6 }}>
              <StateBadge state={run.state} />
              <Link href={`/app/${org}/workflows/${run.workflow_id}`} className="badge mono" style={{ textDecoration: "none" }}>
                v{run.workflow_version}
              </Link>
              <span className="badge">
                {run.usage.agent_calls} agent {run.usage.agent_calls === 1 ? "step" : "steps"}
              </span>
            </div>
          </div>
        </header>

        {error && (
          <div className="alert" style={{ marginBottom: 16 }}>
            <IconAlert size={16} />
            {error}
          </div>
        )}
        {run.error_code && (
          <div className={run.state === "FAILED" ? "alert" : "notice"} style={{ marginBottom: 16 }}>
            <IconAlert size={16} />
            <span>
              {ERROR_COPY[run.error_code] ?? run.error_code}
              {run.error_detail && !ERROR_COPY[run.error_code] ? ` — ${run.error_detail}` : ""}
            </span>
          </div>
        )}

        <div className="ed">
          <section className="card">
            <ol className="tl">
              {run.steps.map((s) => {
                const node = nodes.get(s.node_id);
                const a = approvalFor(s.id);
                const o = s.output;
                return (
                  <li key={s.id} data-s={s.state}>
                    <span className="dot">
                      <NodeIcon type={s.node_type} size={15} />
                    </span>
                    <div className="content">
                      <header>
                        <strong>{node?.label || (node?.type === "AGENT_TASK" ? node.agent : NODE_COPY[s.node_type as keyof typeof NODE_COPY] ?? s.node_type)}</strong>
                        <StateBadge state={s.state} />
                        {s.node_type === "AGENT_TASK" && node?.agent_version && <span className="badge" style={{ fontSize: 11 }}>v{node.agent_version}</span>}
                        {s.attempt > 1 && <span className="badge">retried</span>}
                        <small>{when(s.started_at)}</small>
                      </header>

                      {s.node_type === "AGENT_TASK" && (
                        <>
                          {o.redacted ? (
                            <div className="notice info">
                              <IconLock size={16} />
                              Result hidden: it uses {o.redacted.hidden_citations} {o.redacted.hidden_citations === 1 ? "document" : "documents"} you can't open.
                            </div>
                          ) : o.answer ? (
                            <div className="run-answer">{o.answer}</div>
                          ) : o.abstained ? (
                            <div className="run-answer muted">No answer — not enough evidence in the agent's folders.</div>
                          ) : null}
                          {!!o.citations?.length && (
                            <ul className="run-cites">
                              {o.citations.map((c) => (
                                <li key={c.n}>
                                  <b>[{c.n}]</b>
                                  <span>
                                    {c.title}
                                    {c.page ? ` · p. ${c.page}` : ""}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                          {!!o.proposals?.length && (
                            <div className="row" style={{ gap: 4 }}>
                              {o.proposals.map((p) => (
                                <span key={p.tool} className="badge" data-tip={p.note}>
                                  Suggested: {humanize(p.tool)} (not done)
                                </span>
                              ))}
                            </div>
                          )}
                          {o.context_received && o.context_received.from.length > 0 && (
                            <small className="muted" style={{ fontSize: 12.5 }}>
                              Used {o.context_received.citations_passed} {o.context_received.citations_passed === 1 ? "source" : "sources"} from earlier steps
                              {o.context_received.citations_withheld ? ` · ${o.context_received.citations_withheld} hidden (outside this agent's folders)` : ""}
                            </small>
                          )}
                        </>
                      )}

                      {s.node_type === "CONDITION" && <small className="muted">{o.result ? "Check passed — continued" : "Check not met — workflow ended"}</small>}

                      {s.node_type === "EXTERNAL_ACTION" && o.envelope_id && (
                        <div className="row" style={{ gap: 8, fontSize: 13 }}>
                          <Link href={`/app/${org}/signatures/${o.envelope_id}`} className="badge accent" style={{ textDecoration: "none" }}>
                            Signature request · {o.state ? (STATE_COPY[o.state] ?? o.state.toLowerCase()) : ""}
                          </Link>
                          {o.signers?.map((sg) => (
                            <span key={sg.email} className="badge">
                              {sg.name} · {sg.email}
                            </span>
                          ))}
                        </div>
                      )}
                      {s.node_type === "EXTERNAL_ACTION" && o.shares && (
                        <div className="row" style={{ gap: 8, fontSize: 13 }}>
                          {o.shares.map((sh) => (
                            <Link key={sh.id} href={`/app/${org}/signatures#shares`} className="badge accent" style={{ textDecoration: "none" }}>
                              {sh.title} · expires {when(sh.expires_at)}
                            </Link>
                          ))}
                          <span className="muted">to {o.recipients?.join(", ")}</span>
                        </div>
                      )}
                      {s.node_type === "WAIT_EVENT" && o.envelope_id && (
                        <small className="muted">
                          {s.state === "WAITING" ? "Waiting for everyone to sign. " : ""}
                          <Link href={`/app/${org}/signatures/${o.envelope_id}`}>Open signature request</Link>
                        </small>
                      )}

                      {a && (
                        <div className="tile stack" style={{ gap: 10 }}>
                          <dl className="kv-list">
                            <dt>Assigned to</dt>
                            <dd>{ROLE_COPY[a.assigned_role] ?? a.assigned_role}</dd>
                            <dt>Covers</dt>
                            <dd>{a.binding.documents.length} {a.binding.documents.length === 1 ? "document" : "documents"} and the agents' results</dd>
                            {a.binding.details?.kind === "send_signature" && a.binding.details.envelope && (
                              <>
                                <dt>Authorizes</dt>
                                <dd>
                                  Sending for signature to {a.binding.details.envelope.signers.map((x) => `${x.name} (${x.email})`).join(", ")}
                                </dd>
                              </>
                            )}
                            {a.binding.details?.kind === "share" && (
                              <>
                                <dt>Authorizes</dt>
                                <dd>
                                  Sharing the {a.binding.details.artifact?.kind === "signed" ? "signed copy" : "approved document(s)"} with {a.binding.details.recipients?.join(", ")} for {a.binding.details.expires_days} day(s)
                                </dd>
                              </>
                            )}
                            <dt>Status</dt>
                            <dd>
                              <StateBadge state={a.status} />
                            </dd>
                            {a.status === "PENDING" && (
                              <>
                                <dt>Expires</dt>
                                <dd className="row" style={{ gap: 6 }}>
                                  <IconHourglass size={13} />
                                  {when(a.expires_at)}
                                </dd>
                              </>
                            )}
                            {a.decided_by && (
                              <>
                                <dt>Decided by</dt>
                                <dd>
                                  {a.decided_by} · {when(a.decided_at)}
                                </dd>
                              </>
                            )}
                            {a.comment && (
                              <>
                                <dt>Comment</dt>
                                <dd>{a.comment}</dd>
                              </>
                            )}
                          </dl>
                          {a.can_decide ? (
                            <Decision
                              a={a}
                              onDone={(m) => {
                                if (m) setNotice(m);
                                load();
                              }}
                            />
                          ) : (
                            a.status === "PENDING" && <small className="muted">Waiting for someone with the {ROLE_COPY[a.assigned_role]?.toLowerCase()} role{run.graph.policies.separation_of_duties ? " (not the person who started it)" : ""}.</small>
                          )}
                        </div>
                      )}
                      {s.error && !a && <small style={{ color: "var(--err)", fontSize: 12.5 }}>{ERROR_COPY[s.error] ?? s.error}</small>}
                    </div>
                  </li>
                );
              })}
              {["QUEUED", "RUNNING"].includes(run.state) && (
                <li data-s="RUNNING">
                  <span className="dot">
                    <IconSpinner size={14} />
                  </span>
                  <div className="content">
                    <small className="muted">Working…</small>
                  </div>
                </li>
              )}
            </ol>
          </section>

          <aside className="ed-side">
            <section className="card ed-section">
              <header>
                <h2>Details</h2>
              </header>
              <dl className="kv-list">
                <dt>Task</dt>
                <dd>{run.input.task}</dd>
                <dt>Started by</dt>
                <dd>{run.initiated_by_email ?? "—"}</dd>
                <dt>Started</dt>
                <dd>{when(run.created_at)}</dd>
                <dt>Finished</dt>
                <dd>{when(run.completed_at)}</dd>
                <dt>Reference</dt>
                <dd className="hash">{run.id}</dd>
              </dl>
            </section>
            <section className="card ed-section">
              <header>
                <h2>Timeline</h2>
                <span className="badge">{run.events.length}</span>
              </header>
              <ul className="events">
                {run.events.map((e) => (
                  <li key={e.event_id}>
                    <time>{new Date(e.occurred_at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
                    <span>{humanize(e.type)}</span>
                  </li>
                ))}
              </ul>
            </section>
          </aside>
        </div>
      </div>
      <Toast message={notice} onDone={clearNotice} />
    </div>
  );
}
