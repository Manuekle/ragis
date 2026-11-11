"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Citation, type ConversationDetail, type QueryResult } from "@/lib/api";
import { useOrg } from "../layout";
import {
  IconAlert,
  IconSend,
  IconArrowUpRight,
  IconCalendar,
  IconCheck,
  IconChevronDown,
  IconExternal,
  IconEye,
  IconFile,
  IconFolder,
  IconNewChat,
  IconSpinner,
  IconThumbDown,
  IconThumbUp,
} from "@/components/icons";
import { StreamText, Swap, ThinkingStates, useDropdown } from "@/components/motion";
import { Skel, SkeletonStatus } from "@/components/skeletons";
import { ClickUpLogo, FolderGlyph, GmailLogo, SlackLogo } from "@/components/brand-logos";
import { DatePicker } from "@/components/ui";
import { DocViewer, type ViewerDoc } from "@/components/DocViewer";
import { clock } from "@/components/AudioView";
import { duration } from "@/lib/plain";
import { HistoryMenu } from "./HistoryMenu";

interface Turn {
  id: number;
  question: string;
  result?: QueryResult;
  error?: string;
  feedback?: 1 | -1;
  /** Restored from history, but a cited document is no longer visible to this person: the answer stays hidden. */
  redacted?: boolean;
}

/** UUID v4 for a new conversation; `randomUUID` only exists in secure contexts (https / localhost). */
function newConversationId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0]! & (15 >> (Number(c) / 4)))).toString(16));
}

/** Keeps `?c=<id>` in the address bar so a reload (or a bookmark) reopens the same conversation. */
function syncUrl(id: string | null) {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set("c", id);
  else url.searchParams.delete("c");
  window.history.replaceState(window.history.state, "", url);
}

const STATES = ["Searching the documents", "Finding the best passages", "Checking the sources", "Writing the answer"];

const SUGGESTIONS = [
  "What is the deadline to request travel expense reimbursements?",
  "Summarize the current remote work policy",
  "What changed in the latest version of the internal regulations?",
  "Who approves purchases above the limit?",
];

const KIND_LABEL: Record<string, string> = { table: "Table", figure: "Figure", equation: "Equation", audio: "Recording" };

/** Imagen de una figura citada: la URL firmada se pide solo al abrir la fuente y no se guarda. */
function FigurePreview({ chunkId, alt }: { chunkId: string; alt: string }) {
  const { org } = useParams<{ org: string }>();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    api<{ url: string }>(`organizations/${org}/chunks/${chunkId}/asset`)
      .then((r) => alive && setUrl(r.url))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [org, chunkId]);
  if (failed) return <p className="faint ai-note">The figure image is not available.</p>;
  if (!url) return <div className="figure-preview loading" aria-busy="true" />;
  return (
    <figure className="figure-preview">
      {/* eslint-disable-next-line @next/next/no-img-element -- URL firmada de corta duración, no optimizable */}
      <img src={url} alt={alt} loading="lazy" referrerPolicy="no-referrer" />
    </figure>
  );
}

function citationMeta(c: Citation) {
  return [`v${c.version_no}`, c.page ? `p. ${c.page}` : "", c.t_start != null ? `at ${clock(c.t_start)}` : "", c.section, c.effective_from ? `effective from ${c.effective_from}` : ""].filter(Boolean).join(" · ");
}

