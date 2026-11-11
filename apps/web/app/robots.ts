import type { MetadataRoute } from "next";
import { absoluteUrl } from "./(public)/site";

// Read PUBLIC_BASE_URL when served, not when built: the Docker image is built once and runs on several hosts.
export const dynamic = "force-dynamic";

// Public pages are open to every crawler. The workspace, sign-in, signing links and the API stay out.
// The badge share-image route stays open: X and LinkedIn honour robots.txt when they fetch a card.
const allow = ["/", "/api/waitlist/badge/"];
// Prefix matches: "/app" alone would also block /apple-icon, so the workspace is listed as "/app$" and "/app/".
const disallow = ["/app$", "/app/", "/api/", "/login", "/connect", "/s/", "/sign", "/waitlist/confirm"];

// AI search and assistant crawlers, named so it's explicit that Ragis wants to be read and cited
// by them (generative engine optimization). They get the same rules as everyone else; a crawler
// that finds its own group ignores the "*" group, so the rules are repeated, not inherited.
const AI_CRAWLERS = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-SearchBot",
  "Claude-User",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "Applebot-Extended",
  "Bingbot",
  "DuckAssistBot",
  "Amazonbot",
  "meta-externalagent",
  "MistralAI-User",
  "CCBot",
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow, disallow },
      { userAgent: AI_CRAWLERS, allow, disallow },
    ],
    sitemap: absoluteUrl("/sitemap.xml"),
    host: absoluteUrl("/"),
  };
}
