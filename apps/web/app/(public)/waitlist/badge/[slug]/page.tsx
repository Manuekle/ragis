import type { Metadata } from "next";
import { LocaleLink as Link } from "@/components/LocaleProvider";
import { notFound } from "next/navigation";
import { cache } from "react";
import { BadgeShowcase } from "@/components/badge/BadgeShowcase";
import { DitherField } from "@/components/DitherField";
import { IconArrowRight } from "@/components/icons";
import { badgeLines, badgeNumber, shareText } from "@/lib/badge";
import { localePath } from "@/lib/i18n";
import { getLocale } from "@/lib/locale";
import { findBadge, publicBadge } from "@/lib/waitlist-db";
import { siteUrl } from "../../../site";
import { PayNotice } from "../../PayNotice";
import "../../waitlist.css";

type Params = { params: Promise<{ slug: string }> };

// One lookup per request, shared by the metadata and the page.
const load = cache(async (slug: string) => findBadge(slug).catch(() => null));

const base = siteUrl();

/**
 * A shared badge. The link people post on LinkedIn and X lands here; the preview card those sites
 * show comes from the image route. Badges are personal pages, so search engines are asked not to list them.
 */
export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const es = (await getLocale()) === "es";
  const locale = es ? "es" : "en";
  const badge = await load(slug);
  if (!badge) return { title: es ? "Insignia no encontrada" : "Badge not found", robots: { index: false } };
  const { title } = badgeLines(badge);
  const heading = title === "Early member" ? (es ? "Se unió a la lista de espera de Ragis" : "Joined the Ragis waitlist") : es ? `${title} se unió a la lista de espera de Ragis` : `${title} joined the Ragis waitlist`;
  const description = shareText(badge, locale);
  // The version in the URL makes LinkedIn and X fetch a fresh image after the badge changes.
  const image = { url: `/api/waitlist/badge/${slug}/image?v=${encodeURIComponent(badge.updatedAt)}`, width: 1200, height: 630, alt: `Ragis waitlist badge Nº ${badgeNumber(badge.number)}` };
  return {
    metadataBase: base,
    title: { absolute: `${heading} · Nº ${badgeNumber(badge.number)}` },
    description,
    robots: { index: false, follow: true },
    alternates: { canonical: localePath(locale, `/waitlist/badge/${slug}`) },
    openGraph: { type: "website", siteName: "Ragis", title: heading, description, url: localePath(locale, `/waitlist/badge/${slug}`), images: [image] },
    twitter: { card: "summary_large_image", title: heading, description, images: [image] },
  };
}

export default async function BadgePage({ params }: Params) {
  const { slug } = await params;
  const found = await load(slug);
  if (!found) notFound();
  const badge = publicBadge(found);
  const { title } = badgeLines(badge);
  const es = (await getLocale()) === "es";

  return (
    <div className="gate-col pub-col pub-col-wide wl">
      <i className="gate-beam" data-line="left" aria-hidden="true" />
      <i className="gate-beam" data-line="right" aria-hidden="true" />

      <section className="seats-stage wl-stage badge-page-stage">
        <DitherField className="seats-dither" pattern="waves" intensity={0.5} speed={0.4} interactive={false} color={["var(--dither-low)", "var(--dither-mid)", "var(--dither-high)"]} />
        <BadgeShowcase
          badge={badge}
          header={
            <div className="wl-done-head">
              <span className="badge-eyebrow">{es ? "Lista de espera de Ragis" : "Ragis waitlist"} · Nº {badgeNumber(badge.number)}</span>
              <h1>{title === "Early member" ? (es ? "Un miembro temprano de Ragis." : "An early member of Ragis.") : es ? `${title} está en la lista de espera de Ragis.` : `${title} is on the Ragis waitlist.`}</h1>
              {/* Only the badge's owner sees this, and only while a sponsor slot waits for its payment. */}
              <PayNotice slug={slug} />
            </div>
          }
          guest={
            <div className="badge-guest">
              <p>
                {es
                  ? "Ragis lee los documentos de una empresa y responde preguntas con la página exacta de la que sale cada respuesta. Únete a la lista de espera y consigue tu propia insignia."
                  : "Ragis reads a company's documents and answers questions with the exact page each answer came from. Join the waitlist and get a badge of your own."}
              </p>
              <Link href="/waitlist" className="gate-cta halftone">
                {es ? "Consigue tu propia insignia" : "Get your own badge"}
                <IconArrowRight size={16} />
              </Link>
            </div>
          }
        />
      </section>
    </div>
  );
}
