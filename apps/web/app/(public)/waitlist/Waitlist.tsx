"use client";

import { useRef, useState } from "react";
import { BadgeShowcase } from "@/components/badge/BadgeShowcase";
import { DitherField } from "@/components/DitherField";
import { useLocale, useLocalePath } from "@/components/LocaleProvider";
import { IconAlert, IconArrowRight, IconBuilding, IconCheck, IconMail, IconSparkles, IconSpinner } from "@/components/icons";
import { Seg, SoftText } from "@/components/motion";
import { TextField, useFormErrors } from "@/components/ui";
import type { PublicBadge } from "@/lib/badge";
import { PayNotice } from "./PayNotice";
import { EARLY_ACCESS, REFUND_POLICY, REFUND_POLICY_ES, type SponsorTier } from "./sponsors";

const TEXT = {
  en: {
    noSave: "Couldn't save your place. Try again.",
    noServer: "Couldn't reach the server. Check your connection.",
    requested: "Slot requested.",
    onList: "You're on the list.",
    badgePaid: (tier: string, email: string) => `Your ${tier} slot shows on the badge once it is paid. Pay below to take it, and we'll write to ${email} with what comes next.`,
    badgeManual: (tier: string, email: string) => `We'll write to ${email} to confirm your ${tier} slot and how to pay. Your tier shows on the badge once the slot is confirmed.`,
    badgeFree: (email: string) => `We'll write to ${email} when your place opens. Meanwhile, this badge is yours: put your name on it and share it.`,
    inbox: "Check your inbox.",
    sentPaid: (email: string, tier: string) => `We sent a link to ${email}. Open it to confirm your email, get your badge and pay for your ${tier} slot.`,
    sentTier: (email: string, tier: string) => `We sent a link to ${email}. Open it to confirm your email, request your ${tier} slot and get your badge.`,
    sentFree: (email: string) => `We sent a link to ${email}. Open it to confirm your email, save your place and get your badge.`,
    linkFine: "The link works for 24 hours. If it doesn't arrive, look in your spam folder.",
    testA: "This server doesn't send email, so here is the link it would have sent: ",
    testB: "Confirm my email",
    other: "Use a different email",
    doneTierPaid: (email: string, tier: string) => `We'll write to ${email} with the link to pay for your ${tier} slot. Nothing has been charged.`,
    doneTier: (email: string, tier: string) => `We'll write to ${email} to confirm your ${tier} slot and how to pay. Nothing has been charged.`,
    doneFree: (email: string) => `We'll write to ${email} when your place opens.`,
    save: "Save your place",
    free: "Free",
    email: "Work email",
    company: "Company (optional)",
    companyHint: "Where you work",
    joiningFor: "I'm joining for",
    early: "Early access",
    openBadge: "Open your badge",
    saving: "Saving…",
    request: "Request my slot",
    join: "Join the waitlist",
    finePaid: "Nothing is charged yet. After you confirm your email you pay securely with Polar.",
    fineTier: "Nothing is charged now. We email you to confirm the slot and how to pay.",
    fineFree: "One email when your place opens. No newsletters.",
    secA: "Get early access. Get in ",
    secB: "first",
    secLead: "Founding packages give you the Ragis software before the public waitlist opens. Each package has a fixed number of seats so we can support every buyer.",
    recommended: "Recommended",
    oneTime: "one time",
    openOf: (open: number, slots: number) => `${open} of ${slots} open`,
    full: "Full",
    allOpen: "All open",
    taken: (n: number) => `${n} taken`,
    soldOut: "Sold out",
    selected: "Selected",
    reserve: "Reserve a slot",
    note: "A founding package is a one-time payment for early access to the Ragis software. It is not a donation or an investment: it carries no equity, no revenue share and no return.",
    noteOnline: "Prices in USD, paid once, handled by Polar. Reserving asks for your email first; a slot is yours when its payment goes through, first paid, first served. Nothing is charged before that.",
    noteManual: "Prices in USD, paid once. Reserving sends us your request. Slots are confirmed by email in the order requests arrive, and nothing is charged before that.",
  },
  es: {
    noSave: "No se pudo guardar tu lugar. Inténtalo de nuevo.",
    noServer: "No se pudo conectar con el servidor. Comprueba tu conexión.",
    requested: "Plaza solicitada.",
    onList: "Ya estás en la lista.",
    badgePaid: (tier: string, email: string) => `Tu plaza ${tier} aparece en la insignia cuando se paga. Paga abajo para asegurarla y te escribiremos a ${email} con los siguientes pasos.`,
    badgeManual: (tier: string, email: string) => `Te escribiremos a ${email} para confirmar tu plaza ${tier} y cómo pagar. Tu nivel aparece en la insignia cuando la plaza se confirma.`,
    badgeFree: (email: string) => `Te escribiremos a ${email} cuando se abra tu lugar. Mientras tanto, esta insignia es tuya: ponle tu nombre y compártela.`,
    inbox: "Revisa tu bandeja de entrada.",
    sentPaid: (email: string, tier: string) => `Hemos enviado un enlace a ${email}. Ábrelo para confirmar tu correo, conseguir tu insignia y pagar tu plaza ${tier}.`,
    sentTier: (email: string, tier: string) => `Hemos enviado un enlace a ${email}. Ábrelo para confirmar tu correo, solicitar tu plaza ${tier} y conseguir tu insignia.`,
    sentFree: (email: string) => `Hemos enviado un enlace a ${email}. Ábrelo para confirmar tu correo, guardar tu lugar y conseguir tu insignia.`,
    linkFine: "El enlace funciona durante 24 horas. Si no llega, mira en la carpeta de spam.",
    testA: "Este servidor no envía correos, así que aquí tienes el enlace que habría enviado: ",
    testB: "Confirmar mi correo",
    other: "Usar otro correo",
    doneTierPaid: (email: string, tier: string) => `Te escribiremos a ${email} con el enlace para pagar tu plaza ${tier}. No se ha cobrado nada.`,
    doneTier: (email: string, tier: string) => `Te escribiremos a ${email} para confirmar tu plaza ${tier} y cómo pagar. No se ha cobrado nada.`,
    doneFree: (email: string) => `Te escribiremos a ${email} cuando se abra tu lugar.`,
    save: "Guarda tu lugar",
    free: "Gratis",
    email: "Correo de trabajo",
    company: "Empresa (opcional)",
    companyHint: "Dónde trabajas",
    joiningFor: "Me uno para",
    early: "Acceso anticipado",
    openBadge: "Abrir tu insignia",
    saving: "Guardando…",
    request: "Solicitar mi plaza",
    join: "Unirse a la lista de espera",
    finePaid: "Todavía no se cobra nada. Cuando confirmes tu correo pagas de forma segura con Polar.",
    fineTier: "No se cobra nada ahora. Te escribimos para confirmar la plaza y cómo pagar.",
    fineFree: "Un correo cuando se abra tu lugar. Sin boletines.",
    secA: "Consigue acceso anticipado. Entra ",
    secB: "primero",
    secLead: "Los paquetes fundadores te dan el software de Ragis antes de que se abra la lista de espera pública. Cada paquete tiene un número fijo de plazas para que podamos atender a cada comprador.",
    recommended: "Recomendado",
    oneTime: "pago único",
    openOf: (open: number, slots: number) => `${open} de ${slots} libres`,
    full: "Completo",
    allOpen: "Todas libres",
    taken: (n: number) => `${n} ocupadas`,
    soldOut: "Agotado",
    selected: "Seleccionado",
    reserve: "Reservar una plaza",
    note: "Un paquete fundador es un pago único por el acceso anticipado al software de Ragis. No es una donación ni una inversión: no otorga participación en el capital, ni parte de los ingresos, ni rentabilidad alguna.",
    noteOnline: "Precios en USD, pago único, gestionado por Polar. Reservar te pide primero tu correo; la plaza es tuya cuando se completa su pago, el primero que paga, el primero que entra. No se cobra nada antes.",
    noteManual: "Precios en USD, pago único. Reservar nos envía tu solicitud. Las plazas se confirman por correo en el orden en que llegan las solicitudes, y no se cobra nada antes.",
  },
};

