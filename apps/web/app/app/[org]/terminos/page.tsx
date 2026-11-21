"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useT } from "@/lib/use-t";
import { useOrg } from "../layout";
import { PageBreadcrumbs } from "@/components/PageBreadcrumbs";
import { DocViewer, type ViewerDoc } from "@/components/DocViewer";
import { StateIllustration } from "@/components/AppState";
import { Checkbox, SoftText, Toast } from "@/components/motion";
import { Avatar, useConfirm } from "@/components/ui";
import { Skel, SkeletonStatus } from "@/components/skeletons";
import { IconAlert, IconArrowRight, IconCalendar, IconDownload, IconFile, IconHourglass, IconLock } from "@/components/icons";
import { ago } from "../workflows/shared";
import { CalendarAdmin } from "./CalendarAdmin";
import { ConfirmPanel, DeadlinePanel, type PeopleDir } from "./panels";
import { StandingBadge, UNIT_COPY, longDate, personName, type Candidate, type Deadline, type DeadlineList, type View } from "./shared";
import "./terminos.css";

const VIEWS: { key: View; label: string; empty: string }[] = [
  { key: "overdue", label: "Overdue", empty: "Nothing is overdue." },
  { key: "week", label: "Next 7 days", empty: "Nothing is due in the next 7 days." },
  { key: "month", label: "Next 30 days", empty: "Nothing is due in the next 30 days." },
  { key: "open", label: "All open", empty: "There are no open deadlines. Confirm the ones Ragis proposes, or they appear here once confirmed." },
  { key: "done", label: "Met or withdrawn", empty: "Deadlines marked as done or cancelled show up here." },
];
const isView = (v: string | null): v is View => VIEWS.some((x) => x.key === v);

export default function DeadlinesPage() {
  return (
    <Suspense>
      <DeadlinesScreen />
    </Suspense>
  );
}

