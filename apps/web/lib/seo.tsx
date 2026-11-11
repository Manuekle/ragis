import type { Metadata } from "next";
import { absoluteUrl, site, siteUrl } from "@/app/(public)/site";
import { PLANS, PRICE_RANGE } from "@/app/(public)/pricing/plans";

/**
 * Search, share-card and AI-crawler metadata for the public pages.
 *
 * Next merges metadata shallowly, so a page that sets `openGraph` drops the layout's. Every public
 * page goes through `pageMetadata` instead, which always writes the full set: canonical link,
 * Open Graph and the X card. The share image itself comes from the `opengraph-image.tsx` next to
 * each page (lib/og.tsx draws them).
 */
export function pageMetadata({ title, description, path, absoluteTitle = false }: { title: string; description: string; path: string; absoluteTitle?: boolean }): Metadata {
  return {
    title: absoluteTitle ? { absolute: title } : title,
    description,
    alternates: { canonical: path },
    openGraph: {
      type: "website",
      siteName: site.name,
      locale: "en_US",
      url: path,
      title,
      description,
    },
    // X reads og:image when twitter:image is missing, so the one share image serves both.
    twitter: { card: "summary_large_image", title, description },
  };
}

// ───────────── structured data (schema.org JSON-LD) ─────────────
// Read by search engines for rich results and by AI assistants to describe Ragis accurately.
// Everything here must match what the page shows: no ratings, reviews or claims that aren't on it.

type Ld = Record<string, unknown>;

const id = (hash: string) => `${absoluteUrl("/")}/#${hash}`;

export function organizationLd(): Ld {
  return {
    "@type": "Organization",
    "@id": id("organization"),
    name: site.name,
    legalName: site.legalEntity,
    url: absoluteUrl("/"),
    logo: { "@type": "ImageObject", url: absoluteUrl("/logo.png"), width: 512, height: 512 },
    description: site.description,
    ...(site.contactEmail ? { email: site.contactEmail, contactPoint: { "@type": "ContactPoint", contactType: "sales", email: site.contactEmail } } : {}),
  };
}

export function websiteLd(): Ld {
  return {
    "@type": "WebSite",
    "@id": id("website"),
    url: absoluteUrl("/"),
    name: site.name,
    description: site.tagline,
    inLanguage: "en",
    publisher: { "@id": id("organization") },
  };
}

/** Ragis as a product. `detailed` lists each plan's price (the pricing page); otherwise one price range. */
export function softwareLd({ detailed = false }: { detailed?: boolean } = {}): Ld {
  return {
    "@type": "SoftwareApplication",
    "@id": id("software"),
    name: site.name,
    url: absoluteUrl("/"),
    description: site.description,
    applicationCategory: "BusinessApplication",
    applicationSubCategory: "AI document search",
    operatingSystem: "Web",
    image: absoluteUrl("/opengraph-image"),
    publisher: { "@id": id("organization") },
    featureList: [
      "Answers cited to the exact document and page",
      "Permission-aware: answers only use files the person can open",
      "Personal data (PII) redacted when documents are added",
      "Reads PDFs, Word files, slides, spreadsheets, tables, charts and scans",
      "Agents and workflows built on your documents",
      "Electronic signatures with a verifiable record",
      "Audit trail of questions, sources and model cost",
      "Single sign-on and self-hosted option",
    ],
    offers: detailed
      ? PLANS.map((plan) => ({
          "@type": "Offer",
          name: plan.name,
          description: plan.blurb,
          url: absoluteUrl("/pricing"),
          priceCurrency: "USD",
          price: plan.monthlyPrice,
          priceSpecification: { "@type": "UnitPriceSpecification", price: plan.monthlyPrice, priceCurrency: "USD", unitText: "MONTH", billingDuration: "P1M" },
        }))
      : { "@type": "AggregateOffer", priceCurrency: "USD", lowPrice: PRICE_RANGE.low, highPrice: PRICE_RANGE.high, offerCount: PLANS.length, url: absoluteUrl("/pricing") },
  };
}

export function breadcrumbLd(trail: { name: string; path: string }[]): Ld {
  return {
    "@type": "BreadcrumbList",
    itemListElement: [{ name: site.name, path: "/" }, ...trail].map((crumb, i) => ({ "@type": "ListItem", position: i + 1, name: crumb.name, item: absoluteUrl(crumb.path) })),
  };
}

export function faqLd(items: readonly { q: string; text: string }[]): Ld {
  return {
    "@type": "FAQPage",
    mainEntity: items.map(({ q, text }) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text } })),
  };
}

export function webPageLd({ path, name, description, updated }: { path: string; name: string; description: string; updated?: string }): Ld {
  return {
    "@type": "WebPage",
    "@id": `${absoluteUrl(path)}#webpage`,
    url: absoluteUrl(path),
    name,
    description,
    inLanguage: "en",
    isPartOf: { "@id": id("website") },
    ...(updated ? { dateModified: updated } : {}),
  };
}

/** One `<script type="application/ld+json">` holding every node as a graph. `<` is escaped so text can't close the tag. */
export function JsonLd({ graph }: { graph: Ld[] }) {
  const json = JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replace(/</g, "\\u003c");
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />;
}

/** The canonical origin, for places that need a URL object (metadataBase). */
export { siteUrl };
