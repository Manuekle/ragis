"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { Sheet } from "@/components/Sheet";
import { Skel, SkeletonStatus } from "@/components/skeletons";
import { Avatar, DatePicker, Select, formatDate } from "@/components/ui";
import { StateIllustration } from "@/components/AppState";
import { IconAlert, IconArrowRight, IconCheck, IconComment, IconFlag, IconSend, IconUser, IconX } from "@/components/icons";
import { ago, when } from "../workflows/shared";
import { PersonTeams } from "../team-tags";
import { MOVE_COPY, NOTE_PROMPT, NoteDialog, PRIORITY_COPY, PriorityTag, STATUS_COPY, StatusPill, TeamRoute, DueDate, type Priority, type ReqStatus, type RequestItem } from "./shared";

interface RequestEvent {
  id: string;
  kind: "created" | "comment" | "status" | "assigned" | "priority" | "due";
  body: string;
  data: { from?: string | null; to?: string | null; auto?: boolean; reason?: string };
  created_at: string;
  actor: { id: string; name: string } | null;
}
interface Detail extends RequestItem {
  body: string;
  events: RequestEvent[];
  people: Record<string, string>;
  assignees: { id: string; name: string; email: string; lead: boolean }[];
  viewer_id: string;
}

/**
 * One request, opened over the Inbox: what was asked, who has it, the next step and the conversation.
 * Every change reloads the panel and tells the Inbox (`onChanged`) so the list or board behind it stays current.
 */
