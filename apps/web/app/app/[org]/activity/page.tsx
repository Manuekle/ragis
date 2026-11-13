"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { IconAlert, IconBuilding } from "@/components/icons";
import { StateIllustration } from "@/components/AppState";
import { PageBreadcrumbs } from "@/components/PageBreadcrumbs";
import { SkeletonActivityRows, SkeletonStatus } from "@/components/skeletons";
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
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    // Keep the rows already on screen while the next filter loads: the list stays put instead of blinking
    // through a skeleton and snapping back to a different height.
    setPending(true);
    api<{ runs: RunSummary[] }>(`organizations/${org}/runs${state ? `?state=${state}` : ""}`)
      .then((r) => { if (active) { setRuns(r.runs); setError(null); } })
      .catch((e) => { if (active) { setRuns(null); setError(e.message); } })
      .finally(() => { if (active) setPending(false); });
    return () => { active = false; };
  }, [org, state]);

  function filterByState(next: string) {
    if (next === state) return;
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

        {(!error || runs !== null) && (
          runs === null ? (
            <SkeletonStatus label="Loading activity…">
              <SkeletonActivityRows />
            </SkeletonStatus>
          ) : runs.length === 0 ? (
            <div className="card empty">
              <StateIllustration kind="activity" />
              <strong>Nothing here yet</strong>
              <span>{state ? "No run is in this state right now." : "Run a published workflow and it will show up here."}</span>
            </div>
          ) : (
            <section className="card act-list" aria-busy={pending || undefined} data-loading={pending ? "" : undefined}>
              {runs.map((r) => (
                <Link key={r.id} href={`/app/${org}/activity/${r.id}`} className="act-row">
                  <span className="meta">
                    <span className="title">
                      <strong>{r.workflow_name}</strong>
                      <span className="act-ver">v{r.workflow_version}</span>
                    </span>
                    <span className="sub">
                      {r.initiated_by_email ?? "—"}
                      <span className="sep"> · </span>
                      {ago(r.created_at)}
                      <span className="sep"> · </span>
                      {r.usage.agent_calls} agent {r.usage.agent_calls === 1 ? "step" : "steps"}
                      {r.error_code && (
                        <>
                          <span className="sep"> · </span>
                          <span className="err">{ERROR_COPY[r.error_code] ?? r.error_code}</span>
                        </>
                      )}
                    </span>
                  </span>
                  <span className="cell wait-cell">
                    {r.pending_approvals > 0 && <span className="badge warn">{r.pending_approvals === 1 ? "1 approval waiting" : `${r.pending_approvals} approvals waiting`}</span>}
                  </span>
                  <span className="cell state-cell">
                    <StateBadge state={r.state} />
                  </span>
                </Link>
              ))}
            </section>
          )
        )}
      </div>
    </div>
  );
}
