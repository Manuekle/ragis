"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { IconAlert, IconBuilding } from "@/components/icons";
import { StateIllustration } from "@/components/AppState";
import { PageBreadcrumbs } from "@/components/PageBreadcrumbs";
import { SkeletonRunRows, SkeletonStatus } from "@/components/skeletons";
import { useOrg } from "../layout";
import { ERROR_COPY, StateBadge, ago } from "../workflows/shared";
import { Seg } from "@/components/motion";

interface RunSummary {
  id: string;
  state: string;
  created_at: string;
  error_code: string | null;
  workflow_name: string;
  workflow_version: string;
  initiated_by_email: string | null;
  pending_approvals: number;
  usage: { agent_calls: number; retrieval_calls: number };
}

const FILTERS: [string, string][] = [
  ["", "All"],
  ["WAITING_HUMAN", "Waiting"],
  ["RUNNING", "Running"],
  ["COMPLETED", "Completed"],
  ["FAILED", "Failed"],
  ["CANCELLED", "Cancelled"],
];

export default function ActivityPage() {
  const { org } = useParams<{ org: string }>();
  const { org: orgInfo } = useOrg();
  const [state, setState] = useState("");
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api<{ runs: RunSummary[] }>(`organizations/${org}/runs${state ? `?state=${state}` : ""}`)
      .then((r) => { if (active) setRuns(r.runs); })
      .catch((e) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [org, state]);

  function filterByState(next: string) {
    if (next === state) return;
    setRuns(null);
    setError(null);
    setState(next);
  }

  return (
    <div className="page">
      <header className="page-bar">
        <PageBreadcrumbs section="Activity" context={orgInfo?.name} icon={IconBuilding} />
      </header>
      <div className="main">
        <header className="page-head" style={{ marginBottom: 20 }}>
          <div>
            <h1>Activity</h1>
            <p className="sub">Every workflow that ran, with each step, who decided what, and the sources used.</p>
          </div>
        </header>

        <Seg role="group" aria-label="Filter by state" style={{ marginBottom: 16 }}>
          {FILTERS.map(([v, l]) => (
            <button key={v} type="button" aria-pressed={state === v} onClick={() => filterByState(v)}>
              {l}
            </button>
          ))}
        </Seg>

        {error && (
          <div className="alert">
            <IconAlert size={16} />
            {error}
          </div>
        )}

        {(!error || runs !== null) && <section className="card" style={{ padding: 0, overflow: "hidden" }}>
          {runs === null ? (
            <SkeletonStatus label="Loading activity…">
              <SkeletonRunRows />
            </SkeletonStatus>
          ) : runs.length === 0 ? (
            <div className="empty">
              <StateIllustration kind="activity" />
              <strong>Nothing here yet</strong>
              <span>Run a published workflow and it will show up here.</span>
            </div>
          ) : (
            runs.map((r) => (
              <Link key={r.id} href={`/app/${org}/activity/${r.id}`} className="run-row">
                <span className="meta">
                  <strong>
                    {r.workflow_name} <span className="faint">v{r.workflow_version}</span>
                  </strong>
                  <small>
                    {r.initiated_by_email ?? "—"} · {ago(r.created_at)} · {r.usage.agent_calls} agent {r.usage.agent_calls === 1 ? "step" : "steps"}
                    {r.error_code ? ` · ${ERROR_COPY[r.error_code] ?? r.error_code}` : ""}
                  </small>
                </span>
                <span className="side">
                  {r.pending_approvals > 0 && <span className="badge warn">{r.pending_approvals === 1 ? "1 approval waiting" : `${r.pending_approvals} approvals waiting`}</span>}
                  <StateBadge state={r.state} />
                </span>
              </Link>
            ))
          )}
        </section>}
      </div>
    </div>
  );
}
