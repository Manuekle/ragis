"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type QueryResult } from "@/lib/api";
import { confetti } from "@/lib/confetti";
import { OnboardingSkeleton } from "@/components/skeletons";
import { useOrg } from "../layout";
import { IconAlert, IconArrowRight, IconCheck, IconChevronLeft, IconLock, IconRocket, IconShield, IconSpinner, IconX } from "@/components/icons";
import { Checkbox, Seg, SoftText, Toast } from "@/components/motion";
import { Select, TextField } from "@/components/ui";
import { duration } from "@/lib/plain";
import { AUTONOMY_COPY } from "../agents/shared";
import { useT, tNow } from "@/lib/use-t";

/* ───────────── API shapes ───────────── */
interface Step { n: number; key: string; title: string; skippable: boolean }
interface Recommendation {
  template_version: string;
  sector: string;
  knowledge_spaces: string[];
  rag_profile: string;
  suggested_agents: { template: string; name: string; purpose?: string; reason: string; blocked: string | null }[];
  approval_policy: string;
  model_policy: string;
  guardrails: string[];
  warnings: string[];
}
interface Profile {
  country: string | null; timezone: string | null; legal_id: string | null;
  sector_primary: string | null; sector_secondary: string[]; activity_description: string | null; initial_area: string | null;
  team_size: string | null; language: string; goals: string[]; doc_types: string[]; volume_estimate: string | null;
  data_classification: string | null; deployment_preference: string | null; llm_policy: string | null; region: string | null;
  profile_version: number;
}
interface Onboarding {
  status: string;
  current_step: number;
  completed_steps: number[];
  skipped_steps: number[];
  recommendation: Recommendation | null;
  provisioned: { spaces: string[]; agents: string[] };
  can_edit: boolean;
  profile: Profile;
  steps: Step[];
  pilot: { documents_indexed: number; agents: number; passed_tests: number };
  catalog: {
    sectors: { code: string; label: string; docs_question: string; spaces: string[]; guardrail: string; approach: { label: string; planned?: boolean }[]; deployment: { label: string; default: string } }[];
    goals: string[];
    doc_types: string[];
    agent_templates: { code: string; name: string; purpose: string; tools: string[]; autonomy: string; blocked: string | null }[];
  };
  result?: { spaces?: { created: { name: string }[]; kept: { name: string }[] }; agents?: { created: { template: string }[]; skipped: { template: string; reason: string }[] } };
}

