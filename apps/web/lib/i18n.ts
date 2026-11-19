// Languages of the public site. English lives at the root (/pricing), Spanish under /es (/es/pricing).
// proxy.ts strips the /es prefix, rewrites to the same page and tells it the language through
// LOCALE_HEADER, so every page exists once and reads its words for the language it was asked in.

export const LOCALES = ["en", "es"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

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
