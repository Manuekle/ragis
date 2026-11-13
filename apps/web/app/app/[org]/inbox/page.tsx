"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { InboxSkeleton, Skel, SkeletonStatus } from "@/components/skeletons";
import { useOrg } from "../layout";
import { PageBreadcrumbs } from "@/components/PageBreadcrumbs";
import { IconAgent, IconAlert, IconArrowRight, IconBoard, IconBuilding, IconHourglass, IconList, IconLock, IconPlus, IconTeam } from "@/components/icons";
import { StateIllustration } from "@/components/AppState";
import { Seg, SoftText } from "@/components/motion";
import { ERROR_COPY, NodeIcon, ROLE_COPY, StateBadge, ago, when } from "../workflows/shared";
import { NewRequestDialog, RequestBoard, RequestList, type RequestItem } from "../requests/shared";
import { RequestPanel } from "../requests/RequestPanel";

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
  counts: { agents: number; people: number; total: number };
}
type Tab = "people" | "agents";
type View = "for_me" | "team" | "sent";
type Layout = "list" | "board";

const VIEWS: { key: View; label: string; empty: string }[] = [
  { key: "for_me", label: "For me", empty: "Requests assigned to you, new ones for your team and questions waiting on you show up here." },
  { key: "team", label: "My teams", empty: "Everything other teams ask your team shows up here." },
  { key: "sent", label: "Sent by me", empty: "Requests you send to other teams show up here, so you can follow them." },
];

export default function InboxPage() {
  return (
    <Suspense>
      <InboxScreen />
    </Suspense>
  );
}

function InboxScreen() {
  const { org } = useParams<{ org: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const { org: orgInfo } = useOrg();
  const [data, setData] = useState<Inbox | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tabParam = search.get("tab");
  const tab: Tab = tabParam === "agents" || tabParam === "people" ? tabParam : data && data.counts.people === 0 && data.counts.agents > 0 ? "agents" : "people";

  const load = useCallback(() => {
    api<Inbox>(`organizations/${org}/inbox`)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [org]);
  useEffect(() => {
    load();
    window.addEventListener("ragsis:inbox", load);
    return () => window.removeEventListener("ragsis:inbox", load);
  }, [load]);

  const setTab = (t: Tab) => router.replace(`/app/${org}/inbox?tab=${t}`, { scroll: false });
  const onTabKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const next: Tab = tab === "people" ? "agents" : "people";
      setTab(next);
      document.getElementById(`tab-${next}`)?.focus();
    }
  };

  return (
    <div className="page">
      <header className="page-bar">
        <PageBreadcrumbs section="Inbox" context={orgInfo?.name} icon={IconBuilding} />
      </header>
      <div className="main">
        <header className="page-head" style={{ marginBottom: 16 }}>
          <div>
            <h1>Inbox</h1>
            <p className="sub">What colleagues ask you, and what agents need you to check. Two lists, so neither buries the other.</p>
          </div>
        </header>

        <div className="tabs inbox-tabs" role="tablist" aria-label="Inbox" onKeyDown={onTabKey}>
          <button type="button" role="tab" id="tab-people" aria-selected={tab === "people"} aria-controls="panel-people" tabIndex={tab === "people" ? 0 : -1} onClick={() => setTab("people")}>
            <IconTeam size={16} variant={tab === "people" ? "duotone" : "stroke"} />
            From people
            {!!data?.counts.people && (
              <span className="count" aria-label={`${data.counts.people} need you`}>
                <SoftText text={String(data.counts.people)} />
              </span>
            )}
          </button>
          <button type="button" role="tab" id="tab-agents" aria-selected={tab === "agents"} aria-controls="panel-agents" tabIndex={tab === "agents" ? 0 : -1} onClick={() => setTab("agents")}>
            <IconAgent size={16} variant={tab === "agents" ? "duotone" : "stroke"} />
            From agents
            {!!data?.counts.agents && (
              <span className="count" aria-label={`${data.counts.agents} need you`}>
                <SoftText text={String(data.counts.agents)} />
              </span>
            )}
          </button>
        </div>

        {error && (
          <div className="alert" style={{ marginTop: 16 }}>
            <IconAlert size={16} />
            {error}
          </div>
        )}
        {tab === "people" ? (
          <section className="tab-panel" id="panel-people" role="tabpanel" aria-labelledby="tab-people" key="people">
            <PeopleInbox org={org} isAdmin={orgInfo?.role === "owner" || orgInfo?.role === "admin"} />
          </section>
        ) : (
          <section className="tab-panel" id="panel-agents" role="tabpanel" aria-labelledby="tab-agents" key="agents">
            {!data ? error ? null : <InboxSkeleton /> : <AgentInbox org={org} data={data} isAdmin={orgInfo?.role === "owner" || orgInfo?.role === "admin"} />}
          </section>
        )}
      </div>
    </div>
  );
}

/* ───────────── From people: requests between teams ───────────── */

function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}
function writePref(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {}
}

