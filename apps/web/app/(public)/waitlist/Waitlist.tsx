"use client";

import { useRef, useState } from "react";
import { BadgeShowcase } from "@/components/badge/BadgeShowcase";
import { DitherField } from "@/components/DitherField";
import { IconAlert, IconArrowRight, IconBuilding, IconCheck, IconMail, IconSparkles, IconSpinner } from "@/components/icons";
import { Seg, SoftText } from "@/components/motion";
import { TextField, useFormErrors } from "@/components/ui";
import type { PublicBadge } from "@/lib/badge";
import { EARLY_ACCESS, type SponsorTier } from "./sponsors";

const badgeKey = (email: string) => `ragis:waitlist:${email.trim().toLowerCase()}`;

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0 });

/**
 * The sign-up card and the sponsor tiers share one piece of state: picking a tier further down
 * the page selects it in the form and brings the form back into view. `children` are the plain
 * sections in between (what Ragis is, who it is for), rendered on the server.
 */
export function Waitlist({ tiers, children }: { tiers: (SponsorTier & { taken: number })[]; children: React.ReactNode }) {
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

  const tier = tiers.find((t) => t.id === interest);
  const openSlots = (t: { slots: number; taken: number }) => Math.max(t.slots - t.taken, 0);

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
        body: JSON.stringify({ email, company, interest, website }),
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
        setError(data.error?.message ?? "Couldn't save your place. Try again.");
        if (data.error?.code === "already_joined") {
          try {
            setMine(localStorage.getItem(badgeKey(email)));
          } catch {}
        }
      }
    } catch {
      setError("Couldn't reach the server. Check your connection.");
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
                  {tier ? "Slot requested." : "You're on the list."}
                </h2>
                <p>
                  {tier
                    ? `We'll write to ${email} to confirm your ${tier.name} slot and how to pay. Your tier shows on the badge once the slot is confirmed.`
                    : `We'll write to ${email} when your place opens. Meanwhile, this badge is yours: put your name on it and share it.`}
                </p>
              </div>
            }
          />
        ) : sent ? (
          <div className="wl-card wl-done" role="status">
            <span className="wl-done-mark" data-kind="mail">
              <IconMail size={20} />
            </span>
            <h2>Check your inbox.</h2>
            <p>
              {tier
                ? `We sent a link to ${email}. Open it to confirm your email, request your ${tier.name} slot and get your badge.`
                : `We sent a link to ${email}. Open it to confirm your email, save your place and get your badge.`}
            </p>
            <p className="wl-fine">The link works for 24 hours. If it doesn&apos;t arrive, look in your spam folder.</p>
            {sent.testLink && (
              <p className="wl-test">
                This server doesn&apos;t send email, so here is the link it would have sent: <a href={sent.testLink}>Confirm my email</a>
              </p>
            )}
            <button type="button" className="link" onClick={() => setSent(null)}>
              Use a different email
            </button>
          </div>
        ) : done ? (
          <div className="wl-card wl-done" role="status">
            <span className="wl-done-mark">
              <IconCheck size={20} strokeWidth={2.2} />
            </span>
            <h2>{tier ? "Slot requested." : "You're on the list."}</h2>
            <p>
              {tier
                ? `We'll write to ${email} to confirm your ${tier.name} slot and how to pay. Nothing has been charged.`
                : `We'll write to ${email} when your place opens.`}
            </p>
          </div>
        ) : (
          <form className="wl-card gate-form" onSubmit={submit} noValidate>
            <header>
              <h2>Save your place</h2>
              <span className="wl-kind" data-tier={interest} data-sponsor={tier ? "" : undefined}>
                {tier && <IconSparkles size={13} variant="duotone" />}
                <SoftText text={tier ? `${tier.name} · ${usd.format(tier.price)}` : "Free"} />
              </span>
            </header>

            <TextField label="Work email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" autoComplete="email" icon={IconMail} {...form.field("email")} />
            <TextField label="Company (optional)" value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Where you work" autoComplete="organization" maxLength={120} icon={IconBuilding} {...form.field("company")} />

            <div className="gate-group" role="group" aria-label="I'm joining for">
              <span className="label">I&apos;m joining for</span>
              {/* One segmented track; the pill slides to the pick and wears that tier's mesh, like the top badge. */}
              <Seg className="wl-tiers" data-tier={interest}>
                <button type="button" aria-pressed={interest === EARLY_ACCESS} onClick={() => setInterest(EARLY_ACCESS)}>
                  Early access
                </button>
                {tiers.map((t) => {
                  // "Founding partner" drops its second word on phones so the four still fit on one line.
                  const [first, ...rest] = t.name.split(" ");
                  return (
                    <button key={t.id} type="button" aria-pressed={interest === t.id} disabled={openSlots(t) === 0} onClick={() => setInterest(t.id)}>
                      <span>
                        {first}
                        {rest.length > 0 && <span className="wl-chip-more"> {rest.join(" ")}</span>}
                      </span>
                    </button>
                  );
                })}
              </Seg>
            </div>

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
                      <a href={`/waitlist/badge/${mine}`}>Open your badge</a>
                    </>
                  )}
                </span>
              </p>
            )}

            <button type="submit" className="gate-cta halftone" disabled={busy}>
              {busy && <IconSpinner size={16} />}
              <SoftText text={busy ? "Saving…" : tier ? "Request my slot" : "Join the waitlist"} />
            </button>
            <p className="wl-fine">{tier ? "Nothing is charged now. We email you to confirm the slot and how to pay." : "One email when your place opens. No newsletters."}</p>
          </form>
        )}
      </section>

      {children}

      <section id="sponsor" className="wl-sec">
        <h2>
          Back the build. Get in <em>first</em>.
        </h2>
        <p className="wl-sec-lead">Ragis is built by a small team. Sponsors fund the first release, and each tier has a fixed number of slots so we can keep every promise below.</p>

        <div className="plans">
          {tiers.map((t) => {
            const open = openSlots(t);
            const selected = interest === t.id;
            return (
              <article key={t.id} className={`plan${t.featured ? " is-featured" : ""}`} data-selected={selected ? "" : undefined}>
                <header>
                  <h3>{t.name}</h3>
                  {t.featured && (
                    <span className="plan-badge">
                      <IconSparkles size={13} variant="duotone" />
                      Recommended
                    </span>
                  )}
                </header>
                <p className="plan-blurb">{t.blurb}</p>
                <p className="plan-price">
                  <strong>{usd.format(t.price)}</strong>
                  <span className="plan-unit">one time</span>
                </p>

                <div className="wl-avail">
                  {/* One segment per slot on a track of the same size in every card, so the cards line up whatever the count. */}
                  <div className="wl-meter" aria-hidden="true" style={{ "--n": t.slots } as React.CSSProperties}>
                    {Array.from({ length: t.slots }, (_, i) => (
                      <i key={i} data-taken={i < t.taken ? "" : undefined} />
                    ))}
                  </div>
                  <p>
                    <span>
                      <strong>{open}</strong> of {t.slots} open
                    </span>
                    <span>{open === 0 ? "Full" : t.taken === 0 ? "All open" : `${t.taken} taken`}</span>
                  </p>
                </div>

                <button type="button" className={`gate-cta plan-cta${t.featured ? " halftone" : t.premium ? " quiet premium" : " quiet"}`} disabled={open === 0} onClick={() => reserve(t.id)}>
                  {open === 0 ? "Sold out" : selected ? "Selected" : "Reserve a slot"}
                  {open > 0 && (selected ? <IconCheck size={16} /> : <IconArrowRight size={16} />)}
                </button>

                <ul className="plan-features">
                  {t.perks.map((perk) => (
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
        <p className="pub-note">Prices in USD, paid once. Reserving sends us your request. Slots are confirmed by email in the order requests arrive, and nothing is charged before that.</p>
      </section>
    </>
  );
}
