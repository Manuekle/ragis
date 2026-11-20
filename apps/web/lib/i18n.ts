// Languages of the public site. English lives at the root (/pricing), Spanish under /es (/es/pricing).
// proxy.ts strips the /es prefix, rewrites to the same page and tells it the language through
// LOCALE_HEADER, so every page exists once and reads its words for the language it was asked in.

export const LOCALES = ["en", "es"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

/** Cookie that remembers the language the visitor picked (or was sent to): "en" or "es". */
export const LOCALE_COOKIE = "ragis_lang";

/**
 * The language an Accept-Language header asks for, among ours: the supported tag with the highest
 * q wins ("es-MX,es;q=0.9,en;q=0.8" is Spanish, "en-US,es;q=0.5" is English). No header, or no
 * language of ours in it, is English.
 */
export function preferredLocale(header: string | null): Locale {
  let best: { locale: Locale; q: number } | null = null;
  for (const part of (header ?? "").split(",")) {
    const [tag = "", ...params] = part.trim().split(";");
    const base = tag.trim().toLowerCase().split("-")[0];
    if (base !== "en" && base !== "es") continue;
    const qParam = params.find((p) => p.trim().startsWith("q="));
    const q = qParam ? Number.parseFloat(qParam.trim().slice(2)) : 1;
    if (Number.isNaN(q) || q <= 0) continue;
    if (!best || q > best.q) best = { locale: base, q };
  }
  return best?.locale ?? "en";
}

/** Request header proxy.ts sets on /es/* requests. Absent means English. */
export const LOCALE_HEADER = "x-ragis-locale";

export const isLocale = (value: unknown): value is Locale => typeof value === "string" && (LOCALES as readonly string[]).includes(value);

/** Open Graph locale and BCP 47 tag of each language. */
export const OG_LOCALE: Record<Locale, string> = { en: "en_US", es: "es_ES" };

/** Name of each language in itself, for the switcher. */
export const LOCALE_NAME: Record<Locale, string> = { en: "English", es: "Español" };

/** "/es/pricing" -> { locale: "es", path: "/pricing" }; anything else is English. */
export function splitLocale(pathname: string): { locale: Locale; path: string } {
  if (pathname === "/es" || pathname.startsWith("/es/")) return { locale: "es", path: pathname.slice(3) || "/" };
  return { locale: "en", path: pathname };
}

/** Paths that are not part of the public site and so have no Spanish version. */
const UNLOCALIZED = /^\/(app|api|connect|s|sign)(\/|$|\?|#)/;

/**
 * The URL of `path` in `locale`: "/pricing" -> "/es/pricing", "/#how" -> "/es#how". Absolute URLs,
 * mailto: links and workspace or API paths come back untouched.
 */
export function localePath(locale: Locale, path: string): string {
  if (locale === DEFAULT_LOCALE || !path.startsWith("/") || path.startsWith("//") || UNLOCALIZED.test(path)) return path;
  const { path: bare } = splitLocale(path); // never prefix twice
  if (bare !== path) return path;
  return bare === "/" ? "/es" : bare.startsWith("/?") || bare.startsWith("/#") ? `/es${bare.slice(1)}` : `/es${bare}`;
}

/** The other language, for the switcher. */
export const otherLocale = (locale: Locale): Locale => (locale === "en" ? "es" : "en");

/** "$149" in English; "$149" and "$12.000" in Spanish (dot for thousands). Whole dollars only. */
export function usdFor(locale: Locale) {
  const number = new Intl.NumberFormat(locale === "es" ? "es-ES" : "en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0, useGrouping: "always" });
  return { format: (amount: number) => `$${number.format(amount)}` };
}

/** Picks the words of a language out of a `{ en, es }` pair. */
export const pick = <T,>(locale: Locale, copy: Record<Locale, T>): T => copy[locale];

// The language of the page being rendered, for code that formats dates, numbers and short phrases
// outside a component (helpers, tables). LocaleProvider sets it while it renders; the workspace is
// client-rendered after its data arrives, so one value per tab is right. Components use useT/useLocale.
let current: Locale = "en";
export const setCurrentLocale = (locale: Locale) => {
  current = locale;
};
export const currentLocale = (): Locale => current;
/** BCP 47 tag for Intl and toLocale*: "es-ES" or "en-US". */
export const dateLocale = (): string => (current === "es" ? "es-ES" : "en-US");
