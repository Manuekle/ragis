"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { AuthShell } from "../login/AuthShell";
import { IconAlert, IconChevronRight, IconSpinner } from "@/components/icons";
import { Skel, SkeletonStatus } from "@/components/skeletons";
import { TextField, useFormErrors, Avatar } from "@/components/ui";
import { SoftText } from "@/components/motion";

interface Me {
  user: { id: string; email: string; name: string | null };
  organizations: { id: string; name: string; slug: string; role: string; plan_id: string }[];
}

interface Catalog {
  sectors: { code: string; label: string; approach: { label: string; planned?: boolean }[]; deployment: { label: string; default: string } }[];
}

/* Calificación comercial: se pregunta aquí, antes de crear la organización, UNA pregunta por pantalla y sin scroll.
   Es información sobre la empresa, no configuración del producto (eso vive en Setup, dentro de la app). */
type Opt = [string, string];
const TEAM: Opt[] = [["1-14", "1–14"], ["15-50", "15–50"], ["51-150", "51–150"], ["151-500", "151–500"], ["500+", "500+"]];
const USERS: Opt[] = [["1-4", "1–4"], ["5-30", "5–30"], ["31-100", "31–100"], ["100+", "100+"]];
const BUYER: Opt[] = [["management", "Management"], ["department_head", "Department head"], ["it", "IT / Operations"], ["individual", "Just me"]];
const VOLUME: Opt[] = [["lt_500", "<500"], ["500_1k", "500–1k"], ["1k_10k", "1–10k"], ["10k_100k", "10–100k"], ["gt_100k", "100k+"]];
const SOURCES: Opt[] = [["shared_folders", "Shared folders"], ["servers", "File servers"], ["sharepoint", "SharePoint"], ["google_drive", "Google Drive"], ["email", "Email"], ["other", "Other"]];
const SIGNALS: Opt[] = [["repeated_search", "Repeated searching"], ["multi_source_process", "Several sources per task"], ["measurable_loss", "Measurable cost"]];
const REFERRAL: Opt[] = [
  ["google", "Google"], ["linkedin", "LinkedIn"], ["instagram", "Instagram"], ["x", "X"], ["youtube", "YouTube"], ["facebook", "Facebook"],
  ["tiktok", "TikTok"], ["whatsapp", "WhatsApp"], ["referral", "A recommendation"], ["event", "Event"], ["other", "Other"],
];
const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

interface Qual {
  sector_primary: string; team_size: string; buyer_role: string; initial_users: string; volume_estimate: string;
  document_sources: string[]; fit_signals: string[]; referral_source: string; referral_detail: string;
}
const EMPTY_QUAL: Qual = { sector_primary: "", team_size: "", buyer_role: "", initial_users: "", volume_estimate: "", document_sources: [], fit_signals: [], referral_source: "", referral_detail: "" };

/** Pantallas del alta tras el nombre. `auto`: una elección simple avanza sola. `required`: no se puede omitir. */
const SCREENS = [
  { key: "sector", title: "What's your sector?", lead: "", required: true, auto: true },
  { key: "team", title: "How big is your team?", lead: "", required: true, auto: false },
  { key: "buyer", title: "Who decides the purchase?", lead: "", required: false, auto: true },
  { key: "volume", title: "How many documents?", lead: "A rough guess is fine.", required: false, auto: true },
  { key: "sources", title: "Where do they live?", lead: "Pick all that apply.", required: false, auto: false },
  { key: "signals", title: "Sound familiar?", lead: "Pick all that apply.", required: false, auto: false },
  { key: "referral", title: "How did you find us?", lead: "", required: false, auto: false },
] as const;

