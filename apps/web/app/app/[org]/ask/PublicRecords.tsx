"use client";

import type { Citation, PublicSourcesSettings, PublicSourcesSummary } from "@/lib/api";
import { IconChevronDown, IconGlobalSearch, IconGlobe, IconLandmark, IconLock } from "@/components/icons";
import { Flag, hasFlag } from "@/components/flags";
import { CommandGroup, CommandItem, ComposerMenu, useComposerMenu } from "./ComposerMenu";

/**
 * Public records in Ask (ADR-036). `null` = off (documents only), "default" = the organization's country,
 * a country code, or "global" (worldwide: web search and global registries only).
 */
export type PublicChoice = null | "default" | "global" | string;

const STORE = (org: string) => `ragis.public-records.${org}`;

export function loadChoice(org: string): PublicChoice {
  try {
    const v = window.localStorage.getItem(STORE(org));
    return v ? v : null;
  } catch {
    return null;
  }
}

export function saveChoice(org: string, v: PublicChoice) {
  try {
    if (v) window.localStorage.setItem(STORE(org), v);
    else window.localStorage.removeItem(STORE(org));
  } catch {
    /* private window: the choice just isn't remembered */
  }
}

export const usable = (s: PublicSourcesSettings | null): s is PublicSourcesSettings => !!s && s.available && s.enabled;

const countryName = (s: PublicSourcesSettings, code: string | null) => s.countries.find((c) => c.code === code)?.name ?? null;

/** What the chip says next to "Public records". */
function valueLabel(s: PublicSourcesSettings, v: PublicChoice): string {
  if (!v) return "off";
  if (v === "global") return "worldwide";
  if (v === "default") return countryName(s, s.country) ?? (s.web ? "web" : "on");
  return countryName(s, v) ?? "on";
}

/** Request fields for the query: nothing when off. */
export function requestFields(s: PublicSourcesSettings | null, v: PublicChoice): { public_sources?: true; country?: string } {
  if (!usable(s) || !v) return {};
  if (v === "default") return { public_sources: true };
  return { public_sources: true, country: v };
}

export function PublicRecordsPicker({ settings, value, onChange, disabled }: { settings: PublicSourcesSettings; value: PublicChoice; onChange: (v: PublicChoice) => void; disabled?: boolean }) {
  const state = useComposerMenu();
  const { menu, onTriggerKey } = state;
  const pick = (v: PublicChoice) => {
    onChange(v);
    menu.close();
  };
  const home = settings.country;
  const homeName = countryName(settings, home);
  const others = settings.countries.filter((c) => c.code !== home);
  const out = settings.remaining <= 0;
  // The chip shows the flag of the country being checked; the globe when off, worldwide or no country.
  const chosen = value === "default" ? home : value && value !== "global" ? value : null;
  return (
    <div className="cmenu-host" ref={menu.ref}>
      <span className={`date-chip fmt-chip${value ? " is-set" : ""}`} data-tip={value || menu.isOpen ? undefined : "Also check official public records and the web"}>
        <button type="button" className="date-trigger" aria-haspopup="menu" aria-expanded={menu.isOpen} onClick={menu.toggle} onKeyDown={onTriggerKey} disabled={disabled}>
          {chosen && hasFlag(chosen) ? <Flag code={chosen} size={16} /> : <IconGlobalSearch size={15} />}
          Public records
          <span className="date-value">{valueLabel(settings, value)}</span>
          <IconChevronDown size={13} />
        </button>
      </span>
      <ComposerMenu
        state={state}
        label="Public records"
        footer={out ? "Your organization has used this month's lookups. Answers will use your documents only." : "Names and keywords from your question go to Croma, a public-records service. Your documents never do."}
      >
        <CommandGroup>
          <CommandItem icon={<IconLock size={16} />} title="Off" hint="Answer only from your documents" checked={!value} onClick={() => pick(null)} />
          {home && (
            <CommandItem
              bare
              icon={hasFlag(home) ? <Flag code={home} size={26} /> : <IconLandmark size={16} />}
              title={homeName ?? home.toUpperCase()}
              hint={`Companies, court cases, laws and sanctions${settings.web ? ", plus the web" : ""}`}
              checked={value === "default" || value === home}
              onClick={() => pick("default")}
            />
          )}
          {!home && settings.web && (
            <CommandItem icon={<IconGlobalSearch size={16} />} title="On" hint="The web and worldwide registries. Name a country in your question to check its records" checked={value === "default"} onClick={() => pick("default")} />
          )}
          {settings.web && <CommandItem icon={<IconGlobe size={16} />} title="Worldwide" hint="Web search, news and worldwide company registries" checked={value === "global"} onClick={() => pick("global")} />}
        </CommandGroup>
        <CommandGroup label="Another country" grid>
          {others.map((c) => (
            <CommandItem key={c.code} bare icon={<Flag code={c.code} size={22} />} title={c.name} checked={value === c.code} onClick={() => pick(c.code)} />
          ))}
        </CommandGroup>
      </ComposerMenu>
    </div>
  );
}

