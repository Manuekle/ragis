"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { InboxSkeleton, Skel, SkeletonStatus } from "@/components/skeletons";
import { useOrg } from "../layout";
import { PageBreadcrumbs } from "@/components/PageBreadcrumbs";
import { IconAgent, IconAlert, IconArrowRight, IconBoard, IconBuilding, IconFile, IconHourglass, IconList, IconLock, IconPlus, IconTeam } from "@/components/icons";
import { StateIllustration } from "@/components/AppState";
import { Seg, SoftText } from "@/components/motion";
import { ERROR_COPY, NodeIcon, ROLE_COPY, StateBadge, ago, when } from "../workflows/shared";
import { NewRequestDialog, RequestBoard, RequestList, type RequestItem } from "../requests/shared";
import { RequestPanel } from "../requests/RequestPanel";
import { useT, tNow } from "@/lib/use-t";
import { StandingBadge, longDate, type Candidate, type Deadline, type DeadlineList } from "../terminos/shared";
import "../terminos/terminos.css";

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
  counts: { agents: number; people: number; deadlines?: number; candidates?: number; total: number };
}
type Tab = "people" | "agents" | "deadlines";
const TABS: Tab[] = ["people", "agents", "deadlines"];
type View = "for_me" | "team" | "sent";
type Layout = "list" | "board";

const VIEWS = (): { key: View; label: string; empty: string }[] => ([
  { key: "for_me", label: tNow("For me"), empty: tNow("Requests assigned to you, new ones for your team and questions waiting on you show up here.") },
  { key: "team", label: tNow("My teams"), empty: tNow("Everything other teams ask your team shows up here.") },
  { key: "sent", label: tNow("Sent by me"), empty: tNow("Requests you send to other teams show up here, so you can follow them.") },
]);

export default function InboxPage() {
  return (
    <Suspense>
      <InboxScreen />
    </Suspense>
  );
}

