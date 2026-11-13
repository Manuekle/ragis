"use client";

import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/api";
import { FormDialog } from "@/components/FormDialog";
import { Seg } from "@/components/motion";
import { Avatar, DatePicker, Select, TextField } from "@/components/ui";
import { IconArrowRight, IconCalendar, IconComment, IconSend } from "@/components/icons";
import { useOrg, type TeamDir } from "../layout";
import { TeamChip, type TeamRef } from "../team-tags";

export { TeamChip, type TeamRef };

/* ───────────── types (API: routes/teams.ts) ───────────── */

export type ReqStatus = "open" | "in_progress" | "waiting" | "done" | "declined" | "cancelled";
export type Priority = "low" | "normal" | "high" | "urgent";
export interface PersonRef {
  id: string;
  name: string;
  email?: string | null;
}
export interface RequestItem {
  id: string;
  number: number;
  title: string;
  excerpt?: string;
  body?: string;
  status: ReqStatus;
  priority: Priority;
  due_on: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  to_team: TeamRef;
  from_team: TeamRef | null;
  requester: PersonRef;
  assignee: PersonRef | null;
  comments: number;
  my: {
    requester: boolean;
    receiver: boolean;
    assignee: boolean;
    attention: boolean;
    transitions: ReqStatus[];
    can_assign: boolean;
    can_edit: boolean;
  };
}
/** Where a request opens: a panel over the Inbox, so the board stays in place behind it. */
export const requestHref = (org: string, id: string) => `/app/${org}/inbox?tab=people&r=${id}`;

/* ───────────── copy ───────────── */

export const STATUS_COPY: Record<ReqStatus, string> = {
  open: "New",
  in_progress: "In progress",
  waiting: "Waiting on requester",
  done: "Done",
  declined: "Declined",
  cancelled: "Cancelled",
};
/** Button labels: what the person does, not the state's name. */
export const MOVE_COPY: Record<ReqStatus, string> = {
  open: "Back to new",
  in_progress: "Start working",
  waiting: "Ask for info",
  done: "Mark as done",
  declined: "Decline",
  cancelled: "Cancel request",
};
export const PRIORITY_COPY: Record<Priority, string> = { low: "Low", normal: "Normal", high: "High", urgent: "Urgent" };
export const NOTE_PROMPT: Partial<Record<ReqStatus, { title: string; label: string; placeholder: string }>> = {
  waiting: { title: "What do you need from them?", label: "Your question", placeholder: "e.g. Which account should the certificate cover?" },
  declined: { title: "Why are you declining?", label: "Reason", placeholder: "e.g. This belongs to Operations, please ask them." },
};

export const BOARD_COLUMNS: { key: ReqStatus; label: string; hint: string; statuses: ReqStatus[] }[] = [
  { key: "open", label: "New", hint: "Not picked up yet", statuses: ["open"] },
  { key: "in_progress", label: "In progress", hint: "Someone is on it", statuses: ["in_progress"] },
  { key: "waiting", label: "Waiting on requester", hint: "Needs an answer", statuses: ["waiting"] },
  { key: "done", label: "Closed", hint: "Last 30 days", statuses: ["done", "declined", "cancelled"] },
];

/* ───────────── small pieces ───────────── */

/**
 * "Legal → Treasury", or "Ana → Treasury" when the requester asked on their own. With a single team every request
 * goes to the same place, so only who asked is shown.
 */
export function TeamRoute({ r }: { r: Pick<RequestItem, "from_team" | "to_team" | "requester" | "my"> }) {
  const { showTeamTags } = useOrg();
  if (!showTeamTags) return <span className="team-route">from {r.my.requester ? "you" : r.requester.name}</span>;
  return (
    <span className="team-route">
      {r.from_team ? <TeamChip team={r.from_team} /> : <span>{r.requester.name}</span>}
      <IconArrowRight size={12} aria-label="to" />
      <TeamChip team={r.to_team} />
    </span>
  );
}

export function StatusPill({ status }: { status: ReqStatus }) {
  return (
    <span className="req-status" data-s={status}>
      <span className="dot" aria-hidden="true" />
      {STATUS_COPY[status]}
    </span>
  );
}

