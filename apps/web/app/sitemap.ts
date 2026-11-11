import type { MetadataRoute } from "next";
import { absoluteUrl, PUBLIC_PAGES } from "./(public)/site";

// Read PUBLIC_BASE_URL when served, not when built (see robots.ts).
export const dynamic = "force-dynamic";

/** The indexable public pages. Badges are personal and stay out; workspace routes need a sign-in. */
export default function sitemap(): MetadataRoute.Sitemap {
  return PUBLIC_PAGES.map((page) => ({
    url: absoluteUrl(page.path),
    lastModified: new Date(`${page.updated}T00:00:00Z`),
    changeFrequency: page.priority >= 0.8 ? "weekly" : "yearly",
    priority: page.priority,
  }));
}
