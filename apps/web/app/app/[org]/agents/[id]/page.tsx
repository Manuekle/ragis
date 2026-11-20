"use client";

import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import { confetti } from "@/lib/confetti";
import { PageBreadcrumbs } from "@/components/PageBreadcrumbs";
import { SkeletonEditor } from "@/components/skeletons";
import { useOrg } from "../../layout";
import { StateIllustration } from "@/components/AppState";
import { IconAgent, IconAlert, IconArchive, IconChat, IconCheck, IconChevronDown, IconFolder, IconLayers, IconLock, IconPause, IconPlay, IconPlus, IconRocket, IconRollback, IconShield, IconSpinner, IconTask, IconTool, IconTrash, IconX, type IconProps } from "@/components/icons";
import { Checkbox, Seg, SoftText, Toast } from "@/components/motion";
import { Disclosure, grainVars, Select, TextField, useConfirm } from "@/components/ui";
import { duration } from "@/lib/plain";
import { AgentGlyph, AUTONOMY, RiskBadge, StatusBadge, versionLabel } from "../shared";
import { useT, tNow } from "@/lib/use-t";

import { dateLocale } from "@/lib/i18n";
/* ───────────── types (mirror apps/api/src/lib/policy.ts) ───────────── */
interface Config {
  name: string;
  purpose: string;
  icon: string;
  category: string;
  instructions: { objective: string; boundaries: string; tone: string; checklist: string[]; output_schema: string };
  knowledge: { space_ids: string[]; require_citations: boolean };
  model: { profile: string; temperature: number; token_budget: number };
  tools: string[];
  autonomy: string;
  triggers: string[];
  limits: { max_steps: number; timeout_seconds: number; usd_per_run: number; max_retries: number; concurrency: number };
  tests: { name: string; input: string; expect_contains?: string; expect_citations: boolean }[];
}
interface Issue {
  path: string;
  code: string;
  message: string;
}
interface Validation {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
  risk: string;
}
interface Diff {
  tools_added: string[];
  tools_removed: string[];
  spaces_added: string[];
  spaces_removed: string[];
  changed: { path: string }[];
  risk: { from: string | null; to: string };
  permissions_expanded: boolean;
}
interface Detail {
  id: string;
  slug: string;
  name: string;
  status: string;
  draft: Config;
  draft_hash: string;
  active_version: { id: string; version: string; risk_level: string; published_at: string } | null;
  unpublished_changes: boolean;
  diff: Diff;
  validation: Validation;
  versions: { id: string; version: string; risk_level: string; changelog: string; published_at: string; published_by: string | null }[];
  last_test: { status: string; config_hash: string; created_at: string } | null;
  can_edit: boolean;
  publish: { allowed: boolean; reasons: string[]; next_version: Record<"major" | "minor" | "patch", string> };
}
interface Tool {
  id: string;
  label: string;
  description: string;
  risk: string;
  kind: string;
  available: boolean;
  unavailable_reason?: string;
  sandbox: string;
}
interface Catalog {
  tools: Tool[];
  output_schemas: string[];
  tenant_limits: Record<string, number>;
}
interface Step {
  n: number;
  type: string;
  tool?: string;
  decision?: string;
  reason: string;
  ms: number;
  detail?: Record<string, unknown>;
}
interface Case {
  name: string;
  status: string;
  answer: string | null;
  abstained: boolean;
  citations: { n: number; title: string; page: number | null; snippet: string }[];
  steps: Step[];
  checks: { name: string; ok: boolean; detail?: string }[];
}
interface Run {
  id: string;
  status: string;
  latency_ms: number;
  cases: Case[];
}

/* Plain-language choices. The editor stores the same values the API expects; people pick words, not numbers. */
const PROFILES = (): [string, string, string][] => ([
  ["reasoning", tNow("Thorough"), tNow("Takes a moment to think. Best for most agents.")],
  ["fast", tNow("Quick"), tNow("Fast, short answers for simple questions.")],
  ["vision", tNow("Reads images"), tNow("Understands scans, charts and photos.")],
  ["local", tNow("Private"), tNow("Keeps your data inside your own environment.")],
]);
const STYLES = (): { value: number; label: string; hint: string }[] => ([
  { value: 0.1, label: tNow("Precise"), hint: tNow("Sticks closely to the documents. Best for legal, finance and compliance.") },
  { value: 0.4, label: tNow("Balanced"), hint: tNow("Clear, natural wording that stays grounded in the documents.") },
  { value: 0.8, label: tNow("Creative"), hint: tNow("More varied wording, for drafting and brainstorming.") },
]);
const LENGTHS = (): { value: number; label: string; hint: string }[] => ([
  { value: 4000, label: tNow("Short"), hint: tNow("Brief, to-the-point answers.") },
  { value: 8000, label: tNow("Standard"), hint: tNow("Enough room for most answers.") },
  { value: 16000, label: tNow("Detailed"), hint: tNow("Long reports and in-depth reviews.") },
]);
/** Closest named option to a stored number, so older drafts with custom values still show a choice. */
const nearest = <T extends { value: number }>(opts: T[], v: number) => opts.reduce((a, b) => (Math.abs(b.value - v) < Math.abs(a.value - v) ? b : a));