export function PriorityTag({ priority, quiet = true }: { priority: Priority; quiet?: boolean }) {
  if (quiet && priority === "normal") return null;
  const on = { low: 1, normal: 2, high: 3, urgent: 3 }[priority];
  return (
    <span className="prio" data-p={priority} title={`${PRIORITY_COPY[priority]} priority`}>
      <span className="bars" aria-hidden="true">
        {[1, 2, 3].map((i) => (
          <i key={i} className={i <= on ? "on" : ""} />
        ))}
      </span>
      {PRIORITY_COPY[priority]}
    </span>
  );
}

const dayDiff = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  const due = new Date(y, m - 1, d);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((due.getTime() - today.getTime()) / 86400000);
};
const shortDate = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
};
export const dueLabel = (iso: string) => {
  const n = dayDiff(iso);
  if (n === 0) return "Due today";
  if (n === 1) return "Due tomorrow";
  if (n === -1) return "1 day late";
  if (n < 0) return `${-n} days late`;
  if (n < 7) return `Due in ${n} days`;
  return `Due ${shortDate(iso)}`;
};

export function DueDate({ iso, closed }: { iso: string | null; closed: boolean }) {
  if (!iso) return null;
  const late = !closed && dayDiff(iso) < 0;
  return (
    <span className={`due${late ? " late" : ""}`}>
      <IconCalendar size={12} />
      {closed ? `Due ${shortDate(iso)}` : dueLabel(iso)}
    </span>
  );
}

/* ───────────── list and board ───────────── */

/**
 * One line per request. The list is a grid and every row shares its columns (CSS subgrid), so priority, date, person
 * and status line up from row to row whatever each one holds. The "needs you" dot sits in the left gutter so numbers
 * and titles stay aligned too.
 */
export function RequestRow({ org, r }: { org: string; r: RequestItem }) {
  const who = r.assignee ? (r.my.assignee ? "You" : r.assignee.name) : null;
  return (
    <Link href={requestHref(org, r.id)} scroll={false} className={`req-row${r.my.attention ? " attention" : ""}`}>
      {r.my.attention && <span className="attn-dot" role="img" aria-label="Needs you" />}
      <span className="req-main">
        <span className="title">
          <span className="req-num">#{r.number}</span>
          <strong>{r.title}</strong>
        </span>
        <span className="sub">
          <TeamRoute r={r} />
          {r.comments > 0 && (
            <span className="comments" aria-label={`${r.comments} ${r.comments === 1 ? "reply" : "replies"}`}>
              <IconComment size={12} />
              {r.comments}
            </span>
          )}
        </span>
      </span>
      <span className="cell prio-cell">
        <PriorityTag priority={r.priority} />
      </span>
      <span className="cell due-cell">
        <DueDate iso={r.due_on} closed={!!r.closed_at} />
      </span>
      <span className="cell who-cell" data-tip={who ? `With ${who}` : "Not assigned yet"}>
        {r.assignee ? <Avatar name={r.assignee.name} size="sm" /> : <span className="nobody" aria-hidden="true" />}
        <span className="sr-only">{who ? `Assigned to ${who}` : "Not assigned yet"}</span>
      </span>
      <span className="cell status-cell">
        <StatusPill status={r.status} />
      </span>
    </Link>
  );
}

/** List: what needs you first, then everything else. */
export function RequestList({ org, items }: { org: string; items: RequestItem[] }) {
  const mine = items.filter((r) => r.my.attention);
  const rest = items.filter((r) => !r.my.attention);
  return (
    <div className="card req-list">
      {mine.length > 0 && rest.length > 0 && <div className="req-group-label">Needs you</div>}
      {mine.map((r) => (
        <RequestRow key={r.id} org={org} r={r} />
      ))}
      {mine.length > 0 && rest.length > 0 && <div className="req-group-label">Everything else</div>}
      {rest.map((r) => (
        <RequestRow key={r.id} org={org} r={r} />
      ))}
    </div>
  );
}