function Chips({ label, items, value, onPick, multi }: { label: string; items: Opt[]; value: string | string[]; onPick: (v: string) => void; multi?: boolean }) {
  const on = (v: string) => (multi ? (value as string[]).includes(v) : value === v);
  return (
    <div className="gate-group" role="group" aria-label={label}>
      <div className="gate-chips">
        {items.map(([v, l]) => (
          <button key={v} type="button" className="gate-chip" aria-pressed={on(v)} onClick={() => onPick(v)}>
            {l}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function OrgPicker() {
  const [me, setMe] = useState<Me | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // -1 = nombre; 0..n-1 = pantallas de calificación.
  const [at, setAt] = useState(-1);
  const [q, setQ] = useState<Qual>(EMPTY_QUAL);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const form = useFormErrors();
  const setField = <K extends keyof Qual>(k: K, v: Qual[K]) => setQ((c) => ({ ...c, [k]: v }));

  useEffect(() => {
    api<Me>("me").then(setMe).catch((e) => setError(e.message));
    api<Catalog>("onboarding/catalog").then(setCatalog).catch(() => setCatalog(null));
  }, []);

  const screen = at >= 0 ? SCREENS[at]! : null;
  const last = at === SCREENS.length - 1;
  const hasOrgs = !!me?.organizations.length;

  const go = (n: number) => {
    setError(null);
    setAt(n);
  };

  async function create() {
    setBusy(true);
    try {
      // Solo viajan las respuestas dadas: todo lo demás es opcional.
      const qualification = Object.fromEntries(Object.entries(q).filter(([, v]) => (Array.isArray(v) ? v.length : v !== "")));
      const org = await api<{ id: string }>("organizations", { method: "POST", body: { name, qualification } });
      window.location.href = `/app/${org.id}/onboarding`;
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const advance = () => (last ? create() : go(at + 1));

  // Elección simple en una pantalla `auto`: guarda y pasa a la siguiente tras un instante, para que se vea la selección.
  const pick = (k: keyof Qual, v: string, auto: boolean) => {
    setField(k, v as never);
    if (auto && !last) window.setTimeout(() => setAt((cur) => (cur === at ? cur + 1 : cur)), 180);
  };

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (at === -1) {
      if (form.validate(e.currentTarget)) go(0);
      return;
    }
    if (screen!.key === "sector" && !q.sector_primary) return setError("Choose a sector to continue.");
    if (screen!.key === "team" && !q.team_size) return setError("Choose your team size to continue.");
    void advance();
  }

  const loading = !me && !error;
  const title = screen ? screen.title : hasOrgs || !me ? "Choose an organization." : "Create your organization.";
  const lead = screen ? screen.lead : hasOrgs ? "Or start a new one." : me ? "Your documents live here." : undefined;

  return (
    <AuthShell
      title={title}
      lead={lead}
      aside={
        <a href="/api/auth/logout" className="gate-link">
          Sign out
        </a>
      }
    >
      {loading && (
        <SkeletonStatus label="Loading your organizations…" className="stack">
          <Skel w={184} h={12} />
          <ul className="gate-list" aria-hidden="true">
            {[0, 1].map((i) => (
              <li key={i} className="row" style={{ gap: 12, padding: "12px 14px" }}>
                <Skel w={28} h={28} r={999} />
                <div className="meta" style={{ gap: 5 }}>
                  <Skel w={i === 0 ? 132 : 112} h={14} />
                  <Skel w={76} h={10} />
                </div>
                <Skel w={16} h={16} />
              </li>
            ))}
          </ul>
          <div className="gate-form">
            <Skel w={116} h={12} />
            <Skel h={42} r={10} />
          </div>
        </SkeletonStatus>
      )}
      {me && at === -1 && <p className="gate-note">Signed in as {me.user.email}</p>}
      {screen && (
        <div className="gate-progress" role="progressbar" aria-valuemin={1} aria-valuemax={SCREENS.length} aria-valuenow={at + 1} aria-label="Progress">
          {SCREENS.map((s, i) => (
            <i key={s.key} data-on={i <= at ? "" : undefined} />
          ))}
        </div>
      )}
      {error && (
        <div className="alert">
          <IconAlert size={16} />
          {error}
        </div>
      )}
      {hasOrgs && at === -1 && (
        <ul className="gate-list">
          {me!.organizations.map((o) => (
            <li key={o.id}>
              <a href={`/app/${o.id}/ask`}>
                <Avatar name={o.name} size="sm" />
                <span className="meta">
                  <strong>{o.name}</strong>
                  <small>
                    {o.role} · {o.plan_id}
                  </small>
                </span>
                <IconChevronRight size={16} />
              </a>
            </li>
          ))}
        </ul>
      )}
      {me && (
        <form className="gate-form" onSubmit={submit} noValidate>
          <div className="gate-screen" key={screen?.key ?? "start"}>
          {at === -1 && (
            <TextField label={hasOrgs ? "New organization" : "Organization name"} required minLength={2} placeholder="Acme Inc." value={name} onChange={(e) => setName(e.target.value)} {...form.field("orgName")} />
          )}

          {screen?.key === "sector" && (
            <Chips label="Sector" items={(catalog?.sectors ?? []).map((s): Opt => [s.code, s.label])} value={q.sector_primary} onPick={(v) => pick("sector_primary", v, true)} />
          )}

          {screen?.key === "team" && (
            <>
              <Chips label="Team size" items={TEAM} value={q.team_size} onPick={(v) => setField("team_size", v)} />
              <div className="gate-group">
                <span className="label">
                  Who starts using it? <small>optional</small>
                </span>
                <Chips label="First users" items={USERS} value={q.initial_users} onPick={(v) => setField("initial_users", v)} />
              </div>
            </>
          )}

          {screen?.key === "buyer" && <Chips label="Who decides" items={BUYER} value={q.buyer_role} onPick={(v) => pick("buyer_role", v, true)} />}
          {screen?.key === "volume" && <Chips label="Documents" items={VOLUME} value={q.volume_estimate} onPick={(v) => pick("volume_estimate", v, true)} />}
          {screen?.key === "sources" && <Chips label="Where documents live" items={SOURCES} value={q.document_sources} onPick={(v) => setField("document_sources", toggle(q.document_sources, v))} multi />}
          {screen?.key === "signals" && <Chips label="Signals" items={SIGNALS} value={q.fit_signals} onPick={(v) => setField("fit_signals", toggle(q.fit_signals, v))} multi />}
          {screen?.key === "referral" && (
            <>
              <Chips label="How did you find us" items={REFERRAL} value={q.referral_source} onPick={(v) => setField("referral_source", v)} />
              {(q.referral_source === "referral" || q.referral_source === "event") && (
                <TextField label={q.referral_source === "referral" ? "Who recommended us?" : "Which event?"} maxLength={120} value={q.referral_detail} onChange={(e) => setField("referral_detail", e.target.value)} />
              )}
            </>
          )}

          </div>

          <div className="gate-actions">
            {screen && (
              <button type="button" className="gate-cta quiet" disabled={busy} onClick={() => go(at - 1)}>
                Back
              </button>
            )}
            {screen && !screen.required && !last && (
              <button type="button" className="gate-cta quiet" disabled={busy} onClick={() => go(at + 1)}>
                Skip
              </button>
            )}
            {/* Las pantallas de elección simple avanzan solas: solo las demás necesitan botón. */}
            {(at === -1 || !screen!.auto || last) && (
              <button type="submit" className="gate-cta" disabled={busy}>
                {busy && <IconSpinner size={16} />}
                <SoftText text={last ? (busy ? "Creating…" : "Create organization") : "Continue"} />
              </button>
            )}
          </div>
        </form>
      )}
    </AuthShell>
  );
}