const CATEGORIES = (): [string, string][] => ([
  ["search", tNow("Search & answer")],
  ["audit", tNow("Audit")],
  ["review", tNow("Review")],
  ["compare", tNow("Compare versions")],
  ["extract", tNow("Pull out data")],
  ["compliance", tNow("Compliance")],
  ["coordination", tNow("Coordination")],
  ["monitoring", tNow("Monitoring")],
  ["custom", tNow("Other")],
]);
const TONES = (): [string, string][] => ([
  ["neutral", tNow("Neutral")],
  ["formal", tNow("Formal")],
  ["concise", tNow("Brief")],
  ["didactic", tNow("Explanatory")],
]);
const OUTPUT_COPY = (): Record<string, string> => ({ "answer_with_citations.v1": tNow("Answer with sources"), "audit_findings.v1": tNow("List of findings"), "review_comments.v1": tNow("Review comments"), "version_diff.v1": tNow("Changes between versions"), "extracted_fields.v1": tNow("Extracted data"), "compliance_deviations.v1": tNow("Compliance gaps") });
const LIMITS = (): [keyof Config["limits"], string, number, string][] => ([
  ["usd_per_run", tNow("Cost limit ($)"), 0, tNow("Stops if one task would cost more.")],
  ["timeout_seconds", tNow("Time limit (seconds)"), 5, tNow("Stops a task that takes too long.")],
  ["max_steps", tNow("Steps per task"), 1, tNow("How many actions it may take for one request.")],
  ["max_retries", tNow("Retries"), 0, tNow("Tries again this many times if something fails.")],
  ["concurrency", tNow("Tasks at the same time"), 1, tNow("How many requests it handles at once.")],
]);
const KIND_COPY = (): Record<string, string> => ({ read: tNow("Reads"), write: tNow("Makes changes"), external: tNow("Leaves your organization") });
const DECISION_COPY = (): Record<string, string> => ({ allow: "allowed", mock: "simulated", deny: "blocked", require_approval: tNow("needs approval") });
const STEP_COPY = (): Record<string, string> => ({ validate: tNow("Checked settings"), scope: tNow("Checked folders"), output: tNow("Result"), tool: tNow("Action") });
const CHECK_COPY = (): Record<string, string> => ({ no_policy_denials: tNow("No blocked actions"), answer_has_citations: tNow("Answer includes sources"), expected_content: tNow("Answer includes the expected text"), expected_citations: tNow("Sources included"), max_steps: tNow("Finished within the step limit"), timeout: tNow("Finished in time") });
/** Where each validation issue lives in the editor, so messages point at a section instead of a field path. */
function sectionFor(path: string) {
  if (path.startsWith("instructions") || path === "purpose" || path === "name") return tNow("Instructions");
  if (path.startsWith("knowledge")) return tNow("Documents");
  if (path.startsWith("tools")) return tNow("Actions");
  if (path.startsWith("autonomy")) return tNow("Independence");
  if (path.startsWith("model") || path.startsWith("limits")) return tNow("Advanced settings");
  if (path.startsWith("tests")) return tNow("Test questions");
  return "";
}
const DIFF_COPY = (): Record<string, string> => ({
  name: tNow("Name"),
  purpose: tNow("Purpose"),
  icon: "Icon",
  category: tNow("Category"),
  autonomy: tNow("Independence"),
  triggers: tNow("How it starts"),
  tests: tNow("Test questions"),
  "knowledge.require_citations": tNow("Sources required"),
  "model.profile": tNow("AI engine"),
  "model.temperature": tNow("Response style"),
  "model.token_budget": tNow("Answer length"),
});
const diffLabel = (path: string) => DIFF_COPY()[path] ?? (path.startsWith("instructions") ? "Instructions" : path.startsWith("limits") ? "Limits" : path.startsWith("knowledge") ? "Documents" : path);
const BUMPS = (): ["patch" | "minor" | "major", string][] => ([
  ["patch", tNow("Small fix")],
  ["minor", tNow("Improvement")],
  ["major", tNow("Big change")],
]);

/* ───────────── editor layout: section anchors, sticky section nav, section card ───────────── */
type SectionId = "about" | "instructions" | "documents" | "actions" | "independence" | "tests" | "advanced";
const SECTIONS: [SectionId, string, (p: IconProps) => ReactNode][] = [
  ["about", "About", IconAgent],
  ["instructions", "Instructions", IconChat],
  ["documents", "Documents", IconFolder],
  ["actions", "Actions", IconTool],
  ["independence", "Independence", IconShield],
  ["tests", "Tests", IconTask],
  ["advanced", "Advanced", IconLayers],
];
const SECTION_ICON = Object.fromEntries(SECTIONS.map(([id, , I]) => [id, I])) as Record<SectionId, (p: IconProps) => ReactNode>;
/** Nav anchor for a validation path (unlike sectionFor, name/purpose live in "About"). */
function sectionIdFor(path: string): SectionId | null {
  if (path === "name" || path === "purpose" || path === "category" || path === "icon") return "about";
  if (path.startsWith("instructions")) return "instructions";
  if (path.startsWith("knowledge")) return "documents";
  if (path.startsWith("tools")) return "actions";
  if (path.startsWith("autonomy")) return "independence";
  if (path.startsWith("tests")) return "tests";
  if (path.startsWith("model") || path.startsWith("limits")) return "advanced";
  return null;
}

