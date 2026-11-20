"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, generatedFileUrl, type Citation, type ConversationDetail, type DocFormat, type GeneratedDocument, type PublicSourcesSettings, type QueryResult } from "@/lib/api";
import { useOrg } from "../layout";
import {
  IconAlert,
  IconGlobalSearch,
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
import { DocumentCard, FORMAT, FormatPicker, downloadGenerated } from "./DocumentCard";
import { ExternalBody, ExternalIcon, externalMeta, loadChoice, publicNotice, PublicRecordsPicker, requestFields, saveChoice, usable, type PublicChoice } from "./PublicRecords";
import { useT, tNow } from "@/lib/use-t";
import { AnswerScope, SPACE_SCOPE, ScopePicker, parseScopeParam, scopeBody, scopeFromInfo, scopeLabel, type AskScope } from "./ScopePicker";

interface Turn {
  id: number;
  question: string;
  result?: QueryResult;
  error?: string;
  feedback?: 1 | -1;
  /** Restored from history, but a cited document is no longer visible to this person: the answer stays hidden. */
  redacted?: boolean;
  /** The turn is expected to produce a file (picked in "Answer as", or the question asks for one). */
  making?: DocFormat | "file";
  /** Public records were asked for (ADR-036): only changes the loading messages. */
  publicOn?: boolean;
  /** Where the question searched (ADR-037), to ask it again somewhere wider when it abstains. */
  scope?: AskScope;
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

const STATES = () => ([tNow("Searching the documents"), tNow("Finding the best passages"), tNow("Checking the sources"), tNow("Writing the answer")]);
const DOC_STATES = () => ([tNow("Searching the documents"), tNow("Gathering the evidence"), tNow("Drafting the document"), tNow("Checking every source"), tNow("Formatting the file")]);
const PUBLIC_STATES = () => ([tNow("Searching the documents"), tNow("Checking public records"), tNow("Checking the sources"), tNow("Writing the answer")]);

// Same idea as the server's detection (ADR-034), only to pick the loading messages: a creation verb plus a file word.
const ASKS_FOR_FILE =
  /\b(hazme|haz|crea|cr[eé]ame|genera|gen[eé]rame|elabora|redacta|prepara|arma|exporta|convierte|pasa|make|create|generate|draft|write|prepare|export|build|turn)\b[\s\S]*\b(pdf|word|docx|power ?point|pptx?|presentaci[oó]n|diapositivas|slides|deck|csv|excel|xlsx|hoja de c[aá]lculo|spreadsheet|tabla|table|informe|reporte|report|memo)\b/i;

// Starting questions in the words of the org's sector (from Setup); everyone else gets the general set.
const SUGGESTIONS = (sector: string | null | undefined) =>
  sector === "legal"
    ? [
        tNow("Summarize the case file: parties, claims and procedural stage"),
        tNow("Which deadlines and hearing dates appear in the documents?"),
        tNow("Make a Word memo of what the judgment decided, with citations"),
        tNow("Which clauses on termination and penalties does the contract have?"),
      ]
    : [
        tNow("What is the deadline to request travel expense reimbursements?"),
        tNow("Make a PowerPoint summary of the remote work policy"),
        tNow("What changed in the latest version of the internal regulations?"),
        tNow("Who approves purchases above the limit?"),
      ];

const KIND_LABEL = (): Record<string, string> => ({ table: tNow("Table"), figure: tNow("Figure"), equation: tNow("Equation"), audio: tNow("Recording"), public_record: tNow("Public record"), web: tNow("Web") });

/** Imagen de una figura citada: la URL firmada se pide solo al abrir la fuente y no se guarda. */
function FigurePreview({ chunkId, alt }: { chunkId: string; alt: string }) {
  const tr = useT();
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
  if (failed) return <p className="faint ai-note">{tr("The figure image is not available.")}</p>;
  if (!url) return <div className="figure-preview loading" aria-busy="true" />;
  return (
    <figure className="figure-preview">
      {/* eslint-disable-next-line @next/next/no-img-element -- URL firmada de corta duración, no optimizable */}
      <img src={url} alt={alt} loading="lazy" referrerPolicy="no-referrer" />
    </figure>
  );
}

function citationMeta(c: Citation) {
  return [`v${c.version_no}`, c.page ? `p. ${c.page}` : "", c.t_start != null ? tNow("at {time}", { time: clock(c.t_start) }) : "", c.section, c.effective_from ? tNow("effective from {date}", { date: c.effective_from }) : ""].filter(Boolean).join(" · ");
}

function Sources({ citations, openN, setOpenN, flashN, onOpen }: { citations: Citation[]; openN: number | null; setOpenN: (n: number | null) => void; flashN: number | null; onOpen: (c: Citation) => void }) {
  const tr = useT();
  return (
    <div className="sources">
      <div className="sources-label">
        {citations.length === 1 ? tr("1 source") : tr("{n} sources", { n: citations.length })}
      </div>
      {citations.map((c) => {
        const open = openN === c.n;
        return (
          <div key={c.n} id={`src-${c.n}`} className={`source${flashN === c.n ? " flash" : ""}`} data-open={open}>
            <button type="button" className="source-head" aria-expanded={open} onClick={() => setOpenN(open ? null : c.n)}>
              <span className="n">{c.n}</span>
              <span className="title">{c.title}</span>
              {c.kind && KIND_LABEL()[c.kind] && <span className={`badge ${c.external ? "pub-badge" : "accent"}`}>{c.external && <ExternalIcon c={c} size={12} />}{tr(KIND_LABEL()[c.kind])}</span>}
              <span className="meta">{c.external ? externalMeta(c) : citationMeta(c)}</span>
              <IconChevronDown className="chev" size={16} />
            </button>
            <div className="acc-panel">
              <div className="acc-inner">
                <div className="acc-body">
                  {c.external ? (
                    <ExternalBody c={c} />
                  ) : (
                  <>
                  {open && c.has_asset && <FigurePreview chunkId={c.chunk_id} alt={c.caption || tr("Figure from {title}", { title: c.title })} />}
                  <blockquote>{c.snippet}</blockquote>
                  {c.ai_generated && (
                    <p className="faint ai-note">{tr("Includes an AI-generated description of a figure or table. Check the original document for exact values.")}</p>
                  )}
                  {c.kind === "audio" && <p className="faint ai-note">{tr("Transcript written by AI. Listen to the recording to confirm the exact words.")}</p>}
                  <div className="row spread">
                    <span className="mono faint">{c.filename}</span>
                    <button type="button" className="ghost small" onClick={() => onOpen(c)}>
                      <IconExternal size={14} />
                      {c.t_start != null ? tr("Listen from {v1}", { v1: clock(c.t_start) }) : tr("Open document")}
                    </button>
                  </div>
                  </>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TurnView({ t, fresh, orgId, onFeedback, onOpen, onPreview, onWiden }: { t: Turn; fresh: boolean; orgId: string; onFeedback: (v: 1 | -1) => void; onOpen: (c: Citation) => void; onPreview: (d: GeneratedDocument) => void; onWiden?: () => void }) {
  const tr = useT();
  const [openN, setOpenN] = useState<number | null>(null);
  const [flashN, setFlashN] = useState<number | null>(null);
  const r = t.result;
  const docs = r ? Array.from(new Map(r.citations.filter((c) => !c.external).map((c) => [c.document_id, c.title])).values()) : [];
  // ADR-036: public registers and web sites cited, one chip each.
  const outside = r ? Array.from(new Map(r.citations.filter((c) => c.external && !c.no_match).map((c) => [c.source ?? c.title, c])).values()) : [];
  const notice = r ? publicNotice(r.public_sources, r.citations.filter((c) => c.external).length) : null;

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
        {r && <AnswerScope scope={r.scope} />}
        {!r && !t.error && !t.redacted && (
          <div className="step">
            <ThinkingStates states={t.making ? DOC_STATES() : t.publicOn ? PUBLIC_STATES() : STATES()} />
          </div>
        )}
        {r && docs.length > 0 && (
          <div className="step">
            <IconEye size={17} />
            <span>{tr("Consulted")}</span>
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
        {r && outside.length > 0 && (
          <div className="step">
            <IconGlobalSearch size={17} />
            <span>{tr("Looked up")}</span>
            <span className="chips">
              {outside.slice(0, 3).map((c) => (
                <span key={c.source ?? c.title} className="doc-chip pub-chip" data-tip={c.kind === "web" ? tr("Public web page") : tr("Official public record{v1}", { v1: c.country_name && c.country !== "global" ? ` · ${c.country_name}` : "" })}>
                  <ExternalIcon c={c} flag />
                  <span>{c.source ?? c.title}</span>
                </span>
              ))}
              {outside.length > 3 && <span className="doc-chip">+{outside.length - 3}</span>}
            </span>
          </div>
        )}
        {notice && (
          <div className="step pub-notice">
            <IconGlobalSearch size={17} />
            <span>{notice}</span>
          </div>
        )}
      </div>

      {!r && !t.error && !t.redacted && (
        <SkeletonStatus label={tr("Loading answer…")}>
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
          {tr(t.error)}
        </div>
      )}

      {t.redacted && (
        <div className="abstain">
          <IconAlert size={18} variant="duotone" />
          <div>{tr("This answer used a document you can no longer open, so it is hidden.")}<div className="hint">{tr("Ask the question again to get an answer based on what you can see today.")}</div>
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
              {tr(r.answer)}
              <div className="hint">
                {r.abstain_reason === "empty_scope"
                  ? tr("Link documents to it from the library, or search somewhere wider.")
                  : r.scope?.type === "matter"
                    ? tr("This expediente's documents don't answer it. Ask using the terms the documents use, or search all your spaces.")
                    : r.scope?.type === "folder" || r.scope?.type === "documents"
                      ? tr("The documents you limited the question to don't answer it. Ask using the terms they use, or search all your spaces.")
                    : r.scope?.type === "all"
                      ? tr("None of your spaces has a document that answers it, or you don't have access to it. Ask using the terms the document uses.")
                      : tr("Check that the document is uploaded to this workspace and that you have access, or ask using the terms the document uses.")}
              </div>
              {onWiden && r.scope?.type !== "all" && r.abstain_reason !== "smalltalk" && (
                <div className="scope-hint">
                  <button type="button" className="ghost small" onClick={onWiden}>
                    <IconGlobalSearch size={14} />
                    {tr("Search all my spaces")}
                  </button>
                </div>
              )}
            </div>
          </div>
        ) : (
          <StreamText text={r.answer} animate={fresh} onCite={cite} />
        ))}

      {r && !r.abstained && r.document && <DocumentCard doc={r.document} orgId={orgId} onPreview={onPreview} />}

      {r && r.citations.length > 0 && <Sources citations={r.citations} openN={openN} setOpenN={setOpenN} flashN={flashN} onOpen={onOpen} />}

      {r && (
        <div className="turn-foot">
          <span className="faint" data-tip={tr("Reference for support: {trace_id}", { trace_id: r.trace_id })}>{tr("Answered in")}{" "}{duration(r.latency_ms)}
          </span>
          <span className="fb">
            <button type="button" className="quiet icon small" disabled={!!t.feedback} aria-pressed={t.feedback === 1} onClick={() => onFeedback(1)} data-fb="up" aria-label={tr("Helpful answer")} data-tip={t.feedback ? undefined : tr("Helpful")}>
              <IconThumbUp size={16} variant={t.feedback === 1 ? "duotone" : "stroke"} />
            </button>
            <button type="button" className="quiet icon small" disabled={!!t.feedback} aria-pressed={t.feedback === -1} onClick={() => onFeedback(-1)} data-fb="down" aria-label={tr("Unhelpful answer")} data-tip={t.feedback ? undefined : tr("Not helpful")} data-tip-side="end">
              <IconThumbDown size={16} variant={t.feedback === -1 ? "duotone" : "stroke"} />
            </button>
          </span>
        </div>
      )}
    </section>
  );
}

export default function AskPage() {
  const tr = useT();
  const { org: orgId } = useParams<{ org: string }>();
  const { org: orgInfo, workspaceId, workspaces, setWorkspaceId } = useOrg();
  const wsMenu = useDropdown();
  const [question, setQuestion] = useState("");
  const [asOf, setAsOf] = useState("");
  // "Answer as" (ADR-034): null = chat answer, and the server still detects a file request in the question.
  const [format, setFormat] = useState<DocFormat | null>(null);
  // Public records (ADR-036): shown only when the organization has them on and the server has Croma set up.
  const [pubSettings, setPubSettings] = useState<PublicSourcesSettings | null>(null);
  const [pubChoice, setPubChoiceState] = useState<PublicChoice>(null);
  const setPubChoice = (v: PublicChoice) => {
    setPubChoiceState(v);
    saveChoice(orgId, v);
  };
  // ADR-037: where the next question searches. Folders and picked documents belong to the active space; expedientes
  // and "all my spaces" don't, so only the first two go back to the space when it changes.
  const [scope, setScope] = useState<AskScope>(SPACE_SCOPE);
  const scopeWs = useRef<string | null>(null);
  useEffect(() => {
    if (scopeWs.current && scopeWs.current !== workspaceId) setScope((s) => (s.type === "folder" || s.type === "documents" ? SPACE_SCOPE : s));
    scopeWs.current = workspaceId || null;
  }, [workspaceId]);
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
    let alive = true;
    setPubChoiceState(loadChoice(orgId));
    api<PublicSourcesSettings>(`organizations/${orgId}/public-sources`)
      .then((s) => alive && setPubSettings(s))
      .catch(() => alive && setPubSettings(null));
    return () => {
      alive = false;
    };
  }, [orgId]);

  useEffect(() => {
    if (!turns.length) return;
    endRef.current?.scrollIntoView({ block: "end", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [turns]);

  async function ask(e?: React.FormEvent) {
    e?.preventDefault();
    if (!question.trim() || !workspaceId || busy) return;
    await send(question.trim(), scope);
  }

  /** "Search all my spaces" after a narrower question abstained: same question, wider scope (ADR-037). */
  async function widen(q: string) {
    if (busy || !workspaceId) return;
    setScope({ type: "all" });
    await send(q, { type: "all" });
  }

  async function send(q: string, where: AskScope) {
    const id = nextId.current++;
    setBusy(true);
    setQuestion("");
    const making = format ?? (ASKS_FOR_FILE.test(q) ? "file" : undefined);
    const pub = requestFields(pubSettings, pubChoice);
    setTurns((t) => [...t, { id, question: q, scope: where, ...(making ? { making } : {}), ...(pub.public_sources ? { publicOn: true } : {}) }]);
    try {
      const result = await api<QueryResult>(`organizations/${orgId}/workspaces/${workspaceId}/query`, {
        method: "POST",
        body: {
          question: q,
          output: format ?? "auto",
          conversation_id: (conversationId.current ??= newConversationId()),
          ...(asOf ? { as_of: asOf } : {}),
          ...pub,
          ...(where.type !== "space" ? { scope: scopeBody(where) } : {}),
        },
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
  const previewGenerated = (d: GeneratedDocument) =>
    setViewing({
      documentId: d.id,
      versionId: "",
      title: d.title,
      filename: d.filename || `document.${d.format}`,
      source: { inlineUrl: generatedFileUrl(orgId, d.id, d.format, true), download: () => downloadGenerated(orgId, d.id, d.format) },
    });

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
        // A follow-up searches where the conversation was searching (ADR-037).
        setScope(scopeFromInfo(last?.result?.scope));
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
        setNotice((err as { status?: number }).status === 404 ? tr("That conversation no longer exists.") : tr("Couldn't open that conversation. Try again in a moment."));
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

  // ADR-037: /ask?scope=matter:<id> (from Expedientes), folder:<id> or documents:<id>,… (from the library). The parsed
  // link lives in a ref until it is applied: the URL loses `scope` at once, and a re-run of this effect (React's strict
  // mode runs it twice) still has it.
  const linkedScope = useRef<ReturnType<typeof parseScopeParam> | undefined>(undefined);
  useEffect(() => {
    if (linkedScope.current === undefined) {
      const url = new URL(window.location.href);
      linkedScope.current = parseScopeParam(url.searchParams.get("scope"));
      if (url.searchParams.has("scope")) {
        url.searchParams.delete("scope");
        window.history.replaceState(window.history.state, "", url);
      }
    }
    const want = linkedScope.current;
    if (!want) return;
    let alive = true;
    const [first] = want.ids;
    (async () => {
      if (want.type === "all") return setScope({ type: "all" });
      if (want.type === "matter") {
        const m = await api<{ id: string; title: string; client_name: string; case_number: string | null }>(`organizations/${orgId}/matters/${first}`);
        if (alive) setScope({ type: "matter", id: m.id, label: m.title, sub: [m.client_name, m.case_number].filter(Boolean).join(" · ") });
        return;
      }
      if (want.type === "documents") {
        const d = await api<{ document: { title: string; workspace_id: string } }>(`organizations/${orgId}/documents/${first}/status`);
        if (!alive) return;
        const { workspaces: known, setWorkspaceId: pick } = orgRef.current;
        if (known.some((w) => w.id === d.document.workspace_id)) pick(d.document.workspace_id);
        scopeWs.current = d.document.workspace_id;
        setScope({ type: "documents", ids: want.ids, label: d.document.title });
        return;
      }
      setScope({ type: "folder", id: first, label: tNow("Folder") });
    })()
      .then(() => {
        if (alive) linkedScope.current = null;
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [orgId]);
  // A folder link names the folder once the space's folders are known.
  useEffect(() => {
    if (scope.type !== "folder" || scope.label !== tNow("Folder") || !workspaceId) return;
    let alive = true;
    api<{ folders: { id: string; name: string }[] }>(`organizations/${orgId}/folders?workspace_id=${workspaceId}`)
      .then((r) => {
        const f = r.folders.find((x) => x.id === scope.id);
        if (alive && f) setScope({ type: "folder", id: f.id, label: f.name });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [scope, orgId, workspaceId]);

  function conversationDeleted(id: string) {
    if (id === conversationId.current) reset();
  }

  return (
    <div className={`chat${empty ? " is-empty" : ""}`}>
      <header className="page-bar">
        <div className="crumbs">
          <strong>{tr("Ask")}</strong>
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
              <IconNewChat size={15} />{tr("New conversation")}</button>
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
          <SkeletonStatus label={tr("Opening conversation…")}>
            <div className="stack" style={{ gap: 10 }}>
              <Skel w="40%" h={14} />
              <Skel h={12} />
              <Skel w="92%" h={12} />
              <Skel w="65%" h={12} />
            </div>
          </SkeletonStatus>
        ) : empty ? (
          <div className="chat-intro">
            <h1>{tr("What do you need to know?")}</h1>
            <p>{tr("I answer with citations from the documents you can see")}{scope.type !== "space" ? tr(" in {wsName}", { wsName: scopeLabel(scope, wsName) }) : wsName ? tr(" in {wsName}", { wsName }) : ""}{tr(", and I can turn the answer into a PDF report, Word document, PowerPoint or Excel workbook. If I can't find support, I'll say so instead of guessing.")}</p>
            {usable(pubSettings) && <p className="faint">{tr("Need outside facts? Turn on Public records to also check official government data and the web.")}</p>}
          </div>
        ) : (
          turns.map((t) => <TurnView key={t.id} t={t} fresh={t.id === freshId} orgId={orgId} onFeedback={(v) => feedback(t.id, v)} onOpen={openDoc} onPreview={previewGenerated} onWiden={busy ? undefined : () => widen(t.question)} />)
        )}
        <div ref={endRef} />
      </div>

      <div className="composer-dock">
        <div className="composer-shell">
        <form className="composer" onSubmit={ask}>
          <textarea
            ref={inputRef}
            rows={2}
            aria-label={tr("Question")}
            placeholder={format ? tr("Describe the {v1} you need…", { v1: FORMAT[format].name.toLowerCase() }) : empty ? tr("Ask about your documents, or ask for a report or slides…") : tr("Ask a follow-up…")}
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
            {workspaceId && <ScopePicker orgId={orgId} workspaceId={workspaceId} wsName={wsName} value={scope} onChange={setScope} disabled={busy} />}
            <FormatPicker value={format} onChange={setFormat} disabled={busy} />
            {usable(pubSettings) && <PublicRecordsPicker settings={pubSettings} value={pubChoice} onChange={setPubChoice} disabled={busy} />}
            <DatePicker value={asOf} onChange={setAsOf} label={tr("As of a date")} ariaLabel={tr("Answer as of a date")} Icon={IconCalendar} tip={tr("Answer using the documents that were valid on this date")} />
            <button type="submit" className="send" disabled={!canSend} aria-label={busy ? tr("Searching for evidence") : tr("Ask")}>
              <Swap on={busy} a={<IconSend size={18} variant="duotone" />} b={<IconSpinner size={17} />} />
            </button>
          </div>
        </form>
        <div className="composer-foot">
          <div className="foot-ws" ref={wsMenu.ref}>
            <button type="button" className="foot-btn" aria-haspopup="menu" aria-expanded={wsMenu.isOpen} onClick={wsMenu.toggle}>
              <FolderGlyph size={20} />
              <span className="foot-name">{wsName ? tr("Work in {wsName}", { wsName: wsName }) : tr("Work in a folder")}</span>
            </button>
            <div className={`menu ${wsMenu.cls}`} role="menu" data-origin="bottom-left" inert={!wsMenu.isOpen}>
              <div className="menu-label">{tr("Workspaces")}</div>
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
            <span className="foot-name">{tr("Connect apps")}</span>
            <span className="app-logos" aria-hidden="true">
              <GmailLogo size={18} />
              <SlackLogo size={16} />
              <ClickUpLogo size={18} />
            </span>
          </Link>
        </div>
        </div>
        {empty && (
          <div className="suggestions" aria-label={tr("Example questions")}>
            {SUGGESTIONS(orgInfo?.sector).map((s) => (
              <button key={s} type="button" className="suggestion" onClick={() => suggest(s)}>
                <span>{s}</span>
                <IconArrowUpRight size={15} />
              </button>
            ))}
          </div>
        )}
        <div className="composer-hint">
          <kbd>Enter</kbd>{" "}{tr("to send ·")}{" "}<kbd>Shift</kbd> + <kbd>Enter</kbd>{" "}{tr("for a new line")}</div>
      </div>
      <DocViewer doc={viewing} orgId={orgId} onClose={closeDoc} />
    </div>
  );
}