/** Plain-language reason when the question asked for public records but none were checked. */
export function publicNotice(p: PublicSourcesSummary | null | undefined, cited: number): string | null {
  if (!p?.requested) return null;
  switch (p.unavailable) {
    case "off":
      return "Public records are turned off for your organization, so only your documents were used.";
    case "limit":
      return "Your organization has used this month's public record lookups, so only your documents were used.";
    case "restricted":
      return "Your organization's data is classified as restricted, so nothing is looked up outside. Only your documents were used.";
    case "not_configured":
      return "Public records aren't set up yet, so only your documents were used.";
    case "credits_exhausted":
      return "The public records service has run out of credit for this month, so only your documents were used.";
    case "rate_limited":
      return "The public records service is busy right now, so only your documents were used. Try again in a few minutes.";
    case null:
    case undefined:
      if (p.lookups === 0) return "No public record search fit this question, so only your documents were used.";
      if (cited === 0) return "Public records were checked, but none of them helped answer this question.";
      return null;
    default:
      return "The public records source didn't answer in time, so only your documents were used.";
  }
}

export function ExternalIcon({ c, size = 13, flag }: { c: Citation; size?: number; flag?: boolean }) {
  if (c.kind === "web") return <IconGlobe size={size} variant="duotone" />;
  // Chips name the register, so the country's flag tells where it is from; badges keep the "public record" icon.
  if (flag && c.country && hasFlag(c.country)) return <Flag code={c.country} size={size + 1} />;
  return <IconLandmark size={size} variant="duotone" />;
}

export function externalMeta(c: Citation): string {
  return [c.country && c.country !== "global" ? c.country_name : "", c.as_of ? `data as of ${c.as_of}` : "", c.retrieved_at ? `checked ${c.retrieved_at}` : ""].filter(Boolean).join(" · ");
}

export function ExternalBody({ c }: { c: Citation }) {
  return (
    <>
      <blockquote className="pub-snippet">{c.snippet}</blockquote>
      {c.demo && <p className="faint ai-note">Sample data: public records are in demo mode on this server.</p>}
      {c.no_match ? (
        <p className="faint ai-note">The search found nothing in this register. That doesn&apos;t rule out records elsewhere.</p>
      ) : (
        <p className="faint ai-note">{c.kind === "web" ? "A public web page, found at answer time. Check it before relying on it." : "An official public record, looked up at answer time through Croma. Check the source before relying on it."}</p>
      )}
      <div className="row spread">
        <span className="mono faint">{c.source}</span>
        {c.url && (
          <a className="btn ghost small" href={c.url} target="_blank" rel="noopener noreferrer">
            <IconGlobe size={14} />
            Open source
          </a>
        )}
      </div>
    </>
  );
}