export function RequestPanel({ org, id, onClose, onChanged }: { org: string; id: string; onClose: () => void; onChanged: () => void }) {
  const [r, setR] = useState<Detail | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [noteFor, setNoteFor] = useState<ReqStatus | null>(null);

  const load = useCallback(() => {
    api<Detail>(`organizations/${org}/requests/${id}`)
      .then((d) => {
        setR(d);
        setError(null);
      })
      .catch((e: Error) => setError(e));
  }, [org, id]);
  useEffect(() => {
    setR(null);
    setComment("");
    setActionError(null);
    load();
  }, [load]);

  const changed = () => {
    window.dispatchEvent(new Event("ragsis:inbox"));
    onChanged();
    load();
  };

  const patch = async (body: Record<string, unknown>, tag: string) => {
    setBusy(tag);
    setActionError(null);
    try {
      await api(`organizations/${org}/requests/${id}`, { method: "PATCH", body });
      changed();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const send = async () => {
    const text = comment.trim();
    if (!text) return;
    setBusy("comment");
    setActionError(null);
    try {
      await api(`organizations/${org}/requests/${id}/comments`, { method: "POST", body: { body: text } });
      setComment("");
      changed();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const lastAsk = r ? [...r.events].reverse().find((e) => e.kind === "status" && e.data.to === "waiting") : undefined;
  const closed = !!r?.closed_at;
  // The step that usually comes next gets the primary button: start a new request, finish one in progress, reopen a
  // closed one. Declining or cancelling is never the suggestion.
  const moves = r?.my.transitions ?? [];
  const nextStep = (r?.status === "open" ? ["in_progress", "done"] : closed ? ["open", "in_progress"] : ["done"]).find((s) => moves.includes(s as ReqStatus));
  const waitingOnMe = r?.status === "waiting" && r.my.requester && !r.my.receiver;

  return (
    <Sheet label={r ? `Request #${r.number}: ${r.title}` : "Request"} onClose={onClose}>
      {(close) => (
      <>
      <header className="sheet-head">
        <div className="row">
          {r ? (
            <>
              <span className="req-num">#{r.number}</span>
              <StatusPill status={r.status} />
              <PriorityTag priority={r.priority} />
              <DueDate iso={r.due_on} closed={closed} />
            </>
          ) : (
            <span className="req-num">Request</span>
          )}
          <button type="button" className="quiet sheet-close" aria-label="Close" onClick={close}>
            <IconX size={16} />
          </button>
        </div>
        {r && (
          <>
            <h2>{r.title}</h2>
            <div className="sheet-meta">
              <TeamRoute r={r} />
              <span>· {ago(r.created_at)}</span>
            </div>
          </>
        )}
      </header>

      <div className="sheet-body">
        {error ? (
          <div className="card empty">
            <StateIllustration kind={error instanceof ApiError && error.status === 404 ? "notFound" : "server"} />
            <strong>{error instanceof ApiError && error.status === 404 ? "This request isn't available" : "Couldn't load this request"}</strong>
            <span>
              {error instanceof ApiError && error.status === 404
                ? "It doesn't exist, or you are no longer one of the people involved."
                : error.message}
            </span>
            {!(error instanceof ApiError && error.status === 404) && (
              <button type="button" className="ghost" onClick={load}>
                Try again
              </button>
            )}
          </div>
        ) : !r ? (
          <SkeletonStatus label="Loading request…">
            <div className="stack" aria-hidden="true">
              <Skel w="70%" h={26} />
              <Skel w="45%" h={14} />
              <Skel h={120} r={14} />
              <Skel h={160} r={14} />
            </div>
          </SkeletonStatus>
        ) : (
          <>
            {waitingOnMe && (
              <div className="waiting-note" role="status">
                <IconAlert size={16} />
                <div>
                  <strong>{r.to_team.name} needs something from you</strong>
                  {lastAsk?.body && <p>“{lastAsk.body}”</p>}
                  <p>Reply below and the request goes back to them.</p>
                </div>
              </div>
            )}
            {actionError && (
              <div className="alert" role="alert">
                <IconAlert size={16} />
                {actionError}
              </div>
            )}

            {r.my.transitions.length > 0 && (
              <div className="move-actions" role="group" aria-label="Move it forward">
                {r.my.transitions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    // Stepping back (decline, cancel) sits apart at the end, quieter than moving forward.
                    className={s === nextStep ? "primary" : s === "declined" || s === "cancelled" ? "quiet end" : "ghost"}
                    disabled={!!busy}
                    aria-busy={busy === s}
                    onClick={() => (NOTE_PROMPT[s] ? setNoteFor(s) : void patch({ status: s }, s))}
                  >
                    {s === "done" ? <IconCheck size={15} /> : s === "waiting" ? <IconComment size={15} /> : s === "in_progress" ? <IconArrowRight size={15} /> : <IconFlag size={15} />}
                    {closed && s === "open" ? "Reopen" : closed && s === "in_progress" ? "Reopen and keep working" : MOVE_COPY[s]}
                  </button>
                ))}
              </div>
            )}

            <dl className="req-facts">
              <dt>Asked by</dt>
              <dd>
                <Avatar name={r.requester.name} size="sm" />
                <span className="ellipsis">{r.my.requester ? "You" : r.requester.name}</span>
                <PersonTeams userId={r.requester.id} />
              </dd>
              <dt>Assigned</dt>
              <dd>
                {r.my.can_assign ? (
                  <>
                    <Select
                      size="sm"
                      ariaLabel="Assigned to"
                      value={r.assignee?.id ?? ""}
                      onChange={(v) => void patch({ assignee_id: v || null }, "assign")}
                      options={[{ value: "", label: "Nobody yet" }, ...r.assignees.map((a) => ({ value: a.id, label: a.id === r.viewer_id ? `${a.name} (you)` : a.name, hint: a.lead ? "Team lead" : undefined }))]}
                    />
                    {r.assignee?.id !== r.viewer_id && (
                      <button type="button" className="ghost small" disabled={!!busy} aria-busy={busy === "assign"} onClick={() => void patch({ assignee_id: r.viewer_id }, "assign")}>
                        <IconUser size={14} />
                        Take it
                      </button>
                    )}
                  </>
                ) : r.assignee ? (
                  <>
                    <Avatar name={r.assignee.name} size="sm" />
                    <span className="ellipsis">{r.my.assignee ? "You" : r.assignee.name}</span>
                  </>
                ) : (
                  <span className="muted">Nobody yet</span>
                )}
              </dd>
              <dt>Priority</dt>
              <dd>
                {r.my.can_edit ? (
                  <Select
                    size="sm"
                    ariaLabel="Priority"
                    value={r.priority}
                    onChange={(v) => void patch({ priority: v as Priority }, "priority")}
                    options={(["low", "normal", "high", "urgent"] as const).map((p) => ({ value: p, label: PRIORITY_COPY[p] }))}
                  />
                ) : (
                  PRIORITY_COPY[r.priority]
                )}
              </dd>
              <dt>Needed by</dt>
              <dd>
                {r.my.can_edit ? (
                  <DatePicker value={r.due_on ?? ""} onChange={(v) => void patch({ due_on: v || null }, "due")} label="Due" ariaLabel="Needed by" emptyText="no date" />
                ) : r.due_on ? (
                  formatDate(r.due_on)
                ) : (
                  <span className="muted">No date</span>
                )}
              </dd>
            </dl>

            <p className={`req-body${r.body ? "" : " empty-body"}`}>{r.body || "No details were added."}</p>

            <section aria-label="Activity">
              <h3 className="sheet-section">Activity</h3>
              <ol className="req-tl">
                {r.events.map((e) => (
                  <TimelineItem key={e.id} e={e} people={r.people} />
                ))}
              </ol>
            </section>
            <p className="muted sheet-privacy">
              Only {r.from_team ? r.from_team.name : r.requester.name}, {r.to_team.name} and the person assigned can see this request.
            </p>
          </>
        )}
      </div>

      {r && (
        <div className="sheet-foot">
        <form
          className="req-composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <label htmlFor="req-comment" className="sr-only">
            Write a reply
          </label>
          <textarea
            id="req-comment"
            rows={2}
            maxLength={4000}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
            }}
            placeholder={waitingOnMe ? "Answer their question…" : "Write a reply…"}
          />
          <div className="row">
            <span className="hint">{waitingOnMe ? `Sending this moves it back to ${r.to_team.name}.` : "Everyone involved can read replies."}</span>
            <button type="submit" className="primary" disabled={!comment.trim() || busy === "comment"} aria-busy={busy === "comment"}>
              <IconSend size={15} />
              Reply
            </button>
          </div>
        </form>
        </div>
      )}

      {noteFor && r && (
        <NoteDialog
          status={noteFor}
          onClose={() => setNoteFor(null)}
          onSubmit={async (note) => {
            await patch({ status: noteFor, note }, noteFor);
            setNoteFor(null);
          }}
        />
      )}
      </>
      )}
    </Sheet>
  );
}

