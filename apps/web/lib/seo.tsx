import type { Metadata } from "next";
import { absoluteUrl, site, SITE_TEXT, siteUrl } from "@/app/(public)/site";
import { LOCALES, localePath, OG_LOCALE, type Locale } from "@/lib/i18n";
import { PLANS, plansFor, PRICE_RANGE } from "@/app/(public)/pricing/plans";

/**
 * Search, share-card and AI-crawler metadata for the public pages.
 *
 * Next merges metadata shallowly, so a page that sets `openGraph` drops the layout's. Every public
 * page goes through `pageMetadata` instead, which always writes the full set: canonical link,
 * Open Graph and the X card. The share image itself comes from the `opengraph-image.tsx` next to
 * each page (lib/og.tsx draws them).
 */
export function pageMetadata({ title, description, path, absoluteTitle = false, locale = "en" }: { title: string; description: string; path: string; absoluteTitle?: boolean; locale?: Locale }): Metadata {
  const url = localePath(locale, path);
  const image = locale === "es" ? `/og/es/${path === "/" ? "home" : path.slice(1)}` : null;
  return {
    title: absoluteTitle ? { absolute: title } : title,
    description,
    // One canonical per language, and each language points at the other (hreflang) so search engines
    // serve the right one. x-default is the English page.
    alternates: {
      canonical: url,
      languages: { ...Object.fromEntries(LOCALES.map((l) => [l, localePath(l, path)])), "x-default": path },
    },
    openGraph: {
      type: "website",
      siteName: site.name,
      locale: OG_LOCALE[locale],
      alternateLocale: LOCALES.filter((l) => l !== locale).map((l) => OG_LOCALE[l]),
      url,
      title,
      description,
      // English pages take the image Next generates from their opengraph-image.tsx; the Spanish ones have their own.
      ...(image ? { images: [{ url: image, width: 1200, height: 630 }] } : {}),
    },
    // X reads og:image when twitter:image is missing, so the one share image serves both.
    twitter: { card: "summary_large_image", title, description, ...(image ? { images: [image] } : {}) },
  };
}

// ───────────── structured data (schema.org JSON-LD) ─────────────
// Read by search engines for rich results and by AI assistants to describe Ragis accurately.
// Everything here must match what the page shows: no ratings, reviews or claims that aren't on it.

type Ld = Record<string, unknown>;

const id = (hash: string) => `${absoluteUrl("/")}/#${hash}`;

export function organizationLd(locale: Locale = "en"): Ld {
  return {
    "@type": "Organization",
    "@id": id("organization"),
    name: site.name,
    legalName: site.legalEntity,
    url: absoluteUrl("/"),
    logo: { "@type": "ImageObject", url: absoluteUrl("/logo.png"), width: 512, height: 512 },
    description: SITE_TEXT[locale].description,
    ...(site.contactEmail ? { email: site.contactEmail, contactPoint: { "@type": "ContactPoint", contactType: "sales", email: site.contactEmail } } : {}),
  };
}

export function websiteLd(locale: Locale = "en"): Ld {
  return {
    "@type": "WebSite",
    "@id": id("website"),
    url: absoluteUrl(localePath(locale, "/")),
    name: site.name,
    description: SITE_TEXT[locale].tagline,
    inLanguage: locale,
    publisher: { "@id": id("organization") },
  };
}

/** Ragis as a product. `detailed` lists each plan's price (the pricing page); otherwise one price range. */
export function softwareLd({ detailed = false, locale = "en" }: { detailed?: boolean; locale?: Locale } = {}): Ld {
  const es = locale === "es";
  const plans = plansFor(locale);
  return {
    "@type": "SoftwareApplication",
    "@id": id("software"),
    name: site.name,
    url: absoluteUrl(localePath(locale, "/")),
    description: SITE_TEXT[locale].description,
    applicationCategory: "BusinessApplication",
    applicationSubCategory: es ? "Búsqueda de documentos con IA" : "AI document search",
    inLanguage: locale,
    operatingSystem: "Web",
    image: absoluteUrl("/opengraph-image"),
    publisher: { "@id": id("organization") },
    featureList: es
      ? [
          "Respuestas citadas con el documento y la página exactos",
          "Respeta permisos: las respuestas solo usan archivos que la persona puede abrir",
          "Datos personales (PII) ocultos al añadir documentos",
          "Lee PDF, archivos de Word, presentaciones, hojas de cálculo, tablas, gráficos y escaneos",
          "Agentes y flujos de trabajo sobre tus documentos",
          "Firmas electrónicas con registro verificable",
          "Registro de auditoría de preguntas, fuentes y coste de los modelos",
          "Inicio de sesión único y opción de autoalojamiento",
        ]
      : [
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
      ? plans.map((plan) => ({
          "@type": "Offer",
          name: plan.name,
          description: plan.blurb,
          url: absoluteUrl(localePath(locale, "/pricing")),
          priceCurrency: "USD",
          price: plan.monthlyPrice,
          priceSpecification: { "@type": "UnitPriceSpecification", price: plan.monthlyPrice, priceCurrency: "USD", unitText: "MONTH", billingDuration: "P1M" },
        }))
      : { "@type": "AggregateOffer", priceCurrency: "USD", lowPrice: PRICE_RANGE.low, highPrice: PRICE_RANGE.high, offerCount: PLANS.length, url: absoluteUrl(localePath(locale, "/pricing")) },
  };
}

export function breadcrumbLd(trail: { name: string; path: string }[], locale: Locale = "en"): Ld {
  return {
    "@type": "BreadcrumbList",
    itemListElement: [{ name: site.name, path: "/" }, ...trail].map((crumb, i) => ({ "@type": "ListItem", position: i + 1, name: crumb.name, item: absoluteUrl(localePath(locale, crumb.path)) })),
  };
}

export function faqLd(items: readonly { q: string; text: string }[]): Ld {
  return {
    "@type": "FAQPage",
    mainEntity: items.map(({ q, text }) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text } })),
  };
}

export function webPageLd({ path, name, description, updated, locale = "en" }: { path: string; name: string; description: string; updated?: string; locale?: Locale }): Ld {
  const url = absoluteUrl(localePath(locale, path));
  return {
    "@type": "WebPage",
    "@id": `${url}#webpage`,
    url,
    name,
    description,
    inLanguage: locale,
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
