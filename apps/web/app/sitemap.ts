import type { MetadataRoute } from "next";
import { LOCALES, localePath } from "@/lib/i18n";
import { absoluteUrl, PUBLIC_PAGES } from "./(public)/site";

// Read PUBLIC_BASE_URL when served, not when built (see robots.ts).
export const dynamic = "force-dynamic";

/**
 * The indexable public pages, once per language, each entry listing its translations (hreflang).
 * Badges are personal and stay out; workspace routes need a sign-in.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return PUBLIC_PAGES.flatMap((page) =>
    LOCALES.map((locale) => ({
      url: absoluteUrl(localePath(locale, page.path)),
      lastModified: new Date(`${page.updated}T00:00:00Z`),
      changeFrequency: page.priority >= 0.8 ? ("weekly" as const) : ("yearly" as const),
      priority: page.priority,
      alternates: { languages: { ...Object.fromEntries(LOCALES.map((l) => [l, absoluteUrl(localePath(l, page.path))])), "x-default": absoluteUrl(page.path) } },
    })),
  );
}