function DeadlinesScreen() {
  const t = useT();
  const confirm = useConfirm();
  const { org } = useParams<{ org: string }>();
  const router = useRouter();
  const search = useSearchParams();
  const { org: orgInfo } = useOrg();
  const isAdmin = orgInfo?.role === "owner" || orgInfo?.role === "admin";

  const viewParam = search.get("view");
  const openId = search.get("d");
  const mine = search.get("mine") === "1";
  const [data, setData] = useState<DeadlineList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [dir, setDir] = useState<PeopleDir | null>(null);
  const [confirming, setConfirming] = useState<Candidate | null>(null);
  const [viewing, setViewing] = useState<ViewerDoc | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // The detail sheet is a portal into document.body: open it only in the browser, also when ?d= comes in the URL.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Default tab: the most urgent one that has something, so the first screen is never an empty "Overdue".
  const [fallbackView, setFallbackView] = useState<View>("week");
  const view: View = isView(viewParam) ? viewParam : fallbackView;

  const go = useCallback(
    (patch: Record<string, string | null>) => {
      const q = new URLSearchParams(search.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) q.delete(k);
        else q.set(k, v);
      }
      const s = q.toString();
      router.replace(`/app/${org}/terminos${s ? `?${s}` : ""}`, { scroll: false });
    },
    [router, org, search],
  );

  const load = useCallback(() => {
    setError(null);
    api<DeadlineList>(`organizations/${org}/deadlines?view=${view}${mine ? "&mine=1" : ""}`)
      .then((r) => {
        setData(r);
        if (!isView(viewParam)) setFallbackView(r.counts.overdue ? "overdue" : r.counts.week ? "week" : r.counts.month ? "month" : "open");
      })
      .catch((e: Error) => setError(e.message));
  }, [org, view, mine, viewParam]);
  const loadCandidates = useCallback(() => {
    api<{ candidates: Candidate[] }>(`organizations/${org}/deadline-candidates`)
      .then((r) => setCandidates(r.candidates))
      .catch(() => setCandidates([]));
  }, [org]);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    loadCandidates();
    api<PeopleDir>(`organizations/${org}/deadline-people`)
      .then(setDir)
      .catch(() => setDir({ people: [], me: "" }));
  }, [org, loadCandidates]);

  // ?c=<candidate> (from the Inbox) opens that proposal's confirm form once the list has it.
  const candidateParam = search.get("c");
  useEffect(() => {
    if (!candidateParam || !candidates) return;
    const c = candidates.find((x) => x.id === candidateParam);
    if (c?.can_confirm) setConfirming(c);
    go({ c: null });
  }, [candidateParam, candidates, go]);

  const refresh = () => {
    load();
    loadCandidates();
  };

  const openSource = useCallback(
    async (s: { documentId: string; versionId: string | null; title: string; page: number | null }) => {
      try {
        const r = await api<{ document: { title: string; current_version_id: string }; versions: { id: string; filename: string }[] }>(
          `organizations/${org}/documents/${s.documentId}/status`,
        );
        const v = r.versions.find((x) => x.id === s.versionId) ?? r.versions.find((x) => x.id === r.document.current_version_id) ?? r.versions[0];
        if (!v) throw new Error(t("This document has no version you can open."));
        setViewing({ documentId: s.documentId, versionId: v.id, title: s.title || r.document.title, filename: v.filename, page: s.page ?? undefined });
      } catch (e) {
        setToast((e as Error).message);
      }
    },
    [org, t],
  );

  const quickDismiss = async (c: Candidate) => {
    const ok = await confirm({
      title: t("Dismiss this proposal?"),
      body: t("It won't become a deadline and leaves this list. The sentence stays in the document."),
      confirmLabel: t("Dismiss"),
    });
    if (!ok) return;
    setBusy(c.id);
    try {
      await api(`organizations/${org}/deadline-candidates/${c.id}/dismiss`, { method: "POST", body: {} });
      window.dispatchEvent(new Event("ragsis:inbox"));
      setToast(t("Proposal dismissed"));
      refresh();
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const counts = data?.counts;
  const countOf = (v: View) => (v === "done" || !counts ? 0 : counts[v]);
  const viewCopy = VIEWS.find((v) => v.key === view)!;
  const proposed = candidates ?? [];
  const icsHref = `/api/proxy/organizations/${org}/deadlines/calendar.ics${mine ? "?mine=1" : ""}`;

  const onTabKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const i = VIEWS.findIndex((v) => v.key === view);
    const next = VIEWS[(i + (e.key === "ArrowRight" ? 1 : VIEWS.length - 1)) % VIEWS.length].key;
    go({ view: next });
    document.getElementById(`dl-tab-${next}`)?.focus();
  };

  return (
    <div className="page">
      <header className="page-bar">
        <PageBreadcrumbs section={t("Deadlines")} context={orgInfo?.name} icon={IconHourglass} />
      </header>
      <div className="main">
        <header className="page-head" style={{ marginBottom: 20 }}>
          <div>
            <h1>{t("Deadlines")}</h1>
            <p className="sub">{t("Procedural terms of the firm, computed with its calendar of holidays and court closures. Ragis proposes them from court documents; a person confirms each one.")}</p>
          </div>
          <div className="actions row">
            <a className="btn-link ghost" href={icsHref} download>
              <IconDownload size={15} />
              {mine ? t("My calendar (.ics)") : t("Whole calendar (.ics)")}
            </a>
          </div>
        </header>

        {proposed.length > 0 && (
          <section className="card dl-candidates" aria-labelledby="dl-cand-title">
            <header>
              <h2 id="dl-cand-title">
                {t("Waiting for confirmation")}
                <span className="count">{proposed.length}</span>
              </h2>
              <p className="muted">{t("Terms Ragis found in court documents. None counts as a deadline until someone confirms it with the date it runs from.")}</p>
            </header>
            <ul>
              {proposed.map((c) => (
                <li key={c.id} className="dl-cand">
                  <blockquote>«{c.quote}»</blockquote>
                  <div className="dl-cand-meta">
                    <button type="button" className="link subtle" onClick={() => void openSource({ documentId: c.document_id, versionId: c.version_id, title: c.document_title, page: c.page })}>
                      <IconFile size={13} />
                      {c.document_title}
                      {c.page ? ` · ${t("page {page}", { page: c.page })}` : ""}
                    </button>
                    <span>· {c.workspace_name}</span>
                    <span>· {ago(c.created_at)}</span>
                  </div>
                  <div className="dl-cand-term">
                    <strong>{c.title}</strong>
                    <span className="chip-static">
                      {c.unit === "fixed" ? (c.trigger_date ? t("Fixed date: {date}", { date: longDate(c.trigger_date) }) : t("Fixed date")) : `${c.amount ?? "?"} ${t(UNIT_COPY[c.unit])}`}
                    </span>
                    {c.unit_assumed && <span className="badge warn">{t("working days assumed")}</span>}
                    {c.legal_basis && <span className="muted">{c.legal_basis}</span>}
                  </div>
                  <div className="dl-cand-actions">
                    {c.can_confirm ? (
                      <>
                        <button type="button" className="primary small" onClick={() => setConfirming(c)}>
                          {t("Review and confirm")}
                          <IconArrowRight size={14} />
                        </button>
                        <button type="button" className="quiet small" disabled={busy === c.id} aria-busy={busy === c.id} onClick={() => void quickDismiss(c)}>
                          {t("Dismiss")}
                        </button>
                      </>
                    ) : (
                      <span className="muted dl-locked">
                        <IconLock size={13} />
                        {t("Only editors of {space} can confirm it.", { space: c.workspace_name })}
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        <div className="dl-toolbar">
          <div className="tabs" role="tablist" aria-label={t("Deadlines")} onKeyDown={onTabKey}>
            {VIEWS.map((v) => (
              <button
                key={v.key}
                type="button"
                role="tab"
                id={`dl-tab-${v.key}`}
                aria-selected={view === v.key}
                aria-controls="dl-panel"
                tabIndex={view === v.key ? 0 : -1}
                className={v.key === "overdue" && countOf("overdue") ? "has-overdue" : undefined}
                onClick={() => go({ view: v.key, d: null })}
              >
                {t(v.label)}
                {!!countOf(v.key) && (
                  <span className="count">
                    <SoftText text={String(countOf(v.key))} />
                  </span>
                )}
              </button>
            ))}
          </div>
          <Checkbox checked={mine} onChange={(on) => go({ mine: on ? "1" : null })} label={t("Only mine")} />
        </div>

        {error && (
          <div className="alert" role="alert" style={{ marginTop: 16 }}>
            <IconAlert size={16} />
            {error}
          </div>
        )}

        <section id="dl-panel" role="tabpanel" aria-labelledby={`dl-tab-${view}`} className="dl-panel">
          {!data ? (
            error ? null : (
              <SkeletonStatus label={t("Loading deadlines…")}>
                <div className="card dl-list" aria-hidden="true">
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="dl-row">
                      <span className="dl-main">
                        <Skel w={i % 2 ? "52%" : "38%"} h={14} />
                        <Skel w="30%" h={11} />
                      </span>
                      <span className="dl-cell">
                        <Skel w={90} h={12} />
                      </span>
                      <span className="dl-cell">
                        <Skel w={110} h={22} r={999} />
                      </span>
                      <span className="dl-cell">
                        <Skel w={24} h={24} r={999} />
                      </span>
                    </div>
                  ))}
                </div>
              </SkeletonStatus>
            )
          ) : data.deadlines.length === 0 ? (
            <div className="card empty">
              <StateIllustration kind="inbox" />
              <strong>{mine ? t("Nothing of yours here") : t("Nothing here")}</strong>
              <span>{t(viewCopy.empty)}</span>
            </div>
          ) : (
            <div className="card dl-list">
              {data.deadlines.map((d) => (
                <DeadlineRow key={d.id} d={d} me={dir?.me} onOpen={() => go({ d: d.id })} onSource={openSource} />
              ))}
            </div>
          )}
          {data && !data.reminders_enabled && (
            <p className="muted dl-foot-note">{t("Email reminders are off in this installation; download the calendar to get alerts on your phone.")}</p>
          )}
        </section>

        {isAdmin && <CalendarAdmin org={org} onChanged={(msg) => { setToast(msg); refresh(); }} />}
      </div>

      {mounted && openId && (
        <DeadlinePanel
          org={org}
          id={openId}
          dir={dir}
          country={data?.country ?? "co"}
          onClose={() => go({ d: null })}
          onChanged={refresh}
          onOpenSource={(s) => void openSource(s)}
        />
      )}
      {confirming && (
        <ConfirmPanel
          org={org}
          c={confirming}
          dir={dir}
          country={data?.country ?? "co"}
          onClose={() => setConfirming(null)}
          onOpenSource={(s) => void openSource(s)}
          onDone={(r) => {
            setToast(r.kind === "confirmed" ? t("Deadline confirmed") : t("Proposal dismissed"));
            refresh();
          }}
        />
      )}
      <DocViewer doc={viewing} orgId={org} onClose={() => setViewing(null)} />
      <Toast message={toast} onDone={() => setToast(null)} />
    </div>
  );
}

function DeadlineRow({
  d,
  me,
  onOpen,
  onSource,
}: {
  d: Deadline;
  me?: string;
  onOpen: () => void;
  onSource: (s: { documentId: string; versionId: string | null; title: string; page: number | null }) => void;
}) {
  const t = useT();
  const who = personName({ display_name: d.responsible_name, email: d.responsible_email });
  return (
    <div className={`dl-row${d.state === "overdue" || d.state === "today" ? " urgent" : ""}`}>
      <span className="dl-main">
        <button type="button" className="dl-open" onClick={onOpen}>
          <strong>{d.title}</strong>
        </button>
        <span className="sub">
          <span>{d.workspace_name}</span>
          {d.document_id && d.document_title && (
            <button
              type="button"
              className="link subtle dl-src"
              onClick={() => onSource({ documentId: d.document_id!, versionId: d.version_id, title: d.document_title ?? "", page: d.page })}
            >
              <IconFile size={12} />
              <span className="dl-src-text">
                {d.document_title}
                {d.page ? ` · ${t("p. {page}", { page: d.page })}` : ""}
              </span>
            </button>
          )}
        </span>
      </span>
      <span className="dl-cell dl-date">
        <IconCalendar size={13} />
        {longDate(d.due_on)}
      </span>
      <span className="dl-cell">
        <StandingBadge state={d.state} daysLeft={d.days_left} />
      </span>
      <span className="dl-cell dl-who" data-tip={d.responsible_id === me ? t("You") : who}>
        <Avatar name={who} size="sm" />
        <span className="dl-who-name">{d.responsible_id === me ? t("You") : who}</span>
      </span>
    </div>
  );
}