/* ───────────── copy ───────────── */
const SECTOR_HINT = (): Record<string, string> => ({
  legal: tNow("Case files, contracts, regulations"),
  consulting: tNow("Clients, projects, methodologies"),
  industry: tNow("Manuals, maintenance, quality"),
  accounting: tNow("Tax, supports, policies"),
  insurance: tNow("Policies, claims, incidents"),
  construction: tNow("Contracts, drawings, site records"),
  logistics: tNow("Shipments, carriers, customs, operations"),
  education: tNow("Regulations, registrar, quality"),
  other: tNow("Describe your activity — we keep defaults minimal"),
});
const GOAL_COPY = (): Record<string, [string, string]> => ({
  ask: [tNow("Ask"), tNow("Answers with citations from your documents")],
  audit: [tNow("Audit"), tNow("Findings with severity and evidence")],
  compare: [tNow("Compare"), tNow("Changes between versions by clause or page")],
  review: [tNow("Review"), tNow("Comments and proposed drafts")],
  approve: [tNow("Approve"), tNow("Route decisions to named people")],
  sign: [tNow("Sign"), tNow("Prepare documents for signature — a person always signs")],
  share: [tNow("Share"), tNow("Send documents outside with links that expire")],
});
/** Why Setup suggests an agent, as the API words it ("Goal: ask", "Legal preset", "Default"), in the page's language. */
const reasonLabel = (reason: string): string => {
  if (reason.startsWith("Goal: ")) {
    const goal = reason.slice(6);
    return tNow("Goal: {goal}", { goal: GOAL_COPY()[goal]?.[0] ?? goal });
  }
  if (reason.endsWith(" preset")) return tNow("Suggested for {sector}", { sector: tNow(reason.slice(0, -7)) });
  return tNow(reason);
};
const DOC_COPY = (): Record<string, string> => ({
  contracts: tNow("Contracts"), policies: tNow("Policies & procedures"), manuals: tNow("Manuals"), reports: tNow("Reports"),
  spreadsheets: tNow("Spreadsheets"), scanned: tNow("Scanned PDFs"), drawings: tNow("Drawings & plans"), presentations: tNow("Presentations"),
  emails: tNow("Emails"), other: tNow("Other"),
});
const TEAM = ["1-14", "15-50", "51-150", "151-500", "500+"];
const CLASSES = (): [string, string, string][] => ([
  ["public", tNow("Public"), tNow("Can be shared openly")],
  ["internal", tNow("Internal"), tNow("Employees only")],
  ["confidential", tNow("Confidential"), tNow("Need-to-know; client or financial data")],
  ["restricted", tNow("Restricted"), tNow("Must not leave your environment")],
]);
const DEPLOY = (): [string, string, string][] => ([
  ["cloud", tNow("Cloud"), tNow("We host it for you. Your data is kept separate from other companies.")],
  ["private_cloud", tNow("Private cloud"), tNow("A private environment just for your company.")],
  ["on_prem", tNow("On your servers"), tNow("Runs on your own infrastructure. Nothing leaves it.")],
]);
const LLM = (): [string, string, string][] => ([
  ["cloud_allowed", tNow("Trusted cloud AI"), tNow("Uses approved AI providers in the region you choose.")],
  ["local_only", tNow("Private AI only"), tNow("Your documents are never sent to an outside AI service.")],
  ["ask", tNow("Decide later"), tNow("Agents use private AI until you decide.")],
]);
const LANGS = () => ([
  { value: "es", label: tNow("Español") },
  { value: "es-CO", label: tNow("Español (Colombia)") },
  { value: "es-MX", label: tNow("Español (México)") },
  { value: "en", label: tNow("English") },
  { value: "pt-BR", label: tNow("Português (Brasil)") },
]);
const REGIONS = () => ([
  { value: "us-east-1", label: tNow("US East (N. Virginia)") },
  { value: "sa-east-1", label: tNow("South America (São Paulo)") },
  { value: "eu-west-1", label: tNow("Europe (Ireland)") },
  { value: "eu-central-1", label: tNow("Europe (Frankfurt)") },
]);
const ZONES = () => ([tNow("America/Bogota"), tNow("America/Mexico_City"), tNow("America/Lima"), tNow("America/Santiago"), tNow("America/Argentina/Buenos_Aires"), tNow("America/Sao_Paulo"), tNow("America/New_York"), tNow("Europe/Madrid"), "UTC"]);
const RAG_COPY = (): Record<string, string> => ({
  hybrid_with_citations: tNow("Smart search, every answer with its source"),
  multimodal_with_citations: tNow("Reads tables, drawings and scans, every answer with its source"),
  basic_with_citations: tNow("Simple search, every answer with its source"),
});
const MODEL_COPY = (): Record<string, string> => ({
  local_only: tNow("Private AI only"),
  region_and_provider_approved: tNow("Trusted cloud AI in your region"),
  confirm_before_cloud: tNow("Private AI until you approve cloud AI"),
});

type Form = {
  country: string; timezone: string; legal_id: string;
  sector_primary: string; sector_secondary: string[]; team_size: string; language: string; initial_area: string; activity_description: string;
  goals: string[];
  doc_types: string[];
  data_classification: string; deployment_preference: string; llm_policy: string; region: string;
  spaces: string[]; newSpace: string;
  agents: string[];
  ack: boolean;
};

const toggle = (list: string[], v: string, max = Infinity) => (list.includes(v) ? list.filter((x) => x !== v) : list.length >= max ? list : [...list, v]);
const clean = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== "" && v !== null && v !== undefined)) as Partial<T>;

