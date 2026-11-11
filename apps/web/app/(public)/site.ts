// Public-site settings for the homepage, pricing and legal pages.

export const site = {
  name: "Ragis",
  legalEntity: process.env.LEGAL_ENTITY ?? "Ragis",
  contactEmail: process.env.CONTACT_EMAIL ?? null,
  /** Date shown on Terms and Privacy. Bump it whenever either text changes. */
  legalUpdated: "November 9, 2026",
  /** One line on what Ragis is: page titles, share cards, search results and AI answers all reuse it. */
  tagline: "Cited AI answers from your company documents",
  description:
    "Ragis reads your company's PDFs, Word files, slides, spreadsheets and scans, and answers questions with the exact page each claim came from. Permission-aware and PII-redacted.",
};

/**
 * Where the public site lives, for canonical links, share cards, the sitemap and llms.txt.
 * PUBLIC_BASE_URL wins (set on Vercel, the AWS pilot and in Docker); Vercel's own production
 * domain is the fallback, then local dev.
 */
export function siteUrl(): URL {
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return URL.parse(process.env.PUBLIC_BASE_URL ?? "") ?? (vercel ? URL.parse(`https://${vercel}`) : null) ?? new URL("http://localhost:3000");
}

/** Absolute URL of a path on the public site, without a trailing slash on the home page. */
export function absoluteUrl(path = "/"): string {
  return new URL(path, siteUrl()).href.replace(/\/$/, "");
}

/** The indexable public pages, in the order the sitemap and llms.txt list them. `updated` is the last real content change. */
export const PUBLIC_PAGES = [
  { path: "/", title: "Ragis", summary: "What Ragis is, how it answers from your documents with page citations, and how it keeps data private.", updated: "2026-11-10", priority: 1 },
  { path: "/pricing", title: "Pricing", summary: "Team Cloud, Business Cloud, Private Cloud and self-hosted plans, with quotas and prices.", updated: "2026-11-10", priority: 0.9 },
  { path: "/waitlist", title: "Waitlist", summary: "Join the waitlist for early access, or back the project as a sponsor.", updated: "2026-11-10", priority: 0.8 },
  { path: "/privacy", title: "Privacy Policy", summary: "What Ragis collects, why, where it is stored and how to control it.", updated: "2026-11-09", priority: 0.3 },
  { path: "/terms", title: "Terms of Service", summary: "The terms that govern use of Ragis.", updated: "2026-11-09", priority: 0.3 },
] as const;

export type PublicPath = (typeof PUBLIC_PAGES)[number]["path"];

/** When a public page's content last changed, as an ISO date. */
export function pageUpdated(path: PublicPath): string {
  return PUBLIC_PAGES.find((page) => page.path === path)!.updated;
}

/**
 * PUBLIC_SITE_ONLY=1 serves only the public pages (landing, pricing, legal, waitlist), e.g. on
 * Vercel without the API behind it. Sign-in buttons then lead to the waitlist and proxy.ts sends
 * every workspace route there too.
 */
export const publicOnly = process.env.PUBLIC_SITE_ONLY === "1";

/** Where "Sign in" and "Get started" go. */
export const signInHref = publicOnly ? "/waitlist" : "/login";
export const signInLabel = publicOnly ? "Join the waitlist" : "Sign in";

/** Where "Contact sales" goes: a mailto when CONTACT_EMAIL is set, otherwise sign-in. */
export const salesHref = site.contactEmail ? `mailto:${site.contactEmail}?subject=Ragis%20sales` : signInHref;

const bookingUrl = URL.parse(process.env.DEMO_BOOKING_URL ?? "");
const demoEmail = site.contactEmail?.trim();

export const demoCta = bookingUrl?.protocol === "https:"
  ? { label: "Book a demo", href: bookingUrl.href }
  : demoEmail
    ? { label: "Request a demo", href: `mailto:${demoEmail}?subject=Ragis%20demo%20request` }
    : null;
