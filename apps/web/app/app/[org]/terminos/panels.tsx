"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { useT } from "@/lib/use-t";
import { Sheet } from "@/components/Sheet";
import { Skel, SkeletonStatus } from "@/components/skeletons";
import { Avatar, Select, useConfirm } from "@/components/ui";
import { StateIllustration } from "@/components/AppState";
import { IconAlert, IconCalendar, IconCheck, IconDownload, IconEdit, IconFile, IconRefresh, IconX } from "@/components/icons";
import { ago, when } from "../workflows/shared";
import { TermForm, termBody, termProblem, type TermValues } from "./TermForm";
import {
  ComputationView,
  StandingBadge,
  TRIGGER_KINDS,
  longDate,
  personName,
  termSummary,
  triggerWord,
  type Candidate,
  type Deadline,
  type Person,
  type TriggerKind,
} from "./shared";

export interface PeopleDir {
  people: Person[];
  me: string;
}

/** The literal sentence a deadline or candidate comes from, with its page; opens the document at that page. */
export function SourceQuote({ title, page, quote, onOpen }: { title: string | null; page: number | null; quote: string | null; onOpen?: () => void }) {
  const t = useT();
  if (!quote && !title) return null;
  return (
    <figure className="dl-quote">
      {quote && <blockquote>«{quote}»</blockquote>}
      <figcaption>
        <IconFile size={13} />
        {onOpen ? (
          <button type="button" className="link" onClick={onOpen}>
            {title ?? t("Document")}
            {page ? ` · ${t("page {page}", { page })}` : ""}
          </button>
        ) : (
          <span>
            {title ?? t("Document")}
            {page ? ` · ${t("page {page}", { page })}` : ""}
          </span>
        )}
      </figcaption>
    </figure>
  );
}

const toValues = (d: Deadline): TermValues => ({
  title: d.title,
  trigger_kind: d.trigger_kind,
  trigger_date: d.trigger_date,
  notice_by_email: d.notice_by_email,
  unit: d.unit,
  amount: d.amount ? String(d.amount) : "",
  legal_basis: d.legal_basis,
  responsible_id: d.responsible_id,
});

interface DeadlineEvent {
  id: string;
  kind: "confirmed" | "updated" | "done" | "reopened" | "cancelled" | "recomputed";
  data: Record<string, unknown>;
  created_at: string;
  actor_email: string | null;
  actor_name: string | null;
}
interface DeadlineDetail extends Deadline {
  events: DeadlineEvent[];
  reminders: { kind: string; due_on: string; recipient: string; sent_at: string }[];
  reminders_enabled: boolean;
}

const FIELD_COPY: Record<string, string> = {
  title: "title",
  trigger_kind: "event it runs from",
  trigger_date: "date",
  notice_by_email: "email notice",
  unit: "unit",
  amount: "amount",
  legal_basis: "legal basis",
  responsible_id: "responsible",
  due_on: "due date",
  notes: "notes",
};
const REMINDER_COPY: Record<string, string> = { week: "a week before", two_days: "two working days before", due: "on the day", overdue: "overdue" };

