"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { InboxSkeleton } from "@/components/skeletons";
import { useOrg } from "../layout";
import { PageBreadcrumbs } from "@/components/PageBreadcrumbs";
import { IconAlert, IconArrowRight, IconBuilding, IconHourglass, IconLock } from "@/components/icons";
import { StateIllustration } from "@/components/AppState";
import { ERROR_COPY, NodeIcon, ROLE_COPY, StateBadge, ago, when } from "../workflows/shared";

interface Item {
  id: string;
  run_id: string;
  kind: "review" | "approval";
  title: string;
  assigned_role: string;
  workflow_name: string;
  initiated_by_email: string | null;
  expires_at: string;
  created_at: string;
  documents: number;
  invalidated: boolean;
  blocked_by_sod: boolean;
}
interface Inbox {
  roles: string[];
  approvals: Item[];
  my_runs: { id: string; state: string; error_code: string | null; updated_at: string; workflow_name: string }[];
}

export default function InboxPage() {
  const { org } = useParams<{ org: string }>();
  const { org: orgInfo } = useOrg();
  const [data, setData] = useState<Inbox | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Inbox>(`organizations/${org}/inbox`)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [org]);

  const isAdmin = orgInfo?.role === "owner" || orgInfo?.role === "admin";

  return (
    <div className="page">
      <header className="page-bar">
        <PageBreadcrumbs section="Inbox" context={orgInfo?.name} icon={IconBuilding} />
      </header>
      <div className="main">
        <header className="page-head" style={{ marginBottom: 20 }}>
          <div>
            <h1>Inbox</h1>
            <p className="sub">Reviews and approvals waiting for you. Each decision applies to exactly the documents you see.</p>
          </div>
        </header>

        {error && (
          <div className="alert">
            <IconAlert size={16} />
            {error}
          </div>
        )}
        {!data ? (
          error ? null : <InboxSkeleton />
        ) : (
          <div className="inbox-grid">
            <section className="stack" style={{ gap: 12 }}>
              {data.roles.length === 0 && (
                <div className="notice info">
                  <IconLock size={16} />
                  <span>
                    You have no reviewer or approver role yet, so nothing is assigned to you.
                    {isAdmin ? (
                      <>
                        {" "}
                        Grant roles in <Link href={`/app/${org}/admin#roles`}>Governance → Roles</Link>.
                      </>
                    ) : (
                      " Ask an admin to grant one."
                    )}
                  </span>
                </div>
              )}
              {data.approvals.length === 0 && (
                <div className="card empty">
                  <StateIllustration kind="inbox" />
                  <strong>Nothing waiting for you</strong>
                  <span>
                    {data.roles.length > 0
                      ? `New reviews for ${data.roles.map((r) => ROLE_COPY[r]?.toLowerCase() ?? r).join(", ")} will show up here.`
                      : "Reviews and approvals assigned to your roles will show up here."}
                  </span>
                </div>
              )}
              {data.approvals.map((a) => (
                <article key={a.id} className="card approval">
                  <header>
                    <span className="kind">
                      <NodeIcon type={a.kind === "review" ? "HUMAN_REVIEW" : "APPROVAL_GATE"} />
                    </span>
                    <span className="meta">
                      <strong>{a.title}</strong>
                      <small>
                        {a.workflow_name} · started by {a.initiated_by_email ?? "—"} · {ago(a.created_at)}
                      </small>
                    </span>
                    <span className="badge">{ROLE_COPY[a.assigned_role]}</span>
                  </header>
                  <div className="row" style={{ gap: 8, fontSize: 13, color: "var(--muted)" }}>
                    <IconHourglass size={13} />
                    Decide by {when(a.expires_at)} · covers {a.documents} {a.documents === 1 ? "document" : "documents"}
                  </div>
                  {a.invalidated && (
                    <div className="alert">
                      <IconAlert size={16} />A document changed after this was requested. Deciding now will cancel the approval and stop the workflow.
                    </div>
                  )}
                  {a.blocked_by_sod && (
                    <div className="notice">
                      <IconLock size={16} />
                      You started this workflow, so someone else has to decide.
                    </div>
                  )}
                  <div className="actions">
                    <Link href={`/app/${org}/activity/${a.run_id}`} className={a.blocked_by_sod ? "btn-link ghost" : "btn-link"}>
                      {a.blocked_by_sod ? "View details" : "Review and decide"}
                      <IconArrowRight size={14} />
                    </Link>
                  </div>
                </article>
              ))}
            </section>

            <aside className="card ed-section">
              <header>
                <h2>Your workflows</h2>
              </header>
              {data.my_runs.length === 0 ? (
                <p className="muted" style={{ fontSize: 13 }}>Workflows you start that are waiting, running or recently stopped show up here.</p>
              ) : (
                <div style={{ margin: "0 -20px -20px" }}>
                  {data.my_runs.map((r) => (
                    <Link key={r.id} href={`/app/${org}/activity/${r.id}`} className="run-row">
                      <span className="meta">
                        <strong>{r.workflow_name}</strong>
                        <small>
                          {ago(r.updated_at)}
                          {r.error_code ? ` · ${ERROR_COPY[r.error_code] ?? r.error_code}` : ""}
                        </small>
                      </span>
                      <span className="side">
                        <StateBadge state={r.state} />
                      </span>
                    </Link>
                  ))}
                </div>
              )}
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}