function TimelineItem({ e, people }: { e: RequestEvent; people: Record<string, string> }) {
  const who = e.actor?.name ?? "Someone";
  const name = (id?: string | null) => (id ? (people[id] ?? "a former member") : "nobody");
  if (e.kind === "comment") {
    return (
      <li>
        <Avatar name={who} size="sm" />
        <div className="bubble">
          <header>
            <strong>{who}</strong>
            <PersonTeams userId={e.actor?.id} max={1} />
            <time dateTime={e.created_at} title={when(e.created_at)}>
              {ago(e.created_at)}
            </time>
          </header>
          <p>{e.body}</p>
        </div>
      </li>
    );
  }
  let text: React.ReactNode;
  if (e.kind === "created") text = <><strong>{who}</strong> sent the request</>;
  else if (e.kind === "status") {
    const to = (e.data.to ?? "open") as ReqStatus;
    text = e.data.auto ? (
      <>Back to <strong>{STATUS_COPY[to]}</strong> after the requester replied</>
    ) : to === "waiting" ? (
      <><strong>{who}</strong> asked the requester for info</>
    ) : to === "declined" ? (
      <><strong>{who}</strong> declined it</>
    ) : (
      <><strong>{who}</strong> moved it to <strong>{STATUS_COPY[to]}</strong></>
    );
  } else if (e.kind === "assigned") {
    text =
      e.data.reason === "left_team" ? (
        <><strong>{name(e.data.from)}</strong> left the team, so it went back to the team’s queue</>
      ) : e.data.to ? (
        <><strong>{who}</strong> assigned it to <strong>{e.data.to === e.actor?.id ? "themselves" : name(e.data.to)}</strong></>
      ) : (
        <><strong>{who}</strong> unassigned it</>
      );
  } else if (e.kind === "priority") text = <><strong>{who}</strong> set priority to <strong>{PRIORITY_COPY[(e.data.to ?? "normal") as Priority]}</strong></>;
  else text = e.data.to ? <><strong>{who}</strong> set the date to <strong>{formatDate(e.data.to)}</strong></> : <><strong>{who}</strong> removed the date</>;

  return (
    <>
      <li className="system">
        <span className="sys-dot" aria-hidden="true">
          {e.kind === "status" ? <IconFlag size={14} /> : e.kind === "assigned" ? <IconUser size={14} /> : <IconArrowRight size={14} />}
        </span>
        <span className="text">
          {text} · <time dateTime={e.created_at} title={when(e.created_at)}>{ago(e.created_at)}</time>
        </span>
      </li>
      {e.body && (
        <li>
          <Avatar name={who} size="sm" />
          <div className={`bubble${e.kind === "status" ? " note" : ""}`}>
            <p>{e.body}</p>
          </div>
        </li>
      )}
    </>
  );
}