function EdSection({ id, title, hint, action, children }: { id: SectionId; title: string; hint?: string; action?: ReactNode; children: ReactNode }) {
  const Icon = SECTION_ICON[id];
  return (
    <section className="card ed-section" id={`ed-${id}`} data-ed-section="">
      <header>
        <span className="ed-ico" aria-hidden="true">
          <Icon size={16} />
        </span>
        <div className="ed-head-text">
          <h2>{title}</h2>
          {hint && <p>{hint}</p>}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

function SectionNav({ active, flags, onJump }: { active: SectionId; flags: Partial<Record<SectionId, "err" | "warn">>; onJump: (id: SectionId) => void }) {
  const tr = useT();
  return (
    <nav className="ed-nav" aria-label={tr("Agent setup sections")}>
      {SECTIONS.map(([id, label, Icon]) => (
        <a
          key={id}
          href={`#ed-${id}`}
          aria-current={active === id ? "location" : undefined}
          onClick={(e) => {
            e.preventDefault();
            onJump(id);
          }}
        >
          <Icon size={14} />
          {label}
          {flags[id] && <span className="flag" data-level={flags[id]} aria-label={flags[id] === "err" ? tr("Needs a fix") : tr("Has a warning")} />}
        </a>
      ))}
    </nav>
  );
}

export default function AgentEditor() {
  const tr = useT();
  const { org, id } = useParams<{ org: string; id: string }>();
  const { workspaces } = useOrg();
  const confirm = useConfirm();
  const router = useRouter();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [cfg, setCfg] = useState<Config | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  const [input, setInput] = useState("");
  const [tab, setTab] = useState<"builder" | "versions">("builder");
  const [bump, setBump] = useState<"major" | "minor" | "patch">("minor");
  const [changelog, setChangelog] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const clearNotice = useCallback(() => setNotice(null), []);
  const [section, setSection] = useState<SectionId>("about");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [showLocked, setShowLocked] = useState(false);
  // After a nav jump the clicked section stays highlighted until the person scrolls again: a section near the
  // end may never reach the spy line, and the smooth scroll passes through the sections in between.
  const spyLock = useRef(false);

  // Section nav scroll-spy: the active section is the last one whose top has passed under the sticky bars.
  // Scroll events don't bubble, so listen in the capture phase to catch the app panel's own scroller.
  const ready = !!detail && !!cfg;
  useEffect(() => {
    if (!ready || tab !== "builder") return;
    let frame = 0;
    const compute = () => {
      if (spyLock.current) return;
      const els = [...document.querySelectorAll<HTMLElement>("[data-ed-section]")];
      if (!els.length) return;
      const nav = document.querySelector(".ed-nav");
      const line = (nav?.getBoundingClientRect().bottom ?? 120) + 24;
      let current = els[0]!;
      for (const el of els) if (el.getBoundingClientRect().top <= line) current = el;
      // at the very bottom the last short sections never reach the line: pick the last one
      const last = els[els.length - 1]!;
      if (last.getBoundingClientRect().bottom <= window.innerHeight - 8) current = last;
      setSection(current.id.replace(/^ed-/, "") as SectionId);
    };
    const spy = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(compute);
    };
    const release = () => {
      spyLock.current = false;
    };
    // The page bar's height changes with width (and wraps on phones); the sticky nav and rail sit right under it.
    const bar = document.querySelector<HTMLElement>(".page-bar");
    const page = bar?.closest<HTMLElement>(".page");
    const setTop = () => page?.style.setProperty("--ed-top", `${bar?.offsetHeight ?? 56}px`);
    const measure = new ResizeObserver(setTop);
    if (bar) measure.observe(bar);
    setTop();
    compute();
    window.addEventListener("scroll", spy, { capture: true, passive: true });
    window.addEventListener("resize", spy, { passive: true });
    window.addEventListener("wheel", release, { passive: true });
    window.addEventListener("touchstart", release, { passive: true });
    window.addEventListener("keydown", release);
    return () => {
      cancelAnimationFrame(frame);
      measure.disconnect();
      window.removeEventListener("scroll", spy, { capture: true });
      window.removeEventListener("resize", spy);
      window.removeEventListener("wheel", release);
      window.removeEventListener("touchstart", release);
      window.removeEventListener("keydown", release);
    };
  }, [ready, tab]);

  // On narrow screens the nav scrolls sideways: keep the active chip in view.
  useEffect(() => {
    const nav = document.querySelector<HTMLElement>(".ed-nav");
    const chip = nav?.querySelector<HTMLElement>("[aria-current]");
    if (!nav || !chip || nav.scrollWidth <= nav.clientWidth) return;
    const left = chip.offsetLeft - 16;
    const right = chip.offsetLeft + chip.offsetWidth + 28;
    if (left < nav.scrollLeft) nav.scrollTo({ left, behavior: "smooth" });
    else if (right > nav.scrollLeft + nav.clientWidth) nav.scrollTo({ left: right - nav.clientWidth, behavior: "smooth" });
  }, [section]);

  const jumpTo = (id: SectionId) => {
    if (id === "advanced") setAdvancedOpen(true);
    setSection(id);
    spyLock.current = true;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document.getElementById(`ed-${id}`)?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  };

  const load = useCallback(
    async (resetDraft = true) => {
      try {
        const d = await api<Detail>(`organizations/${org}/agents/${id}`);
        setDetail(d);
        if (resetDraft) {
          setCfg(d.draft);
          setDirty(false);
        }
        if (!d.active_version) setBump("minor");
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [org, id],
  );

  useEffect(() => {
    load();
    api<Catalog>(`organizations/${org}/agents/catalog`)
      .then(setCatalog)
      .catch(() => undefined);
  }, [org, load]);

  // Aviso al salir con cambios sin guardar.
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  if (!detail || !cfg) {
    if (!error) return <SkeletonEditor label={tr("Loading agent…")} />;
    return (
      <div className="page">
        <div className="main">
          <div className="alert">
            <IconAlert size={16} />
            {error}
          </div>
        </div>
      </div>
    );
  }

  const ro = !detail.can_edit || detail.status === "archived";
  const update = (fn: (c: Config) => Config) => {
    setCfg((c) => (c ? fn(structuredClone(c)) : c));
    setDirty(true);
  };
  const readable = workspaces.filter((w) => w.my_role);
  const errorsAt = (prefix: string) => detail.validation.errors.filter((e) => e.path.startsWith(prefix));

  async function save(): Promise<boolean> {
    if (!cfg) return false;
    setSaving(true);
    setError(null);
    try {
      await api(`organizations/${org}/agents/${id}/draft`, { method: "PUT", body: { config: cfg } });
      await load(false);
      setDirty(false);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function test(suite: boolean) {
    if (!suite && input.trim().length < 2) return;
    if (dirty && !(await save())) return;
    setRunning(true);
    setError(null);
    try {
      const r = await api<Run>(`organizations/${org}/agents/${id}/test`, { method: "POST", body: suite ? {} : { input } });
      setRun(r);
      await load(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  async function publish(from?: HTMLElement) {
    setError(null);
    try {
      const r = await api<{ version: string }>(`organizations/${org}/agents/${id}/publish`, { method: "POST", body: { bump, changelog } });
      confetti({ origin: from });
      setNotice(tr("Version {version} published", { version: r.version }));
      setChangelog("");
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function setStatus(status: "published" | "paused" | "archived") {
    if (status === "archived" && !(await confirm({ title: tr("Archive this agent?"), body: tr("It stops running and becomes read-only. Versions and test history are kept."), confirmLabel: tr("Archive"), tone: "danger" }))) return;
    try {
      await api(`organizations/${org}/agents/${id}/status`, { method: "POST", body: { status } });
      setNotice(status === "paused" ? tr("Agent paused") : status === "archived" ? tr("Agent archived") : tr("Agent resumed"));
      await load(false);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // Never-published agent: "discard" archives it (hidden from the list) and returns to the studio.
  async function discardAgent() {
    if (!(await confirm({ title: tr("Discard this agent?"), body: tr("It was never published. It disappears from your list and can't be edited again."), confirmLabel: tr("Discard"), tone: "danger" }))) return;
    try {
      await api(`organizations/${org}/agents/${id}/status`, { method: "POST", body: { status: "archived" } });
      router.push(`/app/${org}/agents`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function discardChanges() {
    if (!(await confirm({ title: tr("Discard unsaved changes?"), body: tr("The draft goes back to the last saved version."), confirmLabel: tr("Discard changes"), tone: "danger" }))) return;
    setError(null);
    await load();
  }

  async function rollback(versionId: string, version: string) {
    if (!(await confirm({ title: `Go back to v${version}?`, body: tr("It becomes the live version. Your draft stays as it is. We check it against today's rules first.") }))) return;
    try {
      await api(`organizations/${org}/agents/${id}/rollback`, { method: "POST", body: { version_id: versionId } });
      setNotice(tr("Live version: v{version}", { version: version }));
      await load(false);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const v = detail.validation;
  const d = detail.diff;
  const neverPublished = !detail.active_version && detail.versions.length === 0;
  const testedCurrent = detail.last_test?.config_hash === detail.draft_hash ? detail.last_test.status : null;

  // section nav markers: red for errors, amber for warnings (errors win)
  const flags: Partial<Record<SectionId, "err" | "warn">> = {};
  for (const w of v.warnings) {
    const at = sectionIdFor(w.path);
    if (at) flags[at] = "warn";
  }
  for (const e of v.errors) {
    const at = sectionIdFor(e.path);
    if (at) flags[at] = "err";
  }

  // actions grouped by what they touch; ones the plan can't use yet sit in a collapsed group
  const allTools = catalog?.tools ?? [];
  const usableTools = allTools.filter((t) => t.available || cfg.tools.includes(t.id));
  const lockedTools = allTools.filter((t) => !t.available && !cfg.tools.includes(t.id));
  const toolKinds = [...new Set(["read", "write", "external", ...usableTools.map((t) => t.kind)])].filter((k) => usableTools.some((t) => t.kind === k));
  const toggleTool = (tool: string, on: boolean) => {
    if (ro) return;
    update((c) => ({ ...c, tools: on ? [...new Set([...c.tools, tool])] : c.tools.filter((x) => x !== tool) }));
  };

  return (
    <div className="page">
      <header className="page-bar">
        <PageBreadcrumbs section={tr("Agent Studio")} href={`/app/${org}/agents`} context={detail.name} icon={IconAgent} />
        <div className="row page-bar-actions">
          {detail.can_edit && detail.status === "published" && (
            <button type="button" className="quiet small" onClick={() => setStatus("paused")}>
              <IconPause size={14} />{tr("Pause")}</button>
          )}
          {detail.can_edit && detail.status === "paused" && (
            <button type="button" className="quiet small" onClick={() => setStatus("published")}>
              <IconPlay size={14} />{tr("Resume")}</button>
          )}
          {detail.can_edit && detail.status !== "archived" && !neverPublished && (
            <button type="button" className="quiet small" onClick={() => setStatus("archived")}>
              <IconArchive size={14} />{tr("Archive")}</button>
          )}
          {!ro && dirty && !saving && (
            <button type="button" className="quiet small" onClick={discardChanges}>
              <IconX size={14} />{tr("Discard changes")}</button>
          )}
          {detail.can_edit && detail.status !== "archived" && neverPublished && !dirty && (
            <button type="button" className="quiet small danger" onClick={discardAgent}>
              <IconTrash size={14} />{tr("Discard")}</button>
          )}
          {!ro && (
            <button type="button" className="primary small" disabled={!dirty || saving} onClick={save}>
              {saving ? <IconSpinner size={14} /> : dirty ? null : <IconCheck size={14} />}
              <SoftText text={saving ? tr("Saving…") : dirty ? tr("Save draft") : tr("Saved")} />
            </button>
          )}
        </div>
      </header>

      <div className="main" style={{ maxWidth: 1240 }}>
        <header className="page-head" style={{ marginBottom: 20 }}>
          <div className="row" style={{ gap: 14, alignItems: "center" }}>
            {/* same seed as the list card (saved name), so the hue doesn't shift while the name is edited */}
            <span className="grain-tile lg" style={grainVars(detail.name)} aria-hidden="true">
              <AgentGlyph icon={cfg.icon} size={24} />
            </span>
            <div>
              <h1>{tr(cfg.name)}</h1>
              <div className="row" style={{ gap: 6, marginTop: 6 }}>
                <StatusBadge status={detail.status} />
                <span className="badge">{versionLabel(detail.active_version?.version)}</span>
                <RiskBadge risk={v.risk} />
                {detail.unpublished_changes && detail.active_version && <span className="badge">{tr("Changes not published")}</span>}
              </div>
            </div>
          </div>
        </header>

        <div className="tabs" role="tablist" aria-label={tr("Agent sections")}>
          <button type="button" role="tab" aria-selected={tab === "builder"} onClick={() => setTab("builder")}>{tr("Setup")}</button>
          <button type="button" role="tab" aria-selected={tab === "versions"} onClick={() => setTab("versions")}>{tr("History")}<span className="count">{detail.versions.length}</span>
          </button>
        </div>

        {error && (
          <div className="alert" style={{ marginTop: 16 }}>
            <IconAlert size={16} />
            <span style={{ flex: 1 }}>{error}</span>
            <button type="button" className="quiet icon small" onClick={() => setError(null)} aria-label={tr("Dismiss")}>
              <IconX size={14} />
            </button>
          </div>
        )}

        {ro && (
          <div className="notice info" style={{ marginTop: 16 }}>
            <IconLock size={16} />
            {detail.status === "archived" ? tr("Archived agents are read-only.") : tr("Only the owner or an admin can edit this agent.")}
          </div>
        )}

        {tab === "builder" && (
          <div className="ed tab-panel" style={{ marginTop: 20 }}>
            <fieldset disabled={ro} className="ed-form">
              <SectionNav active={section} flags={flags} onJump={jumpTo} />
              <EdSection id="about" title={tr("About this agent")} hint={tr("Give it a name and say what it's for. Templates are a starting point; you can change everything.")}>
                <div className="ob-fields">
                  <TextField label={tr("Name")} value={cfg.name} maxLength={80} onChange={(e) => update((c) => ({ ...c, name: e.target.value }))} />
                  <div className="field">
                    <label>{tr("Type")}</label>
                    <Select value={cfg.category} onChange={(x) => update((c) => ({ ...c, category: x }))} ariaLabel={tr("Type")} options={CATEGORIES().map(([value, label]) => ({ value, label }))} />
                  </div>
                </div>
                <div className="field">
                  <label htmlFor="purpose">{tr("What is it for?")}</label>
                  <textarea id="purpose" rows={2} maxLength={400} placeholder={tr("e.g. Reviews supplier contracts and flags risky clauses")} value={cfg.purpose} onChange={(e) => update((c) => ({ ...c, purpose: e.target.value }))} />
                </div>
              </EdSection>

              <EdSection id="instructions" title={tr("Instructions")} hint={tr("Explain the job like you would to a new colleague. Your organization's rules always come first.")}>
                <div className="field" data-invalid={errorsAt("instructions").length ? "" : undefined}>
                  <label htmlFor="objective">{tr("What should it do?")}</label>
                  <textarea id="objective" rows={4} maxLength={4000} placeholder={tr("e.g. Read the contract, compare each clause with our policy and list the differences")} value={cfg.instructions.objective} onChange={(e) => update((c) => ({ ...c, instructions: { ...c.instructions, objective: e.target.value } }))} />
                </div>
                <div className="field">
                  <label htmlFor="boundaries">{tr("What must it never do?")}</label>
                  <textarea id="boundaries" rows={2} maxLength={2000} placeholder={tr("e.g. Never give legal advice or approve a contract")} value={cfg.instructions.boundaries} onChange={(e) => update((c) => ({ ...c, instructions: { ...c.instructions, boundaries: e.target.value } }))} />
                </div>
                <div className="ob-fields">
                  <div className="field">
                    <label>{tr("Tone")}</label>
                    <Seg role="group" aria-label={tr("Tone")}>
                      {TONES().map(([t, l]) => (
                        <button key={t} type="button" aria-pressed={cfg.instructions.tone === t} onClick={() => update((c) => ({ ...c, instructions: { ...c.instructions, tone: t } }))}>
                          {l}
                        </button>
                      ))}
                    </Seg>
                  </div>
                  <div className="field">
                    <label>{tr("Answer format")}</label>
                    <Select
                      value={cfg.instructions.output_schema}
                      onChange={(x) => update((c) => ({ ...c, instructions: { ...c.instructions, output_schema: x } }))}
                      ariaLabel={tr("Answer format")}
                      options={(catalog?.output_schemas ?? [cfg.instructions.output_schema]).map((x) => ({ value: x, label: OUTPUT_COPY()[x] ?? x }))}
                    />
                  </div>
                </div>
                <div className="ob-group">
                  <span className="label">{tr("Always check")}{" "}<small>{tr("optional")}</small>
                  </span>
                  <div className="list-editor">
                    {cfg.instructions.checklist.map((item, i) => (
                      <div className="item" key={i}>
                        <input value={item} maxLength={300} placeholder={tr("e.g. Termination clause")} aria-label={tr("Check {v1}", { v1: i + 1 })} onChange={(e) => update((c) => ({ ...c, instructions: { ...c.instructions, checklist: c.instructions.checklist.map((x, j) => (j === i ? e.target.value : x)) } }))} />
                        <button type="button" className="danger icon small" aria-label={tr("Remove item")} onClick={() => update((c) => ({ ...c, instructions: { ...c.instructions, checklist: c.instructions.checklist.filter((_, j) => j !== i) } }))}>
                          <IconTrash size={14} />
                        </button>
                      </div>
                    ))}
                    <div>
                      <button type="button" className="quiet small" onClick={() => update((c) => ({ ...c, instructions: { ...c.instructions, checklist: [...c.instructions.checklist, ""] } }))}>
                        <IconPlus size={14} />{tr("Add a check")}</button>
                    </div>
                  </div>
                </div>
              </EdSection>

              <EdSection id="documents" title={tr("Documents")} hint={tr("Folders the agent can read. People only ever get answers from documents they can already open.")}>
                <div className="check-list">
                  {readable.map((w) => (
                    <div className="check-item" key={w.id}>
                      <Checkbox checked={cfg.knowledge.space_ids.includes(w.id)} onChange={(on) => !ro && update((c) => ({ ...c, knowledge: { ...c.knowledge, space_ids: on ? [...c.knowledge.space_ids, w.id] : c.knowledge.space_ids.filter((x) => x !== w.id) } }))} label={<span className="sr-only">{tr(w.name)}</span>} />
                      <span className="meta">
                        <strong>{tr(w.name)}</strong>
                        <small>{w.my_role === "editor" ? tr("You can edit") : w.my_role === "reader" ? tr("You can read") : tr("You are {my_role}", { my_role: w.my_role })}</small>
                      </span>
                    </div>
                  ))}
                  {cfg.knowledge.space_ids
                    .filter((sid) => !readable.some((w) => w.id === sid))
                    .map((sid) => (
                      <div className="check-item" key={sid}>
                        <IconLock size={18} />
                        <span className="meta">
                          <strong>{tr(workspaces.find((w) => w.id === sid)?.name) ?? tr("Folder you can't open")}</strong>
                          <small>{tr("You don't have access — remove it or ask an admin for access.")}</small>
                        </span>
                        {!ro && (
                          <button type="button" className="quiet small" onClick={() => update((c) => ({ ...c, knowledge: { ...c.knowledge, space_ids: c.knowledge.space_ids.filter((x) => x !== sid) } }))}>{tr("Remove")}</button>
                        )}
                      </div>
                    ))}
                </div>
                <Checkbox checked={cfg.knowledge.require_citations} onChange={(on) => !ro && update((c) => ({ ...c, knowledge: { ...c.knowledge, require_citations: on } }))} label={tr("Always show the source of each answer (recommended)")} />
              </EdSection>

              <EdSection id="actions" title={tr("Actions")} hint={tr("Turn on only what the agent needs. While you test, actions are simulated and nothing real changes.")}>
                <div className="tool-groups">
                  {toolKinds.map((k) => {
                    const items = usableTools.filter((t) => t.kind === k);
                    const on = items.filter((t) => cfg.tools.includes(t.id)).length;
                    return (
                      <div className="tool-group" key={k}>
                        <div className="tool-group-head">
                          <span>{tr(KIND_COPY()[k]) ?? k}</span>
                          <span className="tool-group-count">
                            {on}{" "}{tr("of")}{" "}{items.length}
                          </span>
                        </div>
                        <div className="tool-list">
                          {items.map((t) => {
                            const checked = cfg.tools.includes(t.id);
                            // an unavailable action that is still switched on can only be switched off
                            const set = (next: boolean) => toggleTool(t.id, t.available ? next : false);
                            return (
                              <div
                                className="tool-row"
                                key={t.id}
                                data-on={checked ? "" : undefined}
                                data-unavailable={t.available ? undefined : ""}
                                onClick={(e) => {
                                  if (!(e.target as HTMLElement).closest("button, a, input")) set(!checked);
                                }}
                              >
                                <Checkbox checked={checked} onChange={set} label={<span className="sr-only">{t.available ? tr(t.label) : tr("Remove {label}", { label: t.label })}</span>} />
                                <span className="meta">
                                  <strong>
                                    {tr(t.label)}
                                    <RiskBadge risk={t.risk} />
                                  </strong>
                                  <small>{t.description}</small>
                                  {!t.available && (
                                    <span className="lock">
                                      <IconLock size={12} />
                                      {t.unavailable_reason}
                                    </span>
                                  )}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                  {lockedTools.length > 0 && (
                    <div className="tool-group" data-locked="">
                      <button type="button" className="quiet small tool-group-toggle" aria-expanded={showLocked} onClick={() => setShowLocked((x) => !x)}>
                        <IconLock size={13} />{tr("Not available")}<span className="tool-group-count">{lockedTools.length}</span>
                        <IconChevronDown size={14} className="chev" />
                      </button>
                      {showLocked && (
                        <div className="tool-list">
                          {lockedTools.map((t) => (
                            <div className="tool-row" key={t.id} data-unavailable="">
                              <IconLock size={16} />
                              <span className="meta">
                                <strong>
                                  {tr(t.label)}
                                  <RiskBadge risk={t.risk} />
                                  {t.kind !== "read" && <span className="badge">{tr(KIND_COPY()[t.kind]) ?? t.kind}</span>}
                                </strong>
                                <small>{t.description}</small>
                                <span className="lock">
                                  <IconLock size={12} />
                                  {t.unavailable_reason}
                                </span>
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </EdSection>

              <EdSection id="independence" title={tr("Independence")} hint={tr("How much the agent may do on its own. Signing and sending things outside always need a person.")}>
                <div className="choices cols-2">
                  {AUTONOMY().map(([a, l, h]) => (
                    <button key={a} type="button" className="choice" aria-pressed={cfg.autonomy === a} onClick={() => update((c) => ({ ...c, autonomy: a }))}>
                      {l}
                      <small>{h}</small>
                    </button>
                  ))}
                </div>
              </EdSection>

              <EdSection
                id="tests"
                title={tr("Test questions")}
                hint={tr("Save questions you expect it to handle, then run them all at once with “Run all tests”.")}
                action={
                  !ro && (
                    <button type="button" className="quiet small" disabled={cfg.tests.length >= 10} onClick={() => update((c) => ({ ...c, tests: [...c.tests, { name: `Question ${c.tests.length + 1}`, input: "", expect_citations: true }] }))}>
                      <IconPlus size={14} />{tr("Add question")}</button>
                  )
                }
              >
                {cfg.tests.length === 0 && (
                  <p className="muted" style={{ fontSize: 13.5 }}>{tr("No saved questions yet. You can also try one-off questions in “Try it”.")}</p>
                )}
                {cfg.tests.map((tc, i) => (
                  <div className="case" key={i}>
                    <div className="row spread">
                      <input value={tc.name} aria-label={tr("Test name")} maxLength={120} style={{ maxWidth: 260 }} onChange={(e) => update((c) => ({ ...c, tests: c.tests.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) }))} />
                      <button type="button" className="danger icon small" aria-label={tr("Remove question")} onClick={() => update((c) => ({ ...c, tests: c.tests.filter((_, j) => j !== i) }))}>
                        <IconTrash size={14} />
                      </button>
                    </div>
                    <textarea rows={2} placeholder={tr("Question or task")} value={tc.input} maxLength={2000} aria-label={tr("Test question")} onChange={(e) => update((c) => ({ ...c, tests: c.tests.map((x, j) => (j === i ? { ...x, input: e.target.value } : x)) }))} />
                    <div className="row">
                      <input
                        placeholder={tr("Answer should contain (optional)")}
                        value={tc.expect_contains ?? ""}
                        maxLength={200}
                        aria-label={tr("Expected content")}
                        style={{ flex: 1, minWidth: 200 }}
                        onChange={(e) => update((c) => ({ ...c, tests: c.tests.map((x, j) => (j === i ? { ...x, expect_contains: e.target.value || undefined } : x)) }))}
                      />
                      <Checkbox checked={tc.expect_citations} onChange={(on) => !ro && update((c) => ({ ...c, tests: c.tests.map((x, j) => (j === i ? { ...x, expect_citations: on } : x)) }))} label={tr("Should show sources")} />
                    </div>
                  </div>
                ))}
              </EdSection>

              <Disclosure id="ed-advanced" icon={<IconLayers size={16} />} open={advancedOpen} onOpenChange={setAdvancedOpen} title={tr("Advanced settings")} hint={tr("Recommended values are already set. Change them only if you need to.")}>
                <div className="field">
                  <label>{tr("AI engine")}</label>
                  <div className="choices" role="group" aria-label={tr("AI engine")}>
                    {PROFILES().map(([p, l, h]) => (
                      <button key={p} type="button" className="choice" aria-pressed={cfg.model.profile === p} onClick={() => update((c) => ({ ...c, model: { ...c.model, profile: p } }))}>
                        {l}
                        <small>{h}</small>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="ob-fields">
                  <div className="field">
                    <label>{tr("Response style")}</label>
                    <Seg role="group" aria-label={tr("Response style")}>
                      {STYLES().map((o) => (
                        <button key={o.label} type="button" aria-pressed={nearest(STYLES(), cfg.model.temperature).value === o.value} onClick={() => update((c) => ({ ...c, model: { ...c.model, temperature: o.value } }))}>
                          {tr(o.label)}
                        </button>
                      ))}
                    </Seg>
                    <span className="setting-hint">{tr(nearest(STYLES(), cfg.model.temperature).hint)}</span>
                  </div>
                  <div className="field">
                    <label>{tr("Answer length")}</label>
                    <Seg role="group" aria-label={tr("Answer length")}>
                      {LENGTHS().map((o) => (
                        <button key={o.label} type="button" aria-pressed={nearest(LENGTHS(), cfg.model.token_budget).value === o.value} onClick={() => update((c) => ({ ...c, model: { ...c.model, token_budget: o.value } }))}>
                          {tr(o.label)}
                        </button>
                      ))}
                    </Seg>
                    <span className="setting-hint">{tr(nearest(LENGTHS(), cfg.model.token_budget).hint)}</span>
                  </div>
                </div>
                <div className="field">
                  <label>{tr("Safety limits")}</label>
                  <div className="limits">
                    {LIMITS().map(([k, label, min, hint]) => (
                      <div key={k} className="stack" style={{ gap: 4 }}>
                        <TextField label={label} type="number" min={min} max={catalog?.tenant_limits[k]} step={k === "usd_per_run" ? 0.05 : 1} value={cfg.limits[k]} onChange={(e) => update((c) => ({ ...c, limits: { ...c.limits, [k]: Number(e.target.value) } }))} />
                        <span className="setting-hint">
                          {hint}
                          {catalog ? tr(" Your plan allows up to {v1}.", { v1: catalog.tenant_limits[k] }) : ""}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </Disclosure>
            </fieldset>

            <aside className="ed-side">
              <section className="card ed-section">
                <header>
                  <h2>{tr("Checklist")}</h2>
                  {v.ok ? (
                    <span className="badge ok">
                      <IconCheck size={12} />{tr("All good")}</span>
                  ) : (
                    <span className="badge err">{v.errors.length === 1 ? tr("1 thing to fix") : tr("{length} things to fix", { length: v.errors.length })}</span>
                  )}
                </header>
                {dirty && (
                  <p className="muted" style={{ fontSize: 12.5 }}>{tr("Save your changes to check them again.")}</p>
                )}
                <div className="issues">
                  {v.errors.map((e, i) => (
                    <div className="issue err" key={`e${i}`}>
                      <IconAlert size={14} />
                      <span>
                        {e.message}
                        {sectionFor(e.path) && <code>In {sectionFor(e.path)}</code>}
                      </span>
                    </div>
                  ))}
                  {v.warnings.map((e, i) => (
                    <div className="issue warn" key={`w${i}`}>
                      <IconShield size={14} />
                      <span>
                        {e.message}
                        {sectionFor(e.path) && <code>In {sectionFor(e.path)}</code>}
                      </span>
                    </div>
                  ))}
                  {v.ok && !v.warnings.length && (
                    <p className="muted" style={{ fontSize: 13 }}>{tr("Everything looks right. The agent never follows instructions written inside documents.")}</p>
                  )}
                </div>
              </section>

              <section className="card ed-section">
                <header>
                  <h2>{tr("Try it")}</h2>
                  <span className="badge accent">{tr("Test mode")}</span>
                </header>
                <textarea rows={3} placeholder={tr("Ask something the agent should handle…")} value={input} maxLength={2000} onChange={(e) => setInput(e.target.value)} aria-label={tr("Test question")} disabled={ro} />
                <div className="row">
                  <button type="button" className="primary small" disabled={ro || running || input.trim().length < 2} onClick={() => test(false)}>
                    {running ? <IconSpinner size={14} /> : <IconPlay size={14} />}
                    {dirty ? tr("Save & try") : tr("Try")}
                  </button>
                  <button type="button" className="ghost small" disabled={ro || running || cfg.tests.length === 0} onClick={() => test(true)}>{tr("Run all tests")}</button>
                </div>
                {run && (
                  <div className="stack" style={{ gap: 14 }}>
                    <div className="row">
                      <span className={`badge ${run.status === "passed" ? "ok" : "err"}`}>{run.status === "passed" ? tr("Passed") : run.status === "failed" ? tr("Didn't pass") : run.status}</span>
                      <span className="muted" style={{ fontSize: 12.5 }}>
                        {duration(run.latency_ms)}{" "}{tr("· nothing real was changed")}</span>
                    </div>
                    {run.cases.map((c, ci) => (
                      <div key={ci} className="stack" style={{ gap: 10 }}>
                        {run.cases.length > 1 && <strong style={{ fontSize: 13.5 }}>{tr(c.name)}</strong>}
                        <ol className="trace">
                          {c.steps.map((s) => (
                            <li key={s.n} data-decision={s.decision}>
                              <span className="dot">{s.n}</span>
                              <span className="body">
                                <strong>
                                  {s.tool ? (tr(catalog?.tools.find((t) => t.id === s.tool)?.label) ?? s.tool) : (tr(STEP_COPY()[s.type]) ?? s.type)}
                                  {s.decision && <span className="badge">{tr(DECISION_COPY()[s.decision]) ?? s.decision}</span>}
                                </strong>
                                <small>{s.reason}</small>
                              </span>
                            </li>
                          ))}
                        </ol>
                        {c.answer && <div className="run-answer">{c.answer}</div>}
                        {c.abstained && c.steps.some((s) => s.tool === "search_documents" && s.decision === "allow") && <div className="run-answer muted">{tr("No answer — the agent couldn't find enough evidence in its folders.")}</div>}
                        {c.citations.length > 0 && (
                          <ul className="run-cites">
                            {c.citations.map((ct) => (
                              <li key={ct.n}>
                                <b>[{ct.n}]</b>
                                <span>
                                  {ct.title}
                                  {ct.page ? ` · p. ${ct.page}` : ""}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                        <div className="issues">
                          {c.checks.map((k) => (
                            <div key={k.name} className={`issue ${k.ok ? "" : "err"}`} style={k.ok ? { color: "var(--ok)" } : undefined}>
                              {k.ok ? <IconCheck size={14} /> : <IconX size={14} />}
                              <span>
                                {tr(CHECK_COPY()[k.name]) ?? k.name.replace(/_/g, " ")}
                                {k.detail && <code>{k.detail}</code>}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="card ed-section">
                <header>
                  <h2>{tr("Publish")}</h2>
                  {testedCurrent && <span className={`badge ${testedCurrent === "passed" ? "ok" : "err"}`}>{testedCurrent === "passed" ? tr("Test passed") : tr("Test didn't pass")}</span>}
                </header>
                <div className="diff">
                  <span>{detail.active_version ? tr("Changes since {v1}:", { v1: versionLabel(detail.active_version.version) }) : tr("First version — everything is new.")}</span>
                  {d.tools_added.map((x) => (
                    <span className="add" key={`ta${x}`}>{tr("+ Action:")}{" "}{tr(catalog?.tools.find((t) => t.id === x)?.label) ?? x}
                    </span>
                  ))}
                  {d.tools_removed.map((x) => (
                    <span className="rm" key={`tr${x}`}>{tr("− Action:")}{" "}{tr(catalog?.tools.find((t) => t.id === x)?.label) ?? x}
                    </span>
                  ))}
                  {d.spaces_added.map((x) => (
                    <span className="add" key={`sa${x}`}>{tr("+ Folder:")}{" "}{tr(workspaces.find((w) => w.id === x)?.name) ?? tr("a folder you can't open")}
                    </span>
                  ))}
                  {d.spaces_removed.map((x) => (
                    <span className="rm" key={`sr${x}`}>{tr("− Folder:")}{" "}{tr(workspaces.find((w) => w.id === x)?.name) ?? tr("a folder you can't open")}
                    </span>
                  ))}
                  {[...new Set(d.changed.map((c) => diffLabel(c.path)))].map((label) => (
                    <span key={label}>~ {label}{" "}{tr("changed")}</span>
                  ))}
                  {d.risk.from && d.risk.from !== d.risk.to && (
                    <span className={d.permissions_expanded ? "rm" : "add"}>{tr("Risk:")}{" "}{d.risk.from} → {d.risk.to}
                    </span>
                  )}
                  {d.permissions_expanded && detail.active_version && (
                    <span className="notice" style={{ marginTop: 6 }}>
                      <IconShield size={14} />{tr("This version can do more than the live one.")}</span>
                  )}
                </div>
                {!detail.publish.allowed ? (
                  <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 4, fontSize: 13, color: "var(--muted)" }}>
                    <li>{tr("Before publishing:")}</li>
                    {(dirty ? ["save your changes", ...detail.publish.reasons] : detail.publish.reasons).map((r) => (
                      <li key={r}>· {r}</li>
                    ))}
                  </ul>
                ) : (
                  <div className="dialog-form">
                    {detail.active_version && (
                      <div className="field">
                        <label>{tr("Type of change")}</label>
                        <Seg role="group" aria-label={tr("Type of change")}>
                          {BUMPS().map(([b, l]) => (
                            <button key={b} type="button" aria-pressed={bump === b} onClick={() => setBump(b)}>
                              {l}
                            </button>
                          ))}
                        </Seg>
                      </div>
                    )}
                    <div className="field">
                      <label htmlFor="changelog">{tr("What changed?")}</label>
                      <textarea id="changelog" rows={2} maxLength={1000} placeholder={tr("e.g. Now also checks payment terms")} value={changelog} onChange={(e) => setChangelog(e.target.value)} />
                    </div>
                    <button type="button" className="primary" disabled={dirty || changelog.trim().length < 3} onClick={(e) => publish(e.currentTarget)}>
                      <IconRocket size={16} />{tr("Publish")}{" "}{detail.active_version ? versionLabel(detail.publish.next_version[bump]) : "v1.0.0"}
                    </button>
                  </div>
                )}
              </section>
            </aside>
          </div>
        )}

        {tab === "versions" && (
          <section className="card tab-panel" style={{ marginTop: 20 }}>
            {detail.versions.length === 0 ? (
              <div className="empty">
                <StateIllustration kind="agents" />
                <strong>{tr("Not published yet")}</strong>
                <span>{tr("Run a successful test in Setup, then publish the first version.")}</span>
              </div>
            ) : (
              <ul className="versions">
                {detail.versions.map((ver) => (
                  <li key={ver.id}>
                    <span className="badge mono">v{ver.version}</span>
                    <span className="meta">
                      <strong style={{ fontWeight: 500 }}>{ver.changelog || tr("No description")}</strong>
                      <small>
                        {new Date(ver.published_at).toLocaleString(dateLocale(), { dateStyle: "medium", timeStyle: "short" })} · {ver.published_by ?? "—"} · {ver.risk_level}{" "}{tr("risk")}</small>
                    </span>
                    {detail.active_version?.id === ver.id ? (
                      <span className="badge ok">{tr("Live")}</span>
                    ) : (
                      detail.can_edit &&
                      detail.status !== "archived" && (
                        <button type="button" className="quiet small" onClick={() => rollback(ver.id, ver.version)}>
                          <IconRollback size={14} />{tr("Go back to this version")}</button>
                      )
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
      <Toast message={notice} onDone={clearNotice} />
    </div>
  );
}