function PeopleInbox({ org, isAdmin }: { org: string; isAdmin: boolean }) {
  const router = useRouter();
  const search = useSearchParams();
  const openId = search.get("r");
  const { teams } = useOrg();
  const [view, setViewState] = useState<View>("for_me");
  const [layout, setLayoutState] = useState<Layout>("list");
  const [items, setItems] = useState<RequestItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    setViewState(readPref(`ragsis:req-view:${org}`, ["for_me", "team", "sent"] as const, "for_me"));
    setLayoutState(readPref(`ragsis:req-layout:${org}`, ["list", "board"] as const, "list"));
  }, [org]);
  const setView = (v: View) => {
    setViewState(v);
    writePref(`ragsis:req-view:${org}`, v);
  };
  const setLayout = (l: Layout) => {
    setLayoutState(l);
    writePref(`ragsis:req-layout:${org}`, l);
  };

  const load = useCallback(() => {
    setError(null);
    api<{ requests: RequestItem[] }>(`organizations/${org}/requests?view=${view}`)
      .then((r) => setItems(r.requests))
      .catch((e) => setError(e.message));
  }, [org, view]);
  useEffect(() => {
    setItems(null);
    load();
  }, [load]);

  const noTeams = teams !== null && teams.filter((t) => !t.archived_at).length === 0;
  const myTeamCount = (teams ?? []).filter((t) => t.is_member && !t.archived_at).length;
  const viewCopy = VIEWS.find((v) => v.key === view)!;
  const openRequest = (id: string) => router.replace(`/app/${org}/inbox?tab=people&r=${id}`, { scroll: false });
  const closeRequest = useCallback(() => router.replace(`/app/${org}/inbox?tab=people`, { scroll: false }), [router, org]);

  return (
    <>
      <div className="req-toolbar">
        <div className="row">
          <Seg role="group" aria-label="Which requests">
            {VIEWS.map((v) => (
              <button key={v.key} type="button" aria-pressed={view === v.key} onClick={() => setView(v.key)}>
                {v.key === "team" && myTeamCount === 1 ? "My team" : v.label}
              </button>
            ))}
          </Seg>
          <Seg role="group" aria-label="Layout" className="icon-seg">
            <button type="button" aria-pressed={layout === "list"} onClick={() => setLayout("list")} aria-label="List">
              <IconList size={16} />
              <span className="hide-sm">List</span>
            </button>
            <button type="button" aria-pressed={layout === "board"} onClick={() => setLayout("board")} aria-label="Board">
              <IconBoard size={16} />
              <span className="hide-sm">Board</span>
            </button>
          </Seg>
        </div>
        <button type="button" className="primary" disabled={!teams || noTeams} onClick={() => setAsking(true)}>
          <IconPlus size={16} />
          Ask a team
        </button>
      </div>

      {error && (
        <div className="alert" role="alert">
          <IconAlert size={16} />
          {error}
        </div>
      )}

      {noTeams ? (
        <div className="card empty">
          <StateIllustration kind="inbox" />
          <strong>Your company has no teams yet</strong>
          <span>Teams like Legal or Treasury keep their documents apart and receive requests from the rest of the company.</span>
          {isAdmin ? (
            <Link href={`/app/${org}/admin#teams`} className="btn-link">
              Set up teams in Governance
              <IconArrowRight size={14} />
            </Link>
          ) : (
            <span>Ask an admin to set them up.</span>
          )}
        </div>
      ) : !items ? (
        error ? null : (
          <SkeletonStatus label="Loading requests…">
            <div className="card req-list" aria-hidden="true">
              {[0, 1, 2].map((i) => (
                <div key={i} className="req-row">
                  <span className="req-main">
                    <Skel w={i % 2 ? "52%" : "38%"} h={14} />
                    <Skel w="30%" h={11} />
                  </span>
                  <span className="cell due-cell">
                    <Skel w={64} h={12} />
                  </span>
                  <span className="cell who-cell">
                    <Skel w={24} h={24} r={999} />
                  </span>
                  <span className="cell status-cell">
                    <Skel w={86} h={22} r={999} />
                  </span>
                </div>
              ))}
            </div>
          </SkeletonStatus>
        )
      ) : items.length === 0 && layout === "list" ? (
        <div className="card empty">
          <StateIllustration kind="inbox" />
          <strong>{view === "sent" ? "You haven't asked anything yet" : "Nothing waiting for you"}</strong>
          <span>{viewCopy.empty}</span>
        </div>
      ) : layout === "board" ? (
        <RequestBoard org={org} items={items} onMoved={(r) => setItems((cur) => (cur ?? []).map((x) => (x.id === r.id ? r : x)))} />
      ) : (
        <RequestList org={org} items={items} />
      )}

      {asking && teams && (
        <NewRequestDialog
          org={org}
          teams={teams}
          onClose={() => setAsking(false)}
          onCreated={(r) => {
            setAsking(false);
            load();
            openRequest(r.id);
          }}
        />
      )}
      {openId && <RequestPanel org={org} id={openId} onClose={closeRequest} onChanged={load} />}
    </>
  );
}

/* ───────────── From agents: workflow reviews and approvals ───────────── */

function AgentInbox({ org, data, isAdmin }: { org: string; data: Inbox; isAdmin: boolean }) {
  return (
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
  );
}