function RequestCard({ org, r, onDragStart, onDragEnd, dragging }: { org: string; r: RequestItem; onDragStart: () => void; onDragEnd: () => void; dragging: boolean }) {
  const movable = r.my.transitions.length > 0;
  return (
    <Link
      href={requestHref(org, r.id)}
      scroll={false}
      className={`req-card${r.my.attention ? " attention" : ""}${dragging ? " dragging" : ""}`}
      draggable={movable}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", r.id);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
    >
      <span className="top">
        <span className="row" style={{ gap: 8 }}>
          {r.my.attention && <span className="attn-dot" role="img" aria-label="Needs you" />}
          <span className="req-num">#{r.number}</span>
        </span>
        <PriorityTag priority={r.priority} />
      </span>
      <strong>{r.title}</strong>
      {r.excerpt && <p className="excerpt">{r.excerpt}</p>}
      <TeamRoute r={r} />
      <span className="foot">
        <DueDate iso={r.due_on} closed={!!r.closed_at} />
        {r.status !== "done" && r.closed_at && <StatusPill status={r.status} />}
        {r.comments > 0 && (
          <span className="comments" aria-label={`${r.comments} comments`}>
            <IconComment size={12} />
            {r.comments}
          </span>
        )}
        <span className="who">
          {r.assignee ? (
            <>
              <Avatar name={r.assignee.name} size="sm" />
              <span className="sr-only">Assigned to {r.assignee.name}</span>
            </>
          ) : (
            <span className="unassigned">Unassigned</span>
          )}
        </span>
      </span>
    </Link>
  );
}

/**
 * Kanban board. Drag a card to another column to move it; columns you can't move a card to fade out while dragging.
 * Moving to "waiting" asks what is needed from the requester first. On touch screens, open the card and use its
 * buttons instead.
 */