const badgeKey = (email: string) => `ragis:waitlist:${email.trim().toLowerCase()}`;

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0 });

/**
 * The sign-up card and the sponsor tiers share one piece of state: picking a tier further down
 * the page selects it in the form and brings the form back into view. `children` are the plain
 * sections in between (what Ragis is, who it is for), rendered on the server.
 */
export function Waitlist({ tiers, payments = false, children }: { tiers: (SponsorTier & { taken: number })[]; /** Polar is on: a sponsor slot is paid online instead of by email. */ payments?: boolean; children: React.ReactNode }) {
  const locale = useLocale();
  const t = TEXT[locale];
  const localePath = useLocalePath();
  const [interest, setInterest] = useState(EARLY_ACCESS);
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  // The server emailed a link instead of saving the place: the person confirms from their inbox.
  // `testLink` is that link itself, only on servers where no email is sent (trying it out locally).
  const [sent, setSent] = useState<{ testLink?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Set when the email was already on the list and this browser is the one that made its badge.
  const [mine, setMine] = useState<string | null>(null);
  // The badge made for this sign-up, and the token that lets this browser edit it.
  const [badge, setBadge] = useState<{ badge: PublicBadge; editToken: string } | null>(null);
  const stageRef = useRef<HTMLElement>(null);
  const form = useFormErrors();

  const tier = tiers.find((x) => x.id === interest);
  const openSlots = (x: { slots: number; taken: number }) => Math.max(x.slots - x.taken, 0);

  /** Brings the sign-up card to the middle of the screen. */
  function showStage() {
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    stageRef.current?.scrollIntoView({ behavior: calm ? "auto" : "smooth", block: "center" });
  }

  function reserve(id: string) {
    setInterest(id);
    setDone(false);
    setSent(null);
    setError(null);
    showStage();
    stageRef.current?.querySelector<HTMLInputElement>('input[name="email"]')?.focus({ preventScroll: true });
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!form.validate(e.currentTarget)) return;
    const website = new FormData(e.currentTarget).get("website");
    setBusy(true);
    setError(null);
    setMine(null);
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, company, interest, website, locale }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: string }; badge?: PublicBadge; editToken?: string; confirm?: boolean; testLink?: string };
      if (res.ok && data.confirm) {
        setSent({ testLink: data.testLink });
        // The notice is shorter than the form; keep it on screen.
        requestAnimationFrame(() => {
          const box = stageRef.current?.getBoundingClientRect();
          if (box && (box.top < 0 || box.bottom > window.innerHeight)) showStage();
        });
      } else if (res.ok) {
        const made = data.badge && data.editToken ? { badge: data.badge, editToken: data.editToken } : null;
        // Remember which badge this email got, so joining again from this browser can point back to it.
        if (made) {
          try {
            localStorage.setItem(badgeKey(email), made.badge.slug);
          } catch {}
        }
        setBadge(made);
        setDone(true);
        requestAnimationFrame(() => {
          // With a badge the stage moves to the top of the page, where the badge hangs from: go there.
          if (made) return window.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
          // The confirmation is a different size than the form; keep it on screen.
          const box = stageRef.current?.getBoundingClientRect();
          if (box && (box.top < 0 || box.bottom > window.innerHeight)) showStage();
        });
      } else {
        setError(data.error?.message ?? t.noSave);
        if (data.error?.code === "already_joined") {
          try {
            setMine(localStorage.getItem(badgeKey(email)));
          } catch {}
        }
      }
    } catch {
      setError(t.noServer);
    }
    setBusy(false);
  }

  return (
    <>
      <section ref={stageRef} id="join" className="seats-stage wl-stage">
        <DitherField className="seats-dither" pattern="waves" intensity={0.5} speed={0.4} interactive={false} color={["var(--dither-low)", "var(--dither-mid)", "var(--dither-high)"]} />

        {done && badge ? (
          <BadgeShowcase
            badge={badge.badge}
            editToken={badge.editToken}
            header={
              <div className="wl-done-head" role="status">
                <h2>
                  <span className="wl-done-mark">
                    <IconCheck size={16} strokeWidth={2.2} />
                  </span>
                  {tier ? t.requested : t.onList}
                </h2>
                <p>{tier ? (payments ? t.badgePaid(tier.name, email) : t.badgeManual(tier.name, email)) : t.badgeFree(email)}</p>
                {tier && payments && <PayNotice slug={badge.badge.slug} editToken={badge.editToken} />}
              </div>
            }
          />
        ) : sent ? (
          <div className="wl-card wl-done" role="status">
            <span className="wl-done-mark" data-kind="mail">
              <IconMail size={20} />
            </span>
            <h2>{t.inbox}</h2>
            <p>{tier ? (payments ? t.sentPaid(email, tier.name) : t.sentTier(email, tier.name)) : t.sentFree(email)}</p>
            <p className="wl-fine">{t.linkFine}</p>
            {sent.testLink && (
              <p className="wl-test">
                {t.testA}
                <a href={sent.testLink}>{t.testB}</a>
              </p>
            )}
            <button type="button" className="link" onClick={() => setSent(null)}>
              {t.other}
            </button>
          </div>
        ) : done ? (
          <div className="wl-card wl-done" role="status">
            <span className="wl-done-mark">
              <IconCheck size={20} strokeWidth={2.2} />
            </span>
            <h2>{tier ? t.requested : t.onList}</h2>
            <p>{tier ? (payments ? t.doneTierPaid(email, tier.name) : t.doneTier(email, tier.name)) : t.doneFree(email)}</p>
          </div>
        ) : (
          <form className="wl-card gate-form" onSubmit={submit} noValidate>
            <header>
              <h2>{t.save}</h2>
              <span className="wl-kind" data-tier={interest} data-sponsor={tier ? "" : undefined}>
                {tier && <IconSparkles size={13} variant="duotone" />}
                <SoftText text={tier ? `${tier.name} · ${usd.format(tier.price)}` : t.free} />
              </span>
            </header>

            <TextField label={t.email} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" autoComplete="email" icon={IconMail} {...form.field("email")} />
            <TextField label={t.company} value={company} onChange={(e) => setCompany(e.target.value)} placeholder={t.companyHint} autoComplete="organization" maxLength={120} icon={IconBuilding} {...form.field("company")} />

            {tiers.length > 0 && (
            <div className="gate-group" role="group" aria-label={t.joiningFor}>
              <span className="label">{t.joiningFor}</span>
              {/* One segmented track; the pill slides to the pick and wears that tier's mesh, like the top badge. */}
              <Seg className="wl-tiers" data-tier={interest}>
                <button type="button" aria-pressed={interest === EARLY_ACCESS} onClick={() => setInterest(EARLY_ACCESS)}>
                  {t.early}
                </button>
                {tiers.map((x) => {
                  // "Founding partner" drops its second word on phones so the four still fit on one line.
                  const [first, ...rest] = x.name.split(" ");
                  return (
                    <button key={x.id} type="button" aria-pressed={interest === x.id} disabled={openSlots(x) === 0} onClick={() => setInterest(x.id)}>
                      <span>
                        {first}
                        {rest.length > 0 && <span className="wl-chip-more"> {rest.join(" ")}</span>}
                      </span>
                    </button>
                  );
                })}
              </Seg>
            </div>
            )}

            {/* Honeypot: hidden from people and assistive tech; only bots fill it in. */}
            <input className="wl-trap" type="text" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" />

            {error && (
              <p className="wl-error" role="alert">
                <IconAlert size={14} />
                <span>
                  {error}
                  {mine && (
                    <>
                      {" "}
                      <a href={localePath(`/waitlist/badge/${mine}`)}>{t.openBadge}</a>
                    </>
                  )}
                </span>
              </p>
            )}

            <button type="submit" className="gate-cta halftone" disabled={busy}>
              {busy && <IconSpinner size={16} />}
              <SoftText text={busy ? t.saving : tier ? t.request : t.join} />
            </button>
            <p className="wl-fine">{tier ? (payments ? t.finePaid : t.fineTier) : t.fineFree}</p>
          </form>
        )}
      </section>

      {children}

      {/* Founding packages: only while they are offered (FOUNDING_PACKAGES_OPEN); the page then passes no tiers. */}
      {tiers.length > 0 && (
      <section id="sponsor" className="wl-sec">
        <h2>
          {t.secA}
          <em>{t.secB}</em>.
        </h2>
        <p className="wl-sec-lead">{t.secLead}</p>

        <div className="plans">
          {tiers.map((x) => {
            const open = openSlots(x);
            const selected = interest === x.id;
            return (
              <article key={x.id} className={`plan${x.featured ? " is-featured" : ""}`} data-selected={selected ? "" : undefined}>
                <header>
                  <h3>{x.name}</h3>
                  {x.featured && (
                    <span className="plan-badge">
                      <IconSparkles size={13} variant="duotone" />
                      {t.recommended}
                    </span>
                  )}
                </header>
                <p className="plan-blurb">{x.blurb}</p>
                <p className="plan-price">
                  <strong>{usd.format(x.price)}</strong>
                  <span className="plan-unit">{t.oneTime}</span>
                </p>

                <div className="wl-avail">
                  {/* One segment per slot on a track of the same size in every card, so the cards line up whatever the count. */}
                  <div className="wl-meter" aria-hidden="true" style={{ "--n": x.slots } as React.CSSProperties}>
                    {Array.from({ length: x.slots }, (_, i) => (
                      <i key={i} data-taken={i < x.taken ? "" : undefined} />
                    ))}
                  </div>
                  <p>
                    <span>{t.openOf(open, x.slots)}</span>
                    <span>{open === 0 ? t.full : x.taken === 0 ? t.allOpen : t.taken(x.taken)}</span>
                  </p>
                </div>

                <button type="button" className={`gate-cta plan-cta${x.featured ? " halftone" : x.premium ? " quiet premium" : " quiet"}`} disabled={open === 0} onClick={() => reserve(x.id)}>
                  {open === 0 ? t.soldOut : selected ? t.selected : t.reserve}
                  {open > 0 && (selected ? <IconCheck size={16} /> : <IconArrowRight size={16} />)}
                </button>

                <ul className="plan-features">
                  {x.perks.map((perk) => (
                    <li key={perk}>
                      <IconCheck size={12} />
                      {perk}
                    </li>
                  ))}
                </ul>
              </article>
            );
          })}
        </div>
        <p className="pub-note">
          {t.note} {locale === "es" ? REFUND_POLICY_ES : REFUND_POLICY}{" "}
          {payments ? t.noteOnline : t.noteManual}
        </p>
      </section>
      )}
    </>
  );
}
