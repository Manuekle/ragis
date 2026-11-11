"use client";

import Link from "next/link";
import { useState, type CSSProperties } from "react";
import type { SponsorTier } from "@/app/(public)/waitlist/sponsors";
import { IconArrowRight, IconArrowUpRight, IconPlus } from "@/components/icons";
import { Avatar, grainVars } from "@/components/ui";
import type { WallSponsor } from "@/lib/waitlist-db";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0 });

/**
 * The landing's wall of sponsors: every slot of every tier, taken or not. Seats shrink with the
 * tier (founding partners get a card with their logo and a link, backers a logo tile, supporters a
 * round seat with their name listed below), and an open seat is a rounded dotted outline, so the
 * wall reads as "this many places, this many still yours" even before anyone has taken one.
 */
export function SponsorWall({ tiers, sponsors }: { tiers: SponsorTier[]; sponsors: WallSponsor[] }) {
  // Top tier first: the wall narrows from five cards to fifty seats.
  const ordered = [...tiers].sort((a, b) => b.price - a.price);
  return (
    <div className="sw">
      {ordered.map((tier) => (
        <Tier key={tier.id} tier={tier} taken={sponsors.filter((s) => s.tier === tier.id)} />
      ))}
    </div>
  );
}

type Kind = "card" | "tile" | "seat";

function kindOf(tier: SponsorTier): Kind {
  return tier.id === "founding" ? "card" : tier.id === "backer" ? "tile" : "seat";
}

const ANONYMOUS = "Anonymous";

/** The name a sponsor goes by on the wall: the company for companies, the person for supporters. */
function labelOf(s: WallSponsor, kind: Kind): string {
  const first = kind === "seat" ? s.name || s.company : s.company || s.name;
  return first || ANONYMOUS;
}

/** Supporters thanked by name; the ones who left their badge blank are counted, not named "Anonymous". */
function thanks(names: string[], tier: SponsorTier): string {
  const named = names.filter((n) => n !== ANONYMOUS);
  const unnamed = names.length - named.length;
  const rest = unnamed === 0 ? [] : unnamed === 1 ? [`one more ${tier.name.toLowerCase()}`] : [`${unnamed} more ${tier.name.toLowerCase()}s`];
  return list([...named, ...rest]);
}

function Tier({ tier, taken }: { tier: SponsorTier; taken: WallSponsor[] }) {
  const kind = kindOf(tier);
  const open = Math.max(tier.slots - taken.length, 0);
  const names = kind === "seat" ? taken.map((s) => labelOf(s, kind)) : [];

  return (
    <section className="sw-tier" data-kind={kind} aria-labelledby={`sw-${tier.id}`}>
      <header className="sw-head">
        <h3 id={`sw-${tier.id}`}>
          {tier.name}s<span className="sw-price">{usd.format(tier.price)}</span>
        </h3>
        {open > 0 ? (
          <Link href="/waitlist#sponsor" className="sw-take">
            {open === tier.slots ? `All ${tier.slots} open` : `${open} of ${tier.slots} open`}
            <IconArrowRight size={12} />
          </Link>
        ) : (
          <span className="sw-full">All taken</span>
        )}
      </header>

      <ul className="sw-grid">
        {taken.map((s) => (
          <Taken key={s.number} sponsor={s} kind={kind} />
        ))}
        {/* Open seats click through to the sponsor tiers too, but stay out of the tab order and the
            accessibility tree: the tier's own link above says the same once, not fifty times. */}
        {Array.from({ length: open }, (_, i) => (
          <li key={`open-${i}`} className="sw-slot is-open" aria-hidden="true">
            <Link href="/waitlist#sponsor" className="sw-open" tabIndex={-1}>
              <Dots rx={kind === "seat" ? "50%" : kind === "card" ? 15 : 11} />
              {kind === "card" && (
                <span className="sw-open-label">
                  <IconPlus size={13} />
                  Your logo here
                </span>
              )}
              {kind === "tile" && <IconPlus size={12} />}
            </Link>
          </li>
        ))}
      </ul>
      {/* the seats are too small to carry a name, so supporters are thanked by name underneath */}
      {names.length > 0 && <p className="sw-names">Thank you, {thanks(names, tier)}.</p>}
      <p className="sr-only">
        {taken.length} of {tier.slots} {tier.name.toLowerCase()} places taken.
      </p>
    </section>
  );
}

function Taken({ sponsor, kind }: { sponsor: WallSponsor; kind: Kind }) {
  const label = labelOf(sponsor, kind);
  if (kind === "seat")
    return (
      <li className="sw-slot is-taken" title={label}>
        <Avatar name={`${label}-${sponsor.number}`} size="sm" />
      </li>
    );

  const body = (
    <>
      <Mark sponsor={sponsor} label={label} />
      <span className="sw-name">{label}</span>
      {sponsor.href && <IconArrowUpRight size={12} className="sw-out" />}
    </>
  );
  return (
    <li className="sw-slot is-taken" title={kind === "tile" ? label : undefined}>
      {sponsor.href ? (
        <a href={sponsor.href} className="sw-link" target="_blank" rel="noopener">
          {body}
        </a>
      ) : (
        <div className="sw-link">{body}</div>
      )}
    </li>
  );
}

/** The sponsor's logo on a white tile (or edge to edge when it is a solid square), else their initials. */
function Mark({ sponsor, label }: { sponsor: WallSponsor; label: string }) {
  const [failed, setFailed] = useState(false);
  if (sponsor.logoUrl && !failed)
    return (
      <span className={`sw-logo${sponsor.logoFill ? " is-fill" : ""}`}>
        {/* eslint-disable-next-line @next/next/no-img-element -- same-origin badge logo, already sized */}
        <img src={sponsor.logoUrl} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
      </span>
    );
  return (
    <span className="sw-logo grain-tile is-initials" style={grainVars(label) as CSSProperties} aria-hidden="true">
      <span>{initials(label)}</span>
    </span>
  );
}

/**
 * A rounded dotted outline. Drawn in SVG rather than as a CSS dotted border so the dots stay round,
 * spaced out, and can march when the tier's link is hovered. `rx` is the slot's corner radius less
 * the 1px the outline sits inside its edge ("50%" makes a circle of a square).
 */
function Dots({ rx }: { rx: number | string }) {
  return (
    <svg className="sw-dots" aria-hidden="true">
      <rect x="0" y="0" width="100%" height="100%" rx={rx} />
    </svg>
  );
}

function initials(label: string): string {
  const words = label.split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? "") + (words[1]?.[0] ?? "")).toUpperCase() || "·";
}

/** "A", "A and B", "A, B and C". */
function list(names: string[]): string {
  if (names.length < 2) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