export function RequestBoard({ org, items, onMoved }: { org: string; items: RequestItem[]; onMoved: (r: RequestItem) => void }) {
  const [drag, setDrag] = useState<RequestItem | null>(null);
  const [over, setOver] = useState<ReqStatus | null>(null);
  const [pending, setPending] = useState<{ r: RequestItem; to: ReqStatus } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const move = async (r: RequestItem, to: ReqStatus, note?: string) => {
    setError(null);
    try {
      onMoved(await api<RequestItem>(`organizations/${org}/requests/${r.id}`, { method: "PATCH", body: { status: to, ...(note ? { note } : {}) } }));
      window.dispatchEvent(new Event("ragsis:inbox"));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const drop = (to: ReqStatus) => {
    const r = drag;
    setDrag(null);
    setOver(null);
    if (!r || !r.my.transitions.includes(to)) return;
    if (NOTE_PROMPT[to]) setPending({ r, to });
    else void move(r, to);
  };

  return (
    <>
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
      <div className="board" role="list" aria-label="Requests board">
        {BOARD_COLUMNS.map((col) => {
          const cards = items.filter((r) => col.statuses.includes(r.status));
          // "Closed" accepts done; declined/cancelled happen from the request page, where a reason is asked.
          const target: ReqStatus = col.key === "done" ? "done" : col.key;
          const allowed = drag ? drag.my.transitions.includes(target) && !col.statuses.includes(drag.status) : false;
          const state = !drag ? undefined : over === col.key && allowed ? "over" : allowed ? "ok" : col.statuses.includes(drag.status) ? undefined : "no";
          return (
            <section
              key={col.key}
              role="listitem"
              className="board-col"
              data-drop={state}
              aria-label={`${col.label}: ${cards.length}`}
              onDragOver={(e) => {
                if (!allowed) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (over !== col.key) setOver(col.key);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver((o) => (o === col.key ? null : o));
              }}
              onDrop={(e) => {
                e.preventDefault();
                drop(target);
              }}
            >
              <header>
                <span>
                  {col.label}
                  <small>{col.hint}</small>
                </span>
                <span className="count">{cards.length}</span>
              </header>
              {cards.map((r) => (
                <RequestCard key={r.id} org={org} r={r} dragging={drag?.id === r.id} onDragStart={() => setDrag(r)} onDragEnd={() => { setDrag(null); setOver(null); }} />
              ))}
              {cards.length === 0 && <p className="col-empty">Nothing here</p>}
            </section>
          );
        })}
      </div>
      {pending && (
        <NoteDialog
          status={pending.to}
          onClose={() => setPending(null)}
          onSubmit={async (note) => {
            await move(pending.r, pending.to, note);
            setPending(null);
          }}
        />
      )}
    </>
  );
}

/** Short required note for moves that need one (waiting on the requester, declining). */
export function NoteDialog({ status, onClose, onSubmit }: { status: ReqStatus; onClose: () => void; onSubmit: (note: string) => Promise<void> }) {
  const copy = NOTE_PROMPT[status]!;
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <FormDialog
      title={copy.title}
      description={status === "waiting" ? "They'll see your question in their Inbox. When they answer, the request comes back to your team." : "The requester will see your reason."}
      icon={IconComment}
      submitLabel={status === "waiting" ? "Send question" : "Decline request"}
      busy={busy}
      disabled={note.trim().length < 2}
      onClose={onClose}
      onSubmit={async () => {
        setBusy(true);
        try {
          await onSubmit(note.trim());
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="field">
        <label htmlFor="req-note">{copy.label}</label>
        <textarea id="req-note" data-autofocus rows={3} maxLength={4000} value={note} onChange={(e) => setNote(e.target.value)} placeholder={copy.placeholder} />
      </div>
    </FormDialog>
  );
}

/* ───────────── new request ───────────── */

export function NewRequestDialog({
  org,
  teams,
  defaultTeamId,
  onClose,
  onCreated,
}: {
  org: string;
  teams: TeamDir[];
  defaultTeamId?: string;
  onClose: () => void;
  onCreated: (r: RequestItem) => void;
}) {
  const open = teams.filter((t) => !t.archived_at);
  const mine = open.filter((t) => t.is_member);
  const [to, setTo] = useState(defaultTeamId ?? open.find((t) => !t.is_member)?.id ?? open[0]?.id ?? "");
  const [from, setFrom] = useState(mine.length === 1 ? mine[0].id : mine[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [priority, setPriority] = useState<Priority>("normal");
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [titleError, setTitleError] = useState<string | undefined>();

  const submit = async () => {
    if (title.trim().length < 3) {
      setTitleError("Write a short title, at least 3 characters.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api<RequestItem>(`organizations/${org}/requests`, {
        method: "POST",
        body: { to_team_id: to, from_team_id: from || null, title: title.trim(), body: body.trim(), priority, due_on: due || null },
      });
      window.dispatchEvent(new Event("ragsis:inbox"));
      onCreated(r);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <FormDialog
      title="Ask a team"
      description="The team gets it in their Inbox. Only you, that team and your own team can see it."
      icon={IconSend}
      submitLabel="Send request"
      busy={busy}
      disabled={!to}
      wide
      onClose={onClose}
      onSubmit={submit}
    >
      {error && (
        <div className="alert" role="alert" style={{ marginTop: 12 }}>
          {error}
        </div>
      )}
      <div className="field-row">
        <div className="field">
          <label htmlFor="new-req-to">To</label>
          <Select id="new-req-to" ariaLabel="Team you are asking" value={to} onChange={setTo} options={open.map((t) => ({ value: t.id, label: t.name, hint: t.is_member ? "Your team" : undefined }))} placeholder="Pick a team" />
        </div>
        {mine.length > 1 ? (
          <div className="field">
            <label htmlFor="new-req-from">On behalf of</label>
            <Select id="new-req-from" ariaLabel="Your team" value={from} onChange={setFrom} options={[...mine.map((t) => ({ value: t.id, label: t.name })), { value: "", label: "Just me" }]} />
          </div>
        ) : (
          <div className="field">
            <span className="field-label">From</span>
            <span className="select-trigger is-placeholder" style={{ cursor: "default" }}>
              {mine[0]?.name ?? "You (no team)"}
            </span>
          </div>
        )}
      </div>
      <TextField
        label="What do you need?"
        value={title}
        maxLength={160}
        onChange={(e) => {
          setTitle(e.target.value);
          setTitleError(undefined);
        }}
        placeholder="e.g. Bank certificate for the Acme contract"
        error={titleError}
        data-autofocus
      />
      <div className="field">
        <label htmlFor="req-body">Details (optional)</label>
        <textarea id="req-body" rows={4} maxLength={8000} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Context, deadlines, links… anything that helps them get it right the first time." />
      </div>
      <div className="field">
        <span className="field-label" id="new-req-prio">How urgent is it?</span>
        <Seg role="group" aria-labelledby="new-req-prio">
          {(["low", "normal", "high", "urgent"] as const).map((p) => (
            <button key={p} type="button" aria-pressed={priority === p} onClick={() => setPriority(p)}>
              {PRIORITY_COPY[p]}
            </button>
          ))}
        </Seg>
      </div>
      <div className="field">
        <span className="field-label">Needed by (optional)</span>
        <DatePicker value={due} onChange={setDue} label="Due" ariaLabel="Needed by" emptyText="no date" />
      </div>
    </FormDialog>
  );
}