export default function OnboardingPage() {
  const tr = useT();
  const { org } = useParams<{ org: string }>();
  const router = useRouter();
  const { org: orgInfo, workspaces, workspaceId } = useOrg();
  const [data, setData] = useState<Onboarding | null>(null);
  const [step, setStep] = useState(1);
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const clearNotice = useCallback(() => setNotice(null), []);
  const [trial, setTrial] = useState("");
  const [trialRes, setTrialRes] = useState<QueryResult | null>(null);
  const [trialBusy, setTrialBusy] = useState(false);

  const hydrate = useCallback((d: Onboarding, moveTo?: number) => {
    setData(d);
    const p = d.profile;
    const rec = d.recommendation;
    setForm((f) => ({
      country: p.country ?? "",
      timezone: p.timezone ?? (typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC"),
      legal_id: p.legal_id ?? "",
      sector_primary: p.sector_primary ?? "",
      sector_secondary: p.sector_secondary ?? [],
      team_size: p.team_size ?? "",
      language: p.language ?? "es",
      initial_area: p.initial_area ?? "",
      activity_description: p.activity_description ?? "",
      goals: p.goals ?? [],
      doc_types: p.doc_types ?? [],
      data_classification: p.data_classification ?? "",
      deployment_preference: p.deployment_preference ?? "",
      llm_policy: p.llm_policy ?? "",
      region: p.region ?? "us-east-1",
      // Selecciones de pasos 6/7: se conservan si el usuario ya las tocó; si no, parten de la recomendación.
      spaces: f?.spaces.length ? f.spaces : (rec?.knowledge_spaces ?? []).map((s) => tNow(s)),
      newSpace: "",
      agents: f?.agents.length ? f.agents : (rec?.suggested_agents ?? []).filter((a) => !a.blocked).map((a) => a.template),
      ack: f?.ack ?? false,
    }));
    if (moveTo !== undefined) setStep(moveTo);
  }, []);

  useEffect(() => {
    api<Onboarding>(`organizations/${org}/onboarding`)
      .then((d) => hydrate(d, d.status === "COMPLETED" ? 9 : Math.max(d.current_step, 1)))
      .catch((e) => setError(e.message));
  }, [org, hydrate]);

  const sector = useMemo(() => data?.catalog.sectors.find((s) => s.code === form?.sector_primary), [data, form?.sector_primary]);

  if (!data || !form) {
    if (!error) return <OnboardingSkeleton />;
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

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const meta = data.steps.find((s) => s.n === step)!;
  const done = new Set(data.completed_steps);
  const skipped = new Set(data.skipped_steps);
  const readOnly = !data.can_edit;
  const restricted = form.data_classification === "restricted";

  const payload = (): Record<string, unknown> | null => {
    switch (step) {
      case 1: return clean({ country: form.country, timezone: form.timezone, legal_id: form.legal_id });
      case 2: return clean({ sector_primary: form.sector_primary, sector_secondary: form.sector_secondary, team_size: form.team_size, language: form.language, initial_area: form.initial_area, activity_description: form.activity_description });
      case 3: return { goals: form.goals };
      case 4: return clean({ doc_types: form.doc_types });
      case 5: return clean({ data_classification: form.data_classification, deployment_preference: form.deployment_preference, llm_policy: form.llm_policy, region: form.region });
      case 6: return { spaces: form.spaces };
      case 7: {
        // Drafts are saved with the name and purpose the person reads (the API's templates are in English).
        const catalog = new Map(data.catalog.agent_templates.map((t) => [t.code, t]));
        const copy = Object.fromEntries(
          form.agents.flatMap((code) => {
            const name = catalog.get(code)?.name ?? data.recommendation?.suggested_agents.find((a) => a.template === code)?.name;
            const purpose = catalog.get(code)?.purpose ?? data.recommendation?.suggested_agents.find((a) => a.template === code)?.purpose;
            return name && purpose ? [[code, { name: tr(name), purpose: tr(purpose) }]] : [];
          }),
        );
        return { agents: form.agents, copy };
      }
      default: return {};
    }
  };

  const invalid = (): string | null => {
    if (step === 2 && (!form.sector_primary || !form.team_size)) return tr("Choose your main sector and team size.");
    if (step === 2 && form.sector_primary === "other" && !form.activity_description.trim()) return tr("Describe your activity in a sentence.");
    if (step === 3 && (form.goals.length < 1 || form.goals.length > 3)) return tr("Choose between one and three goals.");
    if (step === 5 && (!form.data_classification || !form.deployment_preference || !form.llm_policy)) return tr("Complete the three privacy choices.");
    if (step === 5 && restricted && form.llm_policy === "cloud_allowed") return tr("Restricted data cannot use cloud models.");
    if (step === 9 && !form.ack) return tr("Confirm you reviewed what activation does.");
    return null;
  };

  async function submit(action: "complete" | "skip", from?: HTMLElement) {
    setError(null);
    if (action === "complete") {
      const why = invalid();
      if (why) return setError(why);
    }
    setBusy(true);
    try {
      const d = await api<Onboarding>(`organizations/${org}/onboarding/steps/${step}`, { method: "PUT", body: { action, data: action === "skip" ? {} : payload() } });
      if (step === 6 && d.result?.spaces) {
        const c = d.result.spaces.created.length;
        setNotice(c ? tr("{c} space{v2} created", { c: c, v2: c > 1 ? "s" : "" }) : tr("Spaces kept as they were"));
      }
      if (step === 7 && d.result?.agents) {
        const c = d.result.agents.created.length;
        setNotice(c ? tr("{c} agent draft{v2} created", { c: c, v2: c > 1 ? "s" : "" }) : tr("No new drafts — existing agents were kept"));
      }
      if (step === 9) {
        confetti({ origin: from });
        router.push(`/app/${org}/agents`);
        return;
      }
      hydrate(d, d.current_step);
      document.getElementById("panel")?.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function pause() {
    try {
      await api(`organizations/${org}/onboarding/pause`, { method: "POST" });
    } catch {}
    router.push(`/app/${org}/ask`);
  }

  async function tryQuestion(e: React.FormEvent) {
    e.preventDefault();
    if (trial.trim().length < 2 || !workspaceId) return;
    setTrialBusy(true);
    setTrialRes(null);
    try {
      setTrialRes(await api<QueryResult>(`organizations/${org}/workspaces/${workspaceId}/query`, { method: "POST", body: { question: trial } }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setTrialBusy(false);
    }
  }

  const rec = data.recommendation;
  const existing = new Map(workspaces.map((w) => [w.name.toLowerCase(), w]));
  // Suggested names in the reader's language: the spaces are created with the names shown here.
  const suggestedSpaces = (rec?.knowledge_spaces ?? []).map((s) => tr(s));
  const spaceOptions = [...new Set([...suggestedSpaces, ...form.spaces])];
  const templates = new Map(data.catalog.agent_templates.map((t) => [t.code, t]));
  const suggested = rec?.suggested_agents ?? [];
  const progress = Math.round((done.size / 9) * 100);

  return (
    <div className="page">
      <header className="page-bar">
        <div className="crumbs">
          <strong>{tr("Setup")}</strong>
          <span className="crumb-sep" aria-hidden="true">/</span>
          <span className="crumb-ws">{orgInfo?.name ?? tr("Organization")}</span>
        </div>
        {data.status !== "COMPLETED" && data.can_edit && (
          <button type="button" className="quiet small" onClick={pause}>{tr("Finish later")}</button>
        )}
      </header>

      <div className="main">
        <div className="ob">
          <nav className="ob-rail" aria-label={tr("Setup steps")}>
            <div className="ob-rail-head">
              <strong>{tr("Set up")}{" "}{orgInfo?.name ?? tr("your workspace")}</strong>
              <div>
                <small>
                  {data.status === "COMPLETED" ? tr("Active · edit anytime") : data.status === "NEEDS_REVIEW" ? tr("Profile changed · review suggestions") : tr("{progress}% · about {v2} min left", { progress: progress, v2: Math.max(1, 9 - done.size) })}
                </small>
              </div>
              <div className="ob-progress" aria-hidden="true">
                <span style={{ width: `${progress}%` }} />
              </div>
            </div>
            {data.steps.map((s) => {
              const state = done.has(s.n) ? "done" : skipped.has(s.n) ? "skipped" : "todo";
              return (
                <button
                  key={s.n}
                  type="button"
                  className="ob-step"
                  data-state={state}
                  aria-current={s.n === step ? "step" : undefined}
                  onClick={() => {
                    setError(null);
                    setStep(s.n);
                  }}
                  disabled={s.n === 1 && !data.can_edit}
                >
                  <span className="n">{state === "done" ? <IconCheck size={12} /> : s.n}</span>
                  <span className="label">{tr(s.title)}</span>
                  {state === "skipped" && <span className="tag">{tr("Skipped")}</span>}
                </button>
              );
            })}
          </nav>

          <section className="card ob-card" aria-labelledby="ob-title" key={step}>
            <header>
              <div className="eyebrow">{tr("Step")}{" "}{step}{" "}{tr("of 9")}</div>
              <h2 id="ob-title">{stepTitle(step, sector?.label)}</h2>
              <p>{stepLead(step, sector?.docs_question)}</p>
            </header>

            {readOnly && (
              <div className="notice info">
                <IconLock size={16} />{tr("Only owners and admins can change the setup. You can browse it.")}</div>
            )}

            {step === 1 && (
              <div className="ob-fields">
                <TextField label={tr("Country")} placeholder={tr("Colombia")} value={form.country} onChange={(e) => set("country", e.target.value)} disabled={readOnly} />
                <div className="field">
                  <label>{tr("Time zone")}</label>
                  <Select value={form.timezone} onChange={(v) => set("timezone", v)} ariaLabel={tr("Time zone")} options={[...new Set([form.timezone, ...ZONES()])].filter(Boolean).map((z) => ({ value: z, label: z.replace(/_/g, " ") }))} />
                </div>
                <TextField label={tr("Business ID (optional)")} placeholder={tr("NIT / VAT / EIN")} value={form.legal_id} onChange={(e) => set("legal_id", e.target.value)} disabled={readOnly} />
              </div>
            )}

            {step === 2 && (
              <>
                <div className="ob-group">
                  <span className="label">{tr("Main sector")}</span>
                  <div className="choices" role="group" aria-label={tr("Main sector")}>
                    {data.catalog.sectors.map((s) => (
                      <button
                        key={s.code}
                        type="button"
                        className="choice"
                        aria-pressed={form.sector_primary === s.code}
                        disabled={readOnly}
                        onClick={() => setForm((f) => (f ? { ...f, sector_primary: s.code, sector_secondary: f.sector_secondary.filter((x) => x !== s.code) } : f))}
                      >
                        {tr(s.label)}
                        <small>{tr(SECTOR_HINT()[s.code])}</small>
                      </button>
                    ))}
                  </div>
                </div>
                {sector && sector.code !== "other" && (
                  <div className="notice info" role="status">
                    <IconArrowRight size={16} />
                    <span>
                      <strong>{tr("Recommended for")}{" "}{sector.label.toLowerCase()}:</strong>{" "}
                      {sector.approach.map((a) => (a.planned ? tr("{label} (coming soon)", { label: tr(a.label) }) : tr(a.label))).join(" + ")}{tr(", with the source of every answer.")}{" "}<strong>{tr("Usually hosted in:")}</strong> {tr(sector.deployment.label)}.
                    </span>
                  </div>
                )}
                {form.sector_primary === "other" && (
                  <div className="field">
                    <label htmlFor="activity">{tr("What does your organization do?")}</label>
                    <textarea id="activity" rows={2} maxLength={500} placeholder={tr("e.g. We manage real-estate assets for family offices")} value={form.activity_description} onChange={(e) => set("activity_description", e.target.value)} disabled={readOnly} />
                  </div>
                )}
                <div className="ob-group">
                  <span className="label">{tr("Secondary sectors")}{" "}<small>{tr("optional · up to 3")}</small>
                  </span>
                  <div className="chips">
                    {data.catalog.sectors
                      .filter((s) => s.code !== form.sector_primary && s.code !== "other")
                      .map((s) => (
                        <button key={s.code} type="button" className="chip" aria-pressed={form.sector_secondary.includes(s.code)} disabled={readOnly} onClick={() => set("sector_secondary", toggle(form.sector_secondary, s.code, 3))}>
                          {tr(s.label)}
                        </button>
                      ))}
                  </div>
                </div>
                <div className="ob-group">
                  <span className="label">{tr("Team size")}</span>
                  <Seg role="group" aria-label={tr("Team size")}>
                    {TEAM.map((t) => (
                      <button key={t} type="button" aria-pressed={form.team_size === t} disabled={readOnly} onClick={() => set("team_size", t)}>
                        {t}
                      </button>
                    ))}
                  </Seg>
                </div>
                <div className="ob-fields">
                  <div className="field">
                    <label>{tr("Working language")}</label>
                    <Select value={form.language} onChange={(v) => set("language", v)} options={LANGS()} ariaLabel={tr("Working language")} />
                  </div>
                  <TextField label={tr("First team or area (optional)")} placeholder={tr("e.g. Corporate law")} value={form.initial_area} onChange={(e) => set("initial_area", e.target.value)} disabled={readOnly} />
                </div>
              </>
            )}

            {step === 3 && (
              <>
                <div className="choices" role="group" aria-label={tr("Goals")}>
                  {data.catalog.goals.map((g) => (
                    <button key={g} type="button" className="choice" aria-pressed={form.goals.includes(g)} disabled={readOnly || (!form.goals.includes(g) && form.goals.length >= 3)} onClick={() => set("goals", toggle(form.goals, g, 3))}>
                      {GOAL_COPY()[g]?.[0] ?? g}
                      <small>{GOAL_COPY()[g]?.[1]}</small>
                    </button>
                  ))}
                </div>
                {(form.goals.includes("sign") || form.goals.includes("share")) && (
                  <div className="notice">
                    <IconShield size={16} />
                    <span>{tr("Agents can prepare documents for signature and share links. A person approves before anything is sent, and each signer signs in Ragsis.")}</span>
                  </div>
                )}
              </>
            )}

            {step === 4 && (
              <>
                <div className="ob-group">
                  <span className="label">{tr("Document types")}</span>
                  <div className="chips">
                    {data.catalog.doc_types.map((d) => (
                      <button key={d} type="button" className="chip" aria-pressed={form.doc_types.includes(d)} disabled={readOnly} onClick={() => set("doc_types", toggle(form.doc_types, d))}>
                        {tr(DOC_COPY()[d]) ?? d}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="notice info">
                  <IconArrowRight size={16} />
                  <span>{tr("You'll upload a few sample files in step 8. Connections to Drive, SharePoint and email are coming later, and only with your permission.")}</span>
                </div>
              </>
            )}

            {step === 5 && (
              <>
                <div className="ob-group">
                  <span className="label">{tr("Most sensitive data you'll upload")}</span>
                  <div className="choices" role="group" aria-label={tr("Data classification")}>
                    {CLASSES().map(([v, l, h]) => (
                      <button key={v} type="button" className="choice" aria-pressed={form.data_classification === v} disabled={readOnly} onClick={() => setForm((f) => (f ? { ...f, data_classification: v, llm_policy: v === "restricted" && f.llm_policy === "cloud_allowed" ? "local_only" : f.llm_policy } : f))}>
                        {l}
                        <small>{h}</small>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="ob-group">
                  <span className="label">{tr("Where it runs")}</span>
                  <div className="choices" role="group" aria-label={tr("Where it runs")}>
                    {DEPLOY().map(([v, l, h]) => (
                      <button key={v} type="button" className="choice" aria-pressed={form.deployment_preference === v} disabled={readOnly} onClick={() => set("deployment_preference", v)}>
                        <span className="choice-top">
                          {l}
                          {sector?.deployment.default === v && sector.code !== "other" && <span className="badge">{tr("Suggested for")}{" "}{sector.label.toLowerCase()}</span>}
                        </span>
                        <small>{h}</small>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="ob-group">
                  <span className="label">{tr("Which AI can read your documents")}</span>
                  <div className="choices" role="group" aria-label={tr("Which AI can read your documents")}>
                    {LLM().map(([v, l, h]) => (
                      <button key={v} type="button" className="choice" aria-pressed={form.llm_policy === v} disabled={readOnly || (restricted && v === "cloud_allowed")} onClick={() => set("llm_policy", v)}>
                        {l}
                        <small>{restricted && v === "cloud_allowed" ? tr("Not available for restricted data") : h}</small>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="ob-fields">
                  <div className="field">
                    <label>{tr("Where your data is stored")}</label>
                    <Select value={form.region} onChange={(v) => set("region", v)} options={REGIONS()} ariaLabel={tr("Where your data is stored")} />
                  </div>
                </div>
                {restricted && (
                  <div className="notice">
                    <IconLock size={16} />{tr("Restricted data never goes to an outside AI service. Agents will only use private AI.")}</div>
                )}
              </>
            )}

            {step === 6 && (
              <>
                <div className="check-list">
                  {spaceOptions.map((name) => {
                    const ex = existing.get(name.toLowerCase());
                    return (
                      <div className="check-item" key={name}>
                        <Checkbox checked={form.spaces.includes(name)} onChange={() => !readOnly && set("spaces", toggle(form.spaces, name))} label={<span className="sr-only">{name}</span>} />
                        <span className="meta">
                          <strong>{name}</strong>
                          <small>{ex ? tr("Already exists — we'll keep it as is") : suggestedSpaces.includes(name) ? tr("Suggested for {v1}", { v1: tr(sector?.label) ?? tr("your sector") }) : tr("Added by you")}</small>
                        </span>
                        {ex && <span className="badge">{tr("Exists")}</span>}
                      </div>
                    );
                  })}
                </div>
                <form
                  className="inline-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const n = form.newSpace.trim();
                    if (n && !form.spaces.includes(n)) setForm((f) => (f ? { ...f, spaces: [...f.spaces, n], newSpace: "" } : f));
                  }}
                >
                  <TextField placeholder={tr("Add another space, e.g. Labor")} value={form.newSpace} onChange={(e) => set("newSpace", e.target.value)} aria-label={tr("New space name")} maxLength={120} disabled={readOnly} />
                  <button type="submit" className="ghost" disabled={readOnly || !form.newSpace.trim()}>{tr("Add")}</button>
                </form>
                <p className="muted" style={{ fontSize: 13.5 }}>{tr("You can edit the new spaces. Invite your team and choose who can read or edit in")}{" "}<Link href={`/app/${org}/admin`}>{tr("Governance")}</Link>{tr(". Agents never see documents the person using them can't open.")}</p>
              </>
            )}

            {step === 7 && (
              <>
                <div className="check-list">
                  {suggested.map((s) => {
                    const t = templates.get(s.template);
                    return (
                      <div className="check-item" key={s.template} data-locked={s.blocked ? "" : undefined}>
                        {s.blocked ? <IconLock size={18} /> : <Checkbox checked={form.agents.includes(s.template)} onChange={() => !readOnly && set("agents", toggle(form.agents, s.template))} label={<span className="sr-only">{s.name}</span>} />}
                        <span className="meta">
                          <strong>{tr(s.name)}</strong>
                          <small>{tr(t?.purpose ?? s.purpose)}</small>
                          <span className="tools">
                            <span className="badge">{reasonLabel(s.reason)}</span>
                            {t?.autonomy && <span className="badge">{AUTONOMY_COPY()[t.autonomy] ?? t.autonomy}</span>}
                            {!!t?.tools.length && <span className="badge">{t.tools.length === 1 ? tr("1 action") : tr("{n} actions", { n: t.tools.length })}</span>}
                          </span>
                          {s.blocked && <small>{s.blocked}{tr(". Shown so you can plan; it can't be activated yet.")}</small>}
                        </span>
                      </div>
                    );
                  })}
                </div>
                <div className="notice info">
                  <IconShield size={16} />
                  <span>{tr("Agents are created as drafts for your new spaces. Nothing runs until you test and publish each one in Agent Studio. Existing agents are never changed.")}</span>
                </div>
              </>
            )}

            {step === 8 && (
              <>
                <div className="summary">
                  <div className="tile">
                    <h3>{tr("Documents ready")}</h3>
                    <div className="row spread">
                      <strong style={{ fontSize: 22 }}>{data.pilot.documents_indexed}</strong>
                      <button type="button" className="ghost small" onClick={() => router.push(`/app/${org}/library`)}>{tr("Upload samples")}</button>
                    </div>
                  </div>
                  <div className="tile">
                    <h3>{tr("Agent drafts")}</h3>
                    <div className="row spread">
                      <strong style={{ fontSize: 22 }}>{data.pilot.agents}</strong>
                      <button type="button" className="ghost small" onClick={() => router.push(`/app/${org}/agents`)}>{tr("Open Studio")}</button>
                    </div>
                  </div>
                  <div className="tile">
                    <h3>{tr("Successful agent tests")}</h3>
                    <strong style={{ fontSize: 22 }}>{data.pilot.passed_tests}</strong>
                  </div>
                </div>
                <form className="ob-group" onSubmit={tryQuestion}>
                  <span className="label">{tr("Try a question in")}{" "}{workspaces.find((w) => w.id === workspaceId)?.name ?? tr("this workspace")}</span>
                  <div className="inline-form">
                    <TextField placeholder={tr("e.g. What is the notice period in our standard contract?")} value={trial} onChange={(e) => setTrial(e.target.value)} aria-label={tr("Test question")} />
                    <button type="submit" className="primary" disabled={trialBusy || trial.trim().length < 2}>
                      {trialBusy ? <IconSpinner size={14} /> : null}{tr("Ask")}</button>
                  </div>
                  {trialRes && (
                    <div className="run-answer">
                      {trialRes.abstained ? <span className="muted">{tr("Not enough information in this workspace yet — upload documents and try again.")}</span> : trialRes.answer}
                      {!trialRes.abstained && <div className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>{trialRes.citations.length} {trialRes.citations.length === 1 ? "source" : "sources"}{" "}{tr("· answered in")}{" "}{duration(trialRes.latency_ms)}</div>}
                    </div>
                  )}
                </form>
              </>
            )}

            {step === 9 && (
              <>
                <div className="summary">
                  <div className="tile">
                    <h3>{tr("Profile")}</h3>
                    <ul>
                      <li>{tr(sector?.label) ?? tr("Sector not set")}{form.team_size ? tr(" · {team_size} people", { team_size: form.team_size }) : ""}</li>
                      <li>{tr("Goals:")}{" "}{form.goals.map((g) => GOAL_COPY()[g]?.[0] ?? g).join(", ") || "—"}</li>
                      <li>{tr("Data:")}{" "}{CLASSES().find(([v]) => v === form.data_classification)?.[1] ?? "—"} · {DEPLOY().find(([v]) => v === form.deployment_preference)?.[1] ?? "—"}</li>
                    </ul>
                  </div>
                  <div className="tile">
                    <h3>{tr("Search & AI")}</h3>
                    <ul>
                      <li>{rec ? tr(RAG_COPY()[rec.rag_profile]) : "—"}</li>
                      <li>{rec ? tr(MODEL_COPY()[rec.model_policy]) : "—"}</li>
                      <li>{data.provisioned.spaces.length}{" "}{tr("space(s) ·")}{" "}{data.provisioned.agents.length}{" "}{tr("agent draft(s)")}</li>
                    </ul>
                  </div>
                  <div className="tile">
                    <h3>{tr("Safety rules")}</h3>
                    <ul>
                      {(rec?.guardrails ?? []).map((g) => (
                        <li key={g}>{tr(g)}</li>
                      ))}
                    </ul>
                  </div>
                </div>
                {(rec?.warnings ?? []).map((w) => (
                  <div className="notice" key={w}>
                    <IconAlert size={16} />
                    {tr(w)}
                  </div>
                ))}
                {!readOnly && data.status !== "COMPLETED" && (
                  <Checkbox
                    checked={form.ack}
                    onChange={(v) => set("ack", v)}
                    label={tr("I understand that activating doesn't publish any agent or send anything outside (email, sharing, signatures). Each agent must be tested and published on its own.")}
                  />
                )}
                {data.status === "COMPLETED" && (
                  <div className="notice info">
                    <IconCheck size={16} />{tr("Setup is active. Change any step and it's saved; sector changes propose new suggestions without touching existing spaces or agents.")}</div>
                )}
              </>
            )}

            {error && (
              <div className="alert">
                <IconAlert size={16} />
                <span style={{ flex: 1 }}>{error}</span>
                <button type="button" className="quiet icon small" onClick={() => setError(null)} aria-label={tr("Dismiss")}>
                  <IconX size={14} />
                </button>
              </div>
            )}

            <footer className="ob-foot">
              <button type="button" className="quiet" disabled={step <= 1 || busy} onClick={() => setStep(step - 1)}>
                <IconChevronLeft size={16} />{tr("Back")}</button>
              <span className="grow" />
              {meta.skippable && !readOnly && (
                <button type="button" className="quiet" disabled={busy} onClick={() => submit("skip")}>{tr("Skip for now")}</button>
              )}
              {!readOnly && (
                <button type="button" className="primary" disabled={busy || (step === 9 && data.status === "COMPLETED")} onClick={(e) => submit("complete", e.currentTarget)}>
                  {busy ? <IconSpinner size={14} /> : step === 9 ? <IconRocket size={16} /> : null}
                  <SoftText text={step === 9 ? (data.status === "COMPLETED" ? tr("Active") : tr("Activate")) : step === 6 ? tr("Create spaces & continue") : step === 7 ? tr("Create drafts & continue") : tr("Save and continue")} />
                </button>
              )}
              {readOnly && step < 9 && (
                <button type="button" className="ghost" onClick={() => setStep(step + 1)}>{tr("Next")}</button>
              )}
            </footer>
          </section>
        </div>
      </div>
      <Toast message={notice} onDone={clearNotice} />
    </div>
  );
}

function stepTitle(n: number, sectorLabel?: string) {
  return [
    "",
    tNow("Your organization"),
    tNow("What does your organization do?"),
    tNow("What should the platform help with?"),
    sectorLabel ? tNow("Your {v1} documents", { v1: sectorLabel.toLowerCase() }) : tNow("Your documents"),
    tNow("Privacy and where your data lives"),
    tNow("Knowledge spaces"),
    tNow("Suggested agents"),
    tNow("Try it out"),
    tNow("Review and activate"),
  ][n];
}

function stepLead(n: number, docsQuestion?: string) {
  return [
    "",
    tNow("Basic details for invoices, dates and audit timestamps."),
    tNow("We tailor spaces and agents to your sector. Nothing is inferred from your company name."),
    tNow("Pick one to three. We'll suggest agents for each — all editable."),
    tNow(docsQuestion ?? "Which documents does your team work with?"),
    tNow("These choices decide which AI models can touch your data. We never loosen them automatically."),
    tNow("Spaces separate documents and permissions. Pick the suggested ones or add your own."),
    tNow("Ready-made agents for your goals and sector. Pick the ones you want; they start as drafts."),
    tNow("Upload a few documents, ask a question and try an agent before going live."),
    tNow("Check what's configured. You can change everything later from Setup."),
  ][n];
}