/** One deadline over the list: its term and breakdown, who has it, the source, the history; edit, reassign, close. */
export function DeadlinePanel({
  org,
  id,
  dir,
  country,
  onClose,
  onChanged,
  onOpenSource,
}: {
  org: string;
  id: string;
  dir: PeopleDir | null;
  country: string;
  onClose: () => void;
  onChanged: () => void;
  onOpenSource: (s: { documentId: string; versionId: string | null; title: string; page: number | null }) => void;
}) {
  const t = useT();
  const confirm = useConfirm();
  const [d, setD] = useState<DeadlineDetail | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<TermValues | null>(null);

  const load = useCallback(() => {
    api<DeadlineDetail>(`organizations/${org}/deadlines/${id}`)
      .then((r) => {
        setD(r);
        setError(null);
      })
      .catch((e: Error) => setError(e));
  }, [org, id]);
  useEffect(() => {
    setD(null);
    setEditing(null);
    setActionError(null);
    load();
  }, [load]);

  const patch = async (body: Record<string, unknown>, tag: string) => {
    setBusy(tag);
    setActionError(null);
    try {
      await api(`organizations/${org}/deadlines/${id}`, { method: "PATCH", body });
      window.dispatchEvent(new Event("ragsis:inbox"));
      onChanged();
      load();
      return true;
    } catch (e) {
      setActionError((e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!editing) return;
    const problem = termProblem(editing);
    if (problem) return setActionError(t(problem));
    const b = termBody(editing);
    if (await patch(b, "save")) setEditing(null);
  };

  const people = dir?.people ?? [];
  const pending = d?.status === "pending";
  const nameOf = (uid: unknown) => {
    const p = people.find((x) => x.id === uid);
    return p ? personName(p) : t("a former member");
  };
  const fieldValue = (k: string, v: unknown) =>
    k === "responsible_id" ? nameOf(v) : k === "trigger_kind" ? triggerWord(String(v)) : k === "trigger_date" || k === "due_on" ? longDate(String(v)) : typeof v === "boolean" ? (v ? t("yes") : t("no")) : String(v ?? "—");

  return (
    <Sheet label={d ? t("Deadline: {title}", { title: d.title }) : t("Deadline")} onClose={onClose}>
      {(close) => (
        <>
          <header className="sheet-head">
            <div className="row">
              {d ? <StandingBadge state={d.state} daysLeft={d.days_left} /> : <span className="req-num">{t("Deadline")}</span>}
              <button type="button" className="quiet sheet-close" aria-label={t("Close")} onClick={close}>
                <IconX size={16} />
              </button>
            </div>
            {d && (
              <>
                <h2>{d.title}</h2>
                <div className="sheet-meta">
                  <IconCalendar size={13} />
                  <span>{t("Due {date}", { date: longDate(d.due_on) })}</span>
                  <span>· {d.workspace_name}</span>
                </div>
              </>
            )}
          </header>

          <div className="sheet-body">
            {error ? (
              <div className="card empty">
                <StateIllustration kind={error instanceof ApiError && error.status === 404 ? "notFound" : "server"} />
                <strong>{error instanceof ApiError && error.status === 404 ? t("This deadline isn't available") : t("Couldn't load this deadline")}</strong>
                <span>{error instanceof ApiError && error.status === 404 ? t("It doesn't exist, or you are not in its space and not responsible for it.") : error.message}</span>
              </div>
            ) : !d ? (
              <SkeletonStatus label={t("Loading deadline…")}>
                <div className="stack" aria-hidden="true">
                  <Skel w="70%" h={26} />
                  <Skel h={120} r={14} />
                  <Skel h={160} r={14} />
                </div>
              </SkeletonStatus>
            ) : (
              <>
                {actionError && (
                  <div className="alert" role="alert">
                    <IconAlert size={16} />
                    {actionError}
                  </div>
                )}

                {d.can_edit && !editing && (
                  <div className="move-actions" role="group" aria-label={t("Actions")}>
                    {pending ? (
                      <button type="button" className="primary" disabled={!!busy} aria-busy={busy === "done"} onClick={() => void patch({ status: "done" }, "done")}>
                        <IconCheck size={15} />
                        {t("Mark as met")}
                      </button>
                    ) : (
                      <button type="button" className="ghost" disabled={!!busy} aria-busy={busy === "reopen"} onClick={() => void patch({ status: "pending" }, "reopen")}>
                        <IconRefresh size={15} />
                        {t("Reopen")}
                      </button>
                    )}
                    {pending && (
                      <button type="button" className="ghost" disabled={!!busy} onClick={() => setEditing(toValues(d))}>
                        <IconEdit size={15} />
                        {t("Edit term")}
                      </button>
                    )}
                    <a className="btn-link ghost" href={`/api/proxy/organizations/${org}/deadlines/${d.id}/calendar.ics`} download>
                      <IconDownload size={15} />
                      {t("Add to calendar (.ics)")}
                    </a>
                    {pending && (
                      <button
                        type="button"
                        className="quiet end"
                        disabled={!!busy}
                        onClick={async () => {
                          if (await confirm({ title: t("Cancel this deadline?"), body: t("Use it when the term no longer applies (the hearing was called off, the claim was withdrawn). It stays in the history and can be reopened."), confirmLabel: t("Cancel deadline"), cancelLabel: t("Keep it"), tone: "danger" }))
                            void patch({ status: "cancelled" }, "cancel");
                        }}
                      >
                        {t("Cancel deadline")}
                      </button>
                    )}
                  </div>
                )}
                {!d.can_edit && (
                  <div className="notice info">
                    <IconAlert size={16} />
                    <span>{t("Only the person responsible or an editor of {space} can change this deadline.", { space: d.workspace_name })}</span>
                  </div>
                )}

                {editing ? (
                  <section className="card dl-edit">
                    <TermForm org={org} value={editing} onChange={setEditing} people={people} me={dir?.me ?? ""} country={country} />
                    <div className="dl-edit-actions">
                      <button type="button" className="ghost" onClick={() => setEditing(null)} disabled={busy === "save"}>
                        {t("Cancel")}
                      </button>
                      <button type="button" className="primary" onClick={() => void save()} disabled={busy === "save"} aria-busy={busy === "save"}>
                        {t("Save changes")}
                      </button>
                    </div>
                  </section>
                ) : (
                  <>
                    <dl className="req-facts">
                      <dt>{t("Term")}</dt>
                      <dd>{termSummary(d)}</dd>
                      <dt>{t("Responsible")}</dt>
                      <dd>
                        {d.can_edit && pending ? (
                          <Select
                            size="sm"
                            ariaLabel={t("Responsible")}
                            value={d.responsible_id}
                            onChange={(v) => v !== d.responsible_id && void patch({ responsible_id: v }, "assign")}
                            options={people.map((p) => ({ value: p.id, label: p.id === dir?.me ? t("{name} (you)", { name: personName(p) }) : personName(p) }))}
                          />
                        ) : (
                          <>
                            <Avatar name={personName({ display_name: d.responsible_name, email: d.responsible_email })} size="sm" />
                            <span className="ellipsis">{personName({ display_name: d.responsible_name, email: d.responsible_email })}</span>
                          </>
                        )}
                      </dd>
                      {d.legal_basis && (
                        <>
                          <dt>{t("Legal basis")}</dt>
                          <dd>{d.legal_basis}</dd>
                        </>
                      )}
                      <dt>{t("Space")}</dt>
                      <dd>{d.workspace_name}</dd>
                      <dt>{t("Confirmed by")}</dt>
                      <dd>
                        {personName({ display_name: d.confirmed_by_name, email: d.confirmed_by_email })}
                        {d.confirmed_at ? <span className="muted"> · {ago(d.confirmed_at)}</span> : null}
                      </dd>
                    </dl>

                    <section aria-label={t("How the due date was computed")}>
                      <h3 className="sheet-section">{t("How the due date was computed")}</h3>
                      <ComputationView c={d.computation} unit={d.unit} org={org} country={country} />
                    </section>
                  </>
                )}

                {(d.quote || d.document_title) && (
                  <section aria-label={t("Source")}>
                    <h3 className="sheet-section">{t("Source")}</h3>
                    <SourceQuote
                      title={d.document_title}
                      page={d.page}
                      quote={d.quote}
                      onOpen={d.document_id ? () => onOpenSource({ documentId: d.document_id!, versionId: d.version_id, title: d.document_title ?? "", page: d.page }) : undefined}
                    />
                  </section>
                )}

                {d.notes && <p className="req-body">{d.notes}</p>}

                <section aria-label={t("History")}>
                  <h3 className="sheet-section">{t("History")}</h3>
                  <ol className="req-tl">
                    {d.events.map((e) => {
                      const who = e.actor_name || e.actor_email || t("Ragis");
                      const changes = e.kind === "updated" ? Object.entries(e.data) : [];
                      return (
                        <li key={e.id} className="system">
                          <span className="sys-dot" aria-hidden="true">
                            {e.kind === "done" ? <IconCheck size={14} /> : e.kind === "recomputed" ? <IconRefresh size={14} /> : <IconEdit size={14} />}
                          </span>
                          <span className="text">
                            {e.kind === "confirmed" && t("{who} confirmed it, due {date}", { who, date: longDate(String(e.data.due_on)) })}
                            {e.kind === "done" && t("{who} marked it as done", { who })}
                            {e.kind === "cancelled" && t("{who} cancelled it", { who })}
                            {e.kind === "reopened" && t("{who} reopened it", { who })}
                            {e.kind === "recomputed" &&
                              t("The calendar changed ({reason}): due date moved from {from} to {to}", { reason: String(e.data.reason ?? ""), from: longDate(String(e.data.from)), to: longDate(String(e.data.to)) })}
                            {e.kind === "updated" && (
                              <>
                                {t("{who} changed", { who })}{" "}
                                {changes.map(([k, v], i) => (
                                  <span key={k}>
                                    {i > 0 ? ", " : ""}
                                    <strong>{t(FIELD_COPY[k] ?? k)}</strong>
                                    {Array.isArray(v) ? ` (${fieldValue(k, v[0])} → ${fieldValue(k, v[1])})` : ""}
                                  </span>
                                ))}
                              </>
                            )}{" "}
                            <time dateTime={e.created_at} title={when(e.created_at)}>
                              · {ago(e.created_at)}
                            </time>
                          </span>
                        </li>
                      );
                    })}
                    {d.reminders.map((r) => (
                      <li key={`${r.kind}-${r.sent_at}`} className="system">
                        <span className="sys-dot" aria-hidden="true">
                          <IconCalendar size={14} />
                        </span>
                        <span className="text">
                          {t("Reminder sent to {to} ({kind})", { to: r.recipient, kind: t(REMINDER_COPY[r.kind] ?? r.kind) })}{" "}
                          <time dateTime={r.sent_at}>· {ago(r.sent_at)}</time>
                        </span>
                      </li>
                    ))}
                  </ol>
                  {!d.reminders_enabled && <p className="muted sheet-privacy">{t("Email reminders are off in this installation (they need the same SES sender as signatures).")}</p>}
                </section>
              </>
            )}
          </div>
        </>
      )}
    </Sheet>
  );
}

/** A candidate the detector found: the literal sentence, and the form a person fills to turn it into a deadline. */
export function ConfirmPanel({
  org,
  c,
  dir,
  country,
  onClose,
  onDone,
  onOpenSource,
}: {
  org: string;
  c: Candidate;
  dir: PeopleDir | null;
  country: string;
  onClose: () => void;
  onDone: (result: { kind: "confirmed"; id: string } | { kind: "dismissed" }) => void;
  onOpenSource: (s: { documentId: string; versionId: string | null; title: string; page: number | null }) => void;
}) {
  const t = useT();
  const [v, setV] = useState<TermValues>(() => ({
    title: c.title,
    trigger_kind: (TRIGGER_KINDS as string[]).includes(c.trigger_hint) ? (c.trigger_hint as TriggerKind) : "notification",
    trigger_date: c.trigger_date ?? "",
    notice_by_email: false,
    unit: c.unit,
    amount: c.amount ? String(c.amount) : "",
    legal_basis: c.legal_basis,
    responsible_id: dir?.me ?? "",
  }));
  useEffect(() => {
    if (dir?.me) setV((cur) => (cur.responsible_id ? cur : { ...cur, responsible_id: dir.me }));
  }, [dir?.me]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (close: () => void) => {
    const problem = termProblem(v);
    if (problem) return setError(t(problem));
    setBusy("confirm");
    setError(null);
    try {
      const d = await api<Deadline>(`organizations/${org}/deadlines`, { method: "POST", body: { candidate_id: c.id, ...termBody(v) } });
      window.dispatchEvent(new Event("ragsis:inbox"));
      onDone({ kind: "confirmed", id: d.id });
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const dismiss = async (close: () => void) => {
    setBusy("dismiss");
    setError(null);
    try {
      await api(`organizations/${org}/deadline-candidates/${c.id}/dismiss`, { method: "POST", body: {} });
      window.dispatchEvent(new Event("ragsis:inbox"));
      onDone({ kind: "dismissed" });
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Sheet label={t("Confirm deadline: {title}", { title: c.title })} onClose={onClose}>
      {(close) => (
        <>
          <header className="sheet-head">
            <div className="row">
              <span className="badge accent">{t("Proposed by Ragis")}</span>
              <button type="button" className="quiet sheet-close" aria-label={t("Close")} onClick={close}>
                <IconX size={16} />
              </button>
            </div>
            <h2>{t("Confirm deadline")}</h2>
            <div className="sheet-meta">
              <span>{c.workspace_name}</span>
              <span>· {ago(c.created_at)}</span>
            </div>
          </header>
          <div className="sheet-body">
            <SourceQuote title={c.document_title} page={c.page} quote={c.quote} onOpen={() => onOpenSource({ documentId: c.document_id, versionId: c.version_id, title: c.document_title, page: c.page })} />
            <p className="muted dl-hint">{t("Nothing becomes a deadline until you confirm it. Check the date it runs from: Ragis can't know when you were notified.")}</p>
            {error && (
              <div className="alert" role="alert">
                <IconAlert size={16} />
                {error}
              </div>
            )}
            <TermForm org={org} value={v} onChange={setV} people={dir?.people ?? []} me={dir?.me ?? ""} unitAssumed={c.unit_assumed} country={country} />
          </div>
          <div className="sheet-foot dl-foot">
            <button type="button" className="quiet" disabled={!!busy} aria-busy={busy === "dismiss"} onClick={() => void dismiss(close)}>
              {t("Dismiss")}
            </button>
            <button type="button" className="primary" disabled={!!busy || !c.can_confirm} aria-busy={busy === "confirm"} onClick={() => void submit(close)}>
              <IconCheck size={15} />
              {t("Confirm deadline")}
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}