function Sources({ citations, openN, setOpenN, flashN, onOpen }: { citations: Citation[]; openN: number | null; setOpenN: (n: number | null) => void; flashN: number | null; onOpen: (c: Citation) => void }) {
  return (
    <div className="sources">
      <div className="sources-label">
        {citations.length} {citations.length === 1 ? "source" : "sources"}
      </div>
      {citations.map((c) => {
        const open = openN === c.n;
        return (
          <div key={c.n} id={`src-${c.n}`} className={`source${flashN === c.n ? " flash" : ""}`} data-open={open}>
            <button type="button" className="source-head" aria-expanded={open} onClick={() => setOpenN(open ? null : c.n)}>
              <span className="n">{c.n}</span>
              <span className="title">{c.title}</span>
              {c.kind && KIND_LABEL[c.kind] && <span className="badge accent">{KIND_LABEL[c.kind]}</span>}
              <span className="meta">{citationMeta(c)}</span>
              <IconChevronDown className="chev" size={16} />
            </button>
            <div className="acc-panel">
              <div className="acc-inner">
                <div className="acc-body">
                  {open && c.has_asset && <FigurePreview chunkId={c.chunk_id} alt={c.caption || `Figure from ${c.title}`} />}
                  <blockquote>{c.snippet}</blockquote>
                  {c.ai_generated && (
                    <p className="faint ai-note">Includes an AI-generated description of a figure or table. Check the original document for exact values.</p>
                  )}
                  {c.kind === "audio" && <p className="faint ai-note">Transcript written by AI. Listen to the recording to confirm the exact words.</p>}
                  <div className="row spread">
                    <span className="mono faint">{c.filename}</span>
                    <button type="button" className="ghost small" onClick={() => onOpen(c)}>
                      <IconExternal size={14} />
                      {c.t_start != null ? `Listen from ${clock(c.t_start)}` : "Open document"}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TurnView({ t, fresh, onFeedback, onOpen }: { t: Turn; fresh: boolean; onFeedback: (v: 1 | -1) => void; onOpen: (c: Citation) => void }) {
  const [openN, setOpenN] = useState<number | null>(null);
  const [flashN, setFlashN] = useState<number | null>(null);
  const r = t.result;
  const docs = r ? Array.from(new Map(r.citations.map((c) => [c.document_id, c.title])).values()) : [];

  function cite(n: number) {
    setOpenN(n);
    setFlashN(n);
    document.getElementById(`src-${n}`)?.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    setTimeout(() => setFlashN((x) => (x === n ? null : x)), 900);
  }

  return (
    <section className="turn">
      <div className="q-bubble">{t.question}</div>

      <div className="steps">
        {!r && !t.error && !t.redacted && (
          <div className="step">
            <ThinkingStates states={STATES} />
          </div>
        )}
        {r && docs.length > 0 && (
          <div className="step">
            <IconEye size={17} />
            <span>Consulted</span>
            <span className="chips">
              {docs.slice(0, 3).map((title) => (
                <span key={title} className="doc-chip" data-tip={title}>
                  <IconFile size={13} variant="duotone" />
                  <span>{title}</span>
                </span>
              ))}
              {docs.length > 3 && <span className="doc-chip">+{docs.length - 3}</span>}
            </span>
          </div>
        )}
      </div>

      {!r && !t.error && !t.redacted && (
        <SkeletonStatus label="Loading answer…">
          <div className="stack" style={{ gap: 10 }}>
            <Skel h={12} />
            <Skel w="92%" h={12} />
            <Skel w="65%" h={12} />
          </div>
        </SkeletonStatus>
      )}

      {t.error && (
        <div className="alert">
          <IconAlert size={16} />
          {t.error}
        </div>
      )}

      {t.redacted && (
        <div className="abstain">
          <IconAlert size={18} variant="duotone" />
          <div>
            This answer used a document you can no longer open, so it is hidden.
            <div className="hint">Ask the question again to get an answer based on what you can see today.</div>
          </div>
        </div>
      )}

      {r &&
        (r.abstain_reason === "smalltalk" ? (
          // Saludos y cortesías: respuesta fija del asistente, no es una abstención por falta de evidencia.
          <StreamText text={r.answer} animate={fresh} onCite={cite} />
        ) : r.abstained ? (
          <div className="abstain">
            <IconAlert size={18} variant="duotone" />
            <div>
              {r.answer}
              <div className="hint">Check that the document is uploaded to this workspace and that you have access, or ask using the terms the document uses.</div>
            </div>
          </div>
        ) : (
          <StreamText text={r.answer} animate={fresh} onCite={cite} />
        ))}

      {r && r.citations.length > 0 && <Sources citations={r.citations} openN={openN} setOpenN={setOpenN} flashN={flashN} onOpen={onOpen} />}

      {r && (
        <div className="turn-foot">
          <span className="faint" data-tip={`Reference for support: ${r.trace_id}`}>
            Answered in {duration(r.latency_ms)}
          </span>
          <span className="fb">
            <button type="button" className="quiet icon small" disabled={!!t.feedback} aria-pressed={t.feedback === 1} onClick={() => onFeedback(1)} data-fb="up" aria-label="Helpful answer" data-tip={t.feedback ? undefined : "Helpful"}>
              <IconThumbUp size={16} variant={t.feedback === 1 ? "duotone" : "stroke"} />
            </button>
            <button type="button" className="quiet icon small" disabled={!!t.feedback} aria-pressed={t.feedback === -1} onClick={() => onFeedback(-1)} data-fb="down" aria-label="Unhelpful answer" data-tip={t.feedback ? undefined : "Not helpful"} data-tip-side="end">
              <IconThumbDown size={16} variant={t.feedback === -1 ? "duotone" : "stroke"} />
            </button>
          </span>
        </div>
      )}
    </section>
  );
}

export default function AskPage() {
  const { org: orgId } = useParams<{ org: string }>();
  const { workspaceId, workspaces, setWorkspaceId } = useOrg();
  const wsMenu = useDropdown();
  const [question, setQuestion] = useState("");
  const [asOf, setAsOf] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [freshId, setFreshId] = useState<number | null>(null);
  const [viewing, setViewing] = useState<ViewerDoc | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const nextId = useRef(1);
  const wsName = workspaces.find((w) => w.id === workspaceId)?.name;

  // History (ADR-028). The id is made here, on the first question, and the API creates the conversation when it
  // saves that turn. `activeId` only turns on once a turn really was saved.
  const conversationId = useRef<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loadingConv, setLoadingConv] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const loadSeq = useRef(0);
  const pendingWs = useRef<string | null>(null);
  const orgRef = useRef({ workspaces, setWorkspaceId });
  useEffect(() => {
    orgRef.current = { workspaces, setWorkspaceId };
  });

  // A restored conversation can belong to another workspace; the workspace list may still be loading when it opens.
  useEffect(() => {
    const want = pendingWs.current;
    if (want && workspaces.some((w) => w.id === want)) {
      pendingWs.current = null;
      if (want !== workspaceId) setWorkspaceId(want);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setWorkspaceId changes identity every render
  }, [workspaces]);

  useEffect(() => {
    if (!turns.length) return;
    endRef.current?.scrollIntoView({ block: "end", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [turns]);

  async function ask(e?: React.FormEvent) {
    e?.preventDefault();
    if (!question.trim() || !workspaceId || busy) return;
    const q = question.trim();
    const id = nextId.current++;
    setBusy(true);
    setQuestion("");
    setTurns((t) => [...t, { id, question: q }]);
    try {
      const result = await api<QueryResult>(`organizations/${orgId}/workspaces/${workspaceId}/query`, {
        method: "POST",
        body: { question: q, conversation_id: (conversationId.current ??= newConversationId()), ...(asOf ? { as_of: asOf } : {}) },
      });
      if (result.conversation_id && result.conversation_id === conversationId.current) {
        setActiveId(result.conversation_id);
        syncUrl(result.conversation_id);
      }
      setFreshId(id);
      setTurns((t) => t.map((x) => (x.id === id ? { ...x, result } : x)));
    } catch (err) {
      setTurns((t) => t.map((x) => (x.id === id ? { ...x, error: (err as Error).message } : x)));
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  const openDoc = (c: Citation) =>
    setViewing({ documentId: c.document_id, versionId: c.version_id, title: c.title, filename: c.filename, startAt: c.t_start ?? undefined });
  const closeDoc = useCallback(() => setViewing(null), []);

  async function feedback(id: number, value: 1 | -1) {
    const t = turns.find((x) => x.id === id);
    if (!t?.result) return;
    setTurns((all) => all.map((x) => (x.id === id ? { ...x, feedback: value } : x)));
    try {
      await api(`organizations/${orgId}/query-runs/${t.result.trace_id}/feedback`, { method: "POST", body: { value } });
    } catch {
      setTurns((all) => all.map((x) => (x.id === id ? { ...x, feedback: undefined } : x)));
    }
  }

  const canSend = !!question.trim() && !!workspaceId && !busy;
  const empty = turns.length === 0;

  function suggest(s: string) {
    setQuestion(s);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(s.length, s.length);
    });
  }

  function reset() {
    if (busy) return;
    loadSeq.current++;
    conversationId.current = null;
    setActiveId(null);
    setLoadingConv(false);
    setNotice(null);
    syncUrl(null);
    setTurns([]);
    setFreshId(null);
    setQuestion("");
    inputRef.current?.focus();
  }

  const openConversation = useCallback(
    async (id: string) => {
      const mine = ++loadSeq.current;
      setLoadingConv(true);
      setNotice(null);
      try {
        const c = await api<ConversationDetail>(`organizations/${orgId}/conversations/${id}`);
        if (mine !== loadSeq.current) return;
        conversationId.current = c.id;
        setActiveId(c.id);
        setFreshId(null);
        setQuestion("");
        setTurns(
          c.turns.map((x) => ({
            id: nextId.current++,
            question: x.question,
            ...(x.result ? { result: x.result } : {}),
            ...(x.redacted ? { redacted: true } : {}),
            ...(x.feedback ? { feedback: x.feedback } : {}),
          })),
        );
        const last = c.turns[c.turns.length - 1];
        if (last) {
          const { workspaces: known, setWorkspaceId: pick } = orgRef.current;
          if (known.some((w) => w.id === last.workspace_id)) pick(last.workspace_id);
          else pendingWs.current = last.workspace_id; // the list is still loading, or the person lost access to it
        }
        syncUrl(c.id);
        requestAnimationFrame(() => inputRef.current?.focus());
      } catch (err) {
        if (mine !== loadSeq.current) return;
        syncUrl(null);
        conversationId.current = null;
        setActiveId(null);
        setNotice((err as { status?: number }).status === 404 ? "That conversation no longer exists." : "Couldn't open that conversation. Try again in a moment.");
      } finally {
        if (mine === loadSeq.current) setLoadingConv(false);
      }
    },
    [orgId],
  );

  // Opened from a link or after a reload: /ask?c=<id>.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("c");
    if (id) void openConversation(id);
  }, [openConversation]);

  function conversationDeleted(id: string) {
    if (id === conversationId.current) reset();
  }

  return (
    <div className={`chat${empty ? " is-empty" : ""}`}>
      <header className="page-bar">
        <div className="crumbs">
          <strong>Ask</strong>
          {wsName && (
            <>
              <span className="crumb-sep" aria-hidden="true">/</span>
              <span className="crumb-ws">
                <IconFolder size={15} />
                {wsName}
              </span>
            </>
          )}
        </div>
        <div className="row page-bar-actions">
          <HistoryMenu orgId={orgId} activeId={activeId} disabled={busy || loadingConv} onOpen={openConversation} onDeleted={conversationDeleted} />
          {!empty && (
            <button type="button" className="ghost small" onClick={reset} disabled={busy}>
              <IconNewChat size={15} />
              New conversation
            </button>
          )}
        </div>
      </header>

      <div className="chat-scroll">
        {notice && (
          <div className="alert" role="status">
            <IconAlert size={16} />
            {notice}
          </div>
        )}
        {loadingConv && empty ? (
          <SkeletonStatus label="Opening conversation…">
            <div className="stack" style={{ gap: 10 }}>
              <Skel w="40%" h={14} />
              <Skel h={12} />
              <Skel w="92%" h={12} />
              <Skel w="65%" h={12} />
            </div>
          </SkeletonStatus>
        ) : empty ? (
          <div className="chat-intro">
            <h1>What do you need to know?</h1>
            <p>
              I answer with citations from the documents you can see{wsName ? ` in ${wsName}` : ""}. If I can't find support, I'll say so instead of guessing.
            </p>
          </div>
        ) : (
          turns.map((t) => <TurnView key={t.id} t={t} fresh={t.id === freshId} onFeedback={(v) => feedback(t.id, v)} onOpen={openDoc} />)
        )}
        <div ref={endRef} />
      </div>

      <div className="composer-dock">
        <div className="composer-shell">
        <form className="composer" onSubmit={ask}>
          <textarea
            ref={inputRef}
            rows={2}
            aria-label="Question"
            placeholder={empty ? "Ask about your documents…" : "Ask a follow-up…"}
            value={question}
            maxLength={2000}
            autoFocus
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                ask();
              }
            }}
          />
          <div className="composer-bar">
            <DatePicker value={asOf} onChange={setAsOf} label="As of a date" ariaLabel="Answer as of a date" Icon={IconCalendar} tip="Answer using the documents that were valid on this date" />
            <button type="submit" className="send" disabled={!canSend} aria-label={busy ? "Searching for evidence" : "Ask"}>
              <Swap on={busy} a={<IconSend size={18} variant="duotone" />} b={<IconSpinner size={17} />} />
            </button>
          </div>
        </form>
        <div className="composer-foot">
          <div className="foot-ws" ref={wsMenu.ref}>
            <button type="button" className="foot-btn" aria-haspopup="menu" aria-expanded={wsMenu.isOpen} onClick={wsMenu.toggle}>
              <FolderGlyph size={20} />
              <span className="foot-name">{wsName ? `Work in ${wsName}` : "Work in a folder"}</span>
            </button>
            <div className={`menu ${wsMenu.cls}`} role="menu" data-origin="bottom-left" inert={!wsMenu.isOpen}>
              <div className="menu-label">Workspaces</div>
              {workspaces.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={w.id === workspaceId}
                  className="menu-item"
                  onClick={() => {
                    setWorkspaceId(w.id);
                    wsMenu.close();
                  }}
                >
                  {w.name}
                  {w.id === workspaceId && <IconCheck className="check" size={15} />}
                </button>
              ))}
            </div>
          </div>
          <Link href={`/app/${orgId}/connections`} className="foot-btn foot-apps">
            <span className="foot-name">Connect apps</span>
            <span className="app-logos" aria-hidden="true">
              <GmailLogo size={18} />
              <SlackLogo size={16} />
              <ClickUpLogo size={18} />
            </span>
          </Link>
        </div>
        </div>
        {empty && (
          <div className="suggestions" aria-label="Example questions">
            {SUGGESTIONS.map((s) => (
              <button key={s} type="button" className="suggestion" onClick={() => suggest(s)}>
                <span>{s}</span>
                <IconArrowUpRight size={15} />
              </button>
            ))}
          </div>
        )}
        <div className="composer-hint">
          <kbd>Enter</kbd> to send · <kbd>Shift</kbd> + <kbd>Enter</kbd> for a new line
        </div>
      </div>
      <DocViewer doc={viewing} orgId={orgId} onClose={closeDoc} />
    </div>
  );
}