function InboxScreen() {
  const tr = useT();
  const { org } = useParams<{ org: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const { org: orgInfo } = useOrg();
  const [data, setData] = useState<Inbox | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tabParam = search.get("tab");
  const dueCount = (data?.counts.deadlines ?? 0) + (data?.counts.candidates ?? 0);
  const tab: Tab = TABS.includes(tabParam as Tab)
    ? (tabParam as Tab)
    : data && data.counts.people === 0 && data.counts.agents > 0
      ? "agents"
      : data && data.counts.people === 0 && dueCount > 0
        ? "deadlines"
        : "people";

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
      const i = TABS.indexOf(tab);
      const next: Tab = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
      setTab(next);
      document.getElementById(`tab-${next}`)?.focus();
    }
  };

  return (
    <div className="page">
      <header className="page-bar">
        <PageBreadcrumbs section={tr("Inbox")} context={orgInfo?.name} icon={IconBuilding} />
      </header>
      <div className="main">
        <header className="page-head" style={{ marginBottom: 16 }}>
          <div>
            <h1>{tr("Inbox")}</h1>
            <p className="sub">{tr("What colleagues ask you, what agents need you to check, and your deadlines coming due. Separate lists, so none buries the others.")}</p>
          </div>
        </header>

        <div className="tabs inbox-tabs" role="tablist" aria-label={tr("Inbox")} onKeyDown={onTabKey}>
          <button type="button" role="tab" id="tab-people" aria-selected={tab === "people"} aria-controls="panel-people" tabIndex={tab === "people" ? 0 : -1} onClick={() => setTab("people")}>
            <IconTeam size={16} variant={tab === "people" ? "duotone" : "stroke"} />{tr("From people")}{!!data?.counts.people && (
              <span className="count" aria-label={tr("{people} need you", { people: data.counts.people })}>
                <SoftText text={String(data.counts.people)} />
              </span>
            )}
          </button>
          <button type="button" role="tab" id="tab-agents" aria-selected={tab === "agents"} aria-controls="panel-agents" tabIndex={tab === "agents" ? 0 : -1} onClick={() => setTab("agents")}>
            <IconAgent size={16} variant={tab === "agents" ? "duotone" : "stroke"} />{tr("From agents")}{!!data?.counts.agents && (
              <span className="count" aria-label={tr("{agents} need you", { agents: data.counts.agents })}>
                <SoftText text={String(data.counts.agents)} />
              </span>
            )}
          </button>
          <button type="button" role="tab" id="tab-deadlines" aria-selected={tab === "deadlines"} aria-controls="panel-deadlines" tabIndex={tab === "deadlines" ? 0 : -1} onClick={() => setTab("deadlines")}>
            <IconHourglass size={16} variant={tab === "deadlines" ? "duotone" : "stroke"} />{tr("Deadlines")}{dueCount > 0 && (
              <span className="count" aria-label={tr("{count} need you", { count: dueCount })}>
                <SoftText text={String(dueCount)} />
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
        ) : tab === "agents" ? (
          <section className="tab-panel" id="panel-agents" role="tabpanel" aria-labelledby="tab-agents" key="agents">
            {!data ? error ? null : <InboxSkeleton /> : <AgentInbox org={org} data={data} isAdmin={orgInfo?.role === "owner" || orgInfo?.role === "admin"} />}
          </section>
        ) : (
          <section className="tab-panel" id="panel-deadlines" role="tabpanel" aria-labelledby="tab-deadlines" key="deadlines">
            <DeadlineInbox org={org} />
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
  const tr = useT();
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
  const viewCopy = VIEWS().find((v) => v.key === view)!;
  const openRequest = (id: string) => router.replace(`/app/${org}/inbox?tab=people&r=${id}`, { scroll: false });
  const closeRequest = useCallback(() => router.replace(`/app/${org}/inbox?tab=people`, { scroll: false }), [router, org]);

  return (
    <>
      <div className="req-toolbar">
        <div className="row">
          <Seg role="group" aria-label={tr("Which requests")}>
            {VIEWS().map((v) => (
              <button key={v.key} type="button" aria-pressed={view === v.key} onClick={() => setView(v.key)}>
                {v.key === "team" && myTeamCount === 1 ? tr("My team") : tr(v.label)}
              </button>
            ))}
          </Seg>
          <Seg role="group" aria-label={tr("Layout")} className="icon-seg">
            <button type="button" aria-pressed={layout === "list"} onClick={() => setLayout("list")} aria-label={tr("List")}>
              <IconList size={16} />
              <span className="hide-sm">{tr("List")}</span>
            </button>
            <button type="button" aria-pressed={layout === "board"} onClick={() => setLayout("board")} aria-label={tr("Board")}>
              <IconBoard size={16} />
              <span className="hide-sm">{tr("Board")}</span>
            </button>
          </Seg>
        </div>
        <button type="button" className="primary" disabled={!teams || noTeams} onClick={() => setAsking(true)}>
          <IconPlus size={16} />{tr("Ask a team")}</button>
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
          <strong>{tr("Your company has no teams yet")}</strong>
          <span>{tr("Teams like Legal or Treasury keep their documents apart and receive requests from the rest of the company.")}</span>
          {isAdmin ? (
            <Link href={`/app/${org}/admin#teams`} className="btn-link">{tr("Set up teams in Governance")}<IconArrowRight size={14} />
            </Link>
          ) : (
            <span>{tr("Ask an admin to set them up.")}</span>
          )}
        </div>
      ) : !items ? (
        error ? null : (
          <SkeletonStatus label={tr("Loading requests…")}>
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
          <strong>{view === "sent" ? tr("You haven't asked anything yet") : tr("Nothing waiting for you")}</strong>
          <span>{tr(viewCopy.empty)}</span>
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
  const tr = useT();
  return (
    <div className="inbox-grid">
      <section className="stack" style={{ gap: 12 }}>
        {data.roles.length === 0 && (
          <div className="notice info">
            <IconLock size={16} />
            <span>{tr("You have no reviewer or approver role yet, so nothing is assigned to you.")}{isAdmin ? (
                <>
                  {" "}{tr("Grant roles in")}{" "}<Link href={`/app/${org}/admin#roles`}>{tr("Governance → Roles")}</Link>.
                </>
              ) : (
                tr(" Ask an admin to grant one.")
              )}
            </span>
          </div>
        )}
        {data.approvals.length === 0 && (
          <div className="card empty">
            <StateIllustration kind="inbox" />
            <strong>{tr("Nothing waiting for you")}</strong>
            <span>
              {data.roles.length > 0
                ? tr("New reviews for {v1} will show up here.", { v1: data.roles.map((r) => ROLE_COPY[r]?.toLowerCase() ?? r).join(", ") })
                : tr("Reviews and approvals assigned to your roles will show up here.")}
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
                  {a.workflow_name}{" "}{tr("· started by")}{" "}{a.initiated_by_email ?? "—"} · {ago(a.created_at)}
                </small>
              </span>
              <span className="badge">{tr(ROLE_COPY[a.assigned_role])}</span>
            </header>
            <div className="row" style={{ gap: 8, fontSize: 13, color: "var(--muted)" }}>
              <IconHourglass size={13} />{tr("Decide by")}{" "}{when(a.expires_at)}{" "}{tr("· covers")}{" "}{a.documents} {a.documents === 1 ? "document" : "documents"}
            </div>
            {a.invalidated && (
              <div className="alert">
                <IconAlert size={16} />{tr("A document changed after this was requested. Deciding now will cancel the approval and stop the workflow.")}</div>
            )}
            {a.blocked_by_sod && (
              <div className="notice">
                <IconLock size={16} />{tr("You started this workflow, so someone else has to decide.")}</div>
            )}
            <div className="actions">
              <Link href={`/app/${org}/activity/${a.run_id}`} className={a.blocked_by_sod ? "btn-link ghost" : "btn-link"}>
                {a.blocked_by_sod ? tr("View details") : tr("Review and decide")}
                <IconArrowRight size={14} />
              </Link>
            </div>
          </article>
        ))}
      </section>

      <aside className="card ed-section">
        <header>
          <h2>{tr("Your workflows")}</h2>
        </header>
        {data.my_runs.length === 0 ? (
          <p className="muted" style={{ fontSize: 13 }}>{tr("Workflows you start that are waiting, running or recently stopped show up here.")}</p>
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

/* ───────────── Deadlines (ADR-038): mine due within two working days or overdue, and proposals to confirm ───────────── */

function DeadlineInbox({ org }: { org: string }) {
  const tr = useT();
  const [due, setDue] = useState<Deadline[] | null>(null);
  const [proposed, setProposed] = useState<Candidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    // Same rule as the Inbox count (deadlineAttention in the API): yours, pending, overdue or due within two working days.
    api<DeadlineList>(`organizations/${org}/deadlines?view=open&mine=1`)
      .then((r) => setDue(r.deadlines.filter((d) => d.state === "overdue" || d.state === "today" || (d.days_left !== null && d.days_left <= 2))))
      .catch((e: Error) => setError(e.message));
    api<{ candidates: Candidate[] }>(`organizations/${org}/deadline-candidates`)
      .then((r) => setProposed(r.candidates.filter((c) => c.can_confirm)))
      .catch((e: Error) => setError(e.message));
  }, [org]);
  useEffect(() => {
    load();
    window.addEventListener("ragsis:inbox", load);
    return () => window.removeEventListener("ragsis:inbox", load);
  }, [load]);

  if (error)
    return (
      <div className="alert" role="alert">
        <IconAlert size={16} />
        {error}
      </div>
    );
  if (!due || !proposed) return <InboxSkeleton />;
  if (!due.length && !proposed.length) {
    return (
      <div className="card empty">
        <StateIllustration kind="inbox" />
        <strong>{tr("Nothing waiting for you")}</strong>
        <span>{tr("Your deadlines due within two working days, overdue ones and terms Ragis proposes from court documents show up here.")}</span>
        <Link href={`/app/${org}/terminos`} className="btn-link">
          {tr("Open Deadlines")}
          <IconArrowRight size={14} />
        </Link>
      </div>
    );
  }
  return (
    <div className="stack" style={{ gap: 16 }}>
      {due.length > 0 && (
        <section className="card dl-candidates" aria-labelledby="inbox-due">
          <header>
            <h2 id="inbox-due">
              {tr("Your deadlines coming due")}
              <span className="count">{due.length}</span>
            </h2>
            <p className="muted">{tr("Overdue or due within two working days.")}</p>
          </header>
          <ul>
            {due.map((d) => (
              <li key={d.id} className="dl-cand">
                <div className="dl-cand-term">
                  <Link href={`/app/${org}/terminos?d=${d.id}`}>
                    <strong>{d.title}</strong>
                  </Link>
                  <StandingBadge state={d.state} daysLeft={d.days_left} />
                </div>
                <div className="dl-cand-meta">
                  <span>{tr("Due {date}", { date: longDate(d.due_on) })}</span>
                  <span>· {d.workspace_name}</span>
                  {d.document_title && (
                    <span className="dl-doc">
                      · <IconFile size={12} />
                      {d.document_title}
                      {d.page ? ` · ${tr("p. {page}", { page: d.page })}` : ""}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {proposed.length > 0 && (
        <section className="card dl-candidates" aria-labelledby="inbox-proposed">
          <header>
            <h2 id="inbox-proposed">
              {tr("Waiting for confirmation")}
              <span className="count">{proposed.length}</span>
            </h2>
            <p className="muted">{tr("Terms Ragis found in court documents. None counts as a deadline until someone confirms it with the date it runs from.")}</p>
          </header>
          <ul>
            {proposed.map((c) => (
              <li key={c.id} className="dl-cand">
                <blockquote>«{c.quote}»</blockquote>
                <div className="dl-cand-meta">
                  <span className="dl-doc">
                    <IconFile size={12} />
                    {c.document_title}
                    {c.page ? ` · ${tr("page {page}", { page: c.page })}` : ""}
                  </span>
                  <span>· {c.workspace_name}</span>
                </div>
                <div className="dl-cand-actions">
                  <Link href={`/app/${org}/terminos?c=${c.id}`} className="btn-link">
                    {tr("Review and confirm")}
                    <IconArrowRight size={14} />
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      <Link href={`/app/${org}/terminos`} className="btn-link ghost" style={{ alignSelf: "flex-start" }}>
        {tr("Open Deadlines")}
        <IconArrowRight size={14} />
      </Link>
    </div>
  );
}
