"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ConversationSummary } from "@/lib/api";
import { IconClock, IconEdit, IconTrash } from "@/components/icons";
import { useDropdown } from "@/components/motion";
import { Skel, SkeletonStatus } from "@/components/skeletons";
import { useConfirm } from "@/components/ui";

const PAGE = 30;

/** "14:05" today, "Yesterday", weekday within a week, otherwise "12 Nov" (adds the year when it differs). */
export function whenLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  if (diff <= 0) return d.toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" });
  if (diff === 1) return "Yesterday";
  if (diff < 7) return d.toLocaleDateString("en", { weekday: "long" });
  return d.toLocaleDateString("en", { day: "numeric", month: "short", ...(d.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) });
}

interface Props {
  orgId: string;
  /** Conversation currently on screen (highlighted in the list). */
  activeId: string | null;
  /** True while an answer is being written or a conversation is loading: nothing can be switched or removed. */
  disabled: boolean;
  onOpen: (id: string) => void;
  onDeleted: (id: string) => void;
}

export function HistoryMenu({ orgId, activeId, disabled, onOpen, onDeleted }: Props) {
  const menu = useDropdown();
  const confirm = useConfirm();
  const [items, setItems] = useState<ConversationSummary[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [more, setMore] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const seq = useRef(0);

  // Always refresh on open (the list changes every time a question is answered); keep the old rows visible meanwhile.
  const load = useCallback(() => {
    const mine = ++seq.current;
    setFailed(false);
    api<{ conversations: ConversationSummary[]; next_before: string | null }>(`organizations/${orgId}/conversations?limit=${PAGE}`)
      .then((r) => {
        if (mine !== seq.current) return;
        setItems(r.conversations);
        setNext(r.next_before);
      })
      .catch(() => mine === seq.current && setFailed(true));
  }, [orgId]);

  useEffect(() => {
    if (menu.isOpen) load();
    else setRenaming(null);
  }, [menu.isOpen, load]);

  async function showMore() {
    if (!next || more) return;
    setMore(true);
    try {
      const r = await api<{ conversations: ConversationSummary[]; next_before: string | null }>(
        `organizations/${orgId}/conversations?limit=${PAGE}&before=${encodeURIComponent(next)}`,
      );
      setItems((cur) => {
        const seen = new Set((cur ?? []).map((c) => c.id));
        return [...(cur ?? []), ...r.conversations.filter((c) => !seen.has(c.id))];
      });
      setNext(r.next_before);
    } catch {
      setFailed(true);
    } finally {
      setMore(false);
    }
  }

  async function saveTitle(c: ConversationSummary) {
    const title = draft.trim();
    setRenaming(null);
    if (!title || title === c.title) return;
    setBusyId(c.id);
    try {
      await api(`organizations/${orgId}/conversations/${c.id}`, { method: "PATCH", body: { title } });
      setItems((cur) => cur?.map((x) => (x.id === c.id ? { ...x, title } : x)) ?? cur);
    } catch {
      setFailed(true);
    } finally {
      setBusyId(null);
    }
  }

  async function remove(c: ConversationSummary) {
    const ok = await confirm({
      title: "Delete this conversation?",
      body: `“${c.title}” and its answers will be removed for good. This can't be undone.`,
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!ok) return;
    setBusyId(c.id);
    try {
      await api(`organizations/${orgId}/conversations/${c.id}`, { method: "DELETE" });
      setItems((cur) => cur?.filter((x) => x.id !== c.id) ?? cur);
      onDeleted(c.id);
    } catch {
      setFailed(true);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="hist" ref={menu.ref}>
      <button type="button" className="ghost small" aria-haspopup="true" aria-expanded={menu.isOpen} onClick={menu.toggle}>
        <IconClock size={15} />
        History
      </button>
      <div className={`menu ${menu.cls}`} role="region" aria-label="Conversation history" data-origin="top-right" inert={!menu.isOpen}>
        <div className="menu-label">Your conversations</div>
        {items === null && !failed ? (
          <SkeletonStatus label="Loading conversations…">
            <div className="stack" style={{ gap: 10, padding: "6px 10px 10px" }}>
              <Skel h={12} />
              <Skel w="70%" h={12} />
              <Skel w="85%" h={12} />
            </div>
          </SkeletonStatus>
        ) : (
          <div className="hist-list">
            {items?.length === 0 && (
              <p className="hist-empty">
                Nothing here yet. Your questions and answers are saved here automatically, and only you can see them.
              </p>
            )}
            {items?.map((c) => (
              <div key={c.id} className="hist-row" data-active={c.id === activeId}>
                {renaming === c.id ? (
                  <input
                    className="hist-rename"
                    aria-label="Conversation name"
                    value={draft}
                    maxLength={120}
                    autoFocus
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.nativeEvent.isComposing) saveTitle(c);
                      if (e.key === "Escape") {
                        e.stopPropagation();
                        setRenaming(null);
                      }
                    }}
                    onBlur={() => setRenaming(null)}
                  />
                ) : (
                  <button
                    type="button"
                    className="menu-item hist-open"
                    disabled={disabled || busyId === c.id}
                    aria-current={c.id === activeId ? "true" : undefined}
                    onClick={() => {
                      menu.close();
                      if (c.id !== activeId) onOpen(c.id);
                    }}
                  >
                    <span className="hist-title">{c.title}</span>
                    <span className="hist-meta">
                      {whenLabel(c.updated_at)} · {c.turns} {c.turns === 1 ? "question" : "questions"}
                    </span>
                  </button>
                )}
                {renaming !== c.id && (
                  <div className="hist-actions">
                    <button
                      type="button"
                      className="quiet icon small"
                      aria-label={`Rename “${c.title}”`}
                      title="Rename"
                      disabled={disabled || busyId === c.id}
                      onClick={() => {
                        setDraft(c.title);
                        setRenaming(c.id);
                      }}
                    >
                      <IconEdit size={15} />
                    </button>
                    <button
                      type="button"
                      className="quiet icon small"
                      aria-label={`Delete “${c.title}”`}
                      title="Delete"
                      disabled={disabled || busyId === c.id}
                      onClick={() => remove(c)}
                    >
                      <IconTrash size={15} />
                    </button>
                  </div>
                )}
              </div>
            ))}
            {next && (
              <button type="button" className="ghost small hist-more" disabled={more} onClick={showMore}>
                {more ? "Loading…" : "Show older"}
              </button>
            )}
          </div>
        )}
        {failed && <p className="hist-empty hist-error" role="alert">Couldn't reach your history. Try again in a moment.</p>}
      </div>
    </div>
  );
}
