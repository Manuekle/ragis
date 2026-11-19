import { LocaleLink as Link } from "@/components/LocaleProvider";
import { IconArrowRight, IconCandyCane, IconCheck, IconSparkles } from "@/components/icons";
import { polarEnabled } from "@/lib/polar";
import { getLocale } from "@/lib/locale";
import { currentSeason, offerEnds, offerName } from "@/lib/season";
import { breadcrumbLd, JsonLd, pageMetadata, softwareLd, webPageLd } from "@/lib/seo";
import { PubTitle } from "../PubTitle";
import { demoCta, demoLabel, pageUpdated, salesHref, signInHref } from "../site";
import { everyPlanFor, PRICE_RANGE } from "./plans";
import { PricingPlans } from "./PricingPlans";

const DESCRIPTION = {
  en: `Ragis plans start at $${PRICE_RANGE.low} a month: Team Cloud, Business Cloud, Private Cloud and self-hosted. Every plan cites the page and respects who can see what.`,
  es: `Los planes de Ragis empiezan en $${PRICE_RANGE.low} al mes: Team Cloud, Business Cloud, Private Cloud y autoalojado. Todos los planes citan la página y respetan quién puede ver qué.`,
};
const TITLE = { en: `Pricing: plans from $${PRICE_RANGE.low} a month`, es: `Precios: planes desde $${PRICE_RANGE.low} al mes` };

export async function generateMetadata() {
  const locale = await getLocale();
  return pageMetadata({ title: TITLE[locale], description: DESCRIPTION[locale], path: "/pricing", locale });
}

// Rendered per request, so a holiday offer (lib/season.ts) starts and ends on its own dates.
export const dynamic = "force-dynamic";

export default async function PricingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const locale = await getLocale();
  const es = locale === "es";
  const preview = (await searchParams).season;
  const { id: season, offer } = currentSeason(preview);
  // A candy cane for the winter holidays, sparkles for Black Friday.
  const OfferIcon = season === "holidays" ? IconCandyCane : IconSparkles;
  return (
    <div className="gate-col pub-col pub-col-wide">
      <JsonLd graph={[webPageLd({ path: "/pricing", name: es ? "Precios de Ragis" : "Ragis pricing", description: DESCRIPTION[locale], updated: pageUpdated("/pricing"), locale }), softwareLd({ detailed: true, locale }), breadcrumbLd([{ name: es ? "Precios" : "Pricing", path: "/pricing" }], locale)]} />
      <i className="gate-beam" data-line="left" aria-hidden="true" />
      <i className="gate-beam" data-line="right" aria-hidden="true" />

      <PubTitle
        title={
          <>
            {es ? "Precios que crecen" : "Pricing that grows"}
            <br />
            {es ? "con tu " : "with your "}
            <em>corpus</em>.
          </>
        }
        lead={es ? "Todos los planes responden con citas y respetan quién puede ver qué. Elige según cuánto indexas y consultas." : "Every plan answers with citations and respects who can see what. Pick by how much you index and ask."}
        art="pricing"
      />

      <div className="pub-body">
        {offer && (
          <p className="plan-offer">
            <OfferIcon size={14} variant="duotone" />
            <span>
              <strong>{offerName(offer, locale)}:</strong>{" "}
              {es ? `${offer.percent} % de descuento en tu primer año de Team o Business Cloud, hasta el ${offerEnds(offer, locale)}.` : `${offer.percent}% off your first year of Team or Business Cloud, until ${offerEnds(offer)}.`}
            </span>
          </p>
        )}

        <PricingPlans salesHref={salesHref} startHref={signInHref} discount={offer?.percent ?? 0} checkout={polarEnabled()} season={typeof preview === "string" ? preview : undefined} />

        <section className="plan-wide">
          <div>
            <h2>{es ? "Autoalojado" : "Self-hosted"}</h2>
            <p>{es ? "Ejecuta Ragis en tu propia infraestructura con modelos locales. Licencia anual, implementación y soporte." : "Run Ragis on your own infrastructure with local models. Annual license, implementation and support."}</p>
          </div>
          <div className="plan-wide-actions">
            {demoCta && (
              <a href={demoCta.href} className="gate-cta quiet premium plan-cta">
                {demoLabel(locale)}
              </a>
            )}
            <Link href={salesHref} className="gate-cta quiet plan-cta">
              {es ? "Contactar con ventas" : "Contact sales"}
              <IconArrowRight size={16} />
            </Link>
          </div>
        </section>

        <section className="plan-all">
          <h2>{es ? "En todos los planes" : "In every plan"}</h2>
          <ul className="gate-checks">
            {everyPlanFor(locale).map((f) => (
              <li key={f}>
                <IconCheck size={12} />
                {f}
              </li>
            ))}
          </ul>
        </section>

        <p className="pub-note">
          {es
            ? `Precios en USD. ${polarEnabled() ? "Los pagos los gestiona Polar, que también cobra los impuestos sobre las ventas que correspondan. " : ""}Tu formulario de pedido confirma el periodo de facturación, el precio final, las cuotas y cualquier cuota de configuración única.`
            : `Prices in USD. ${polarEnabled() ? "Payments are handled by Polar, who also collects any sales tax. " : ""}Your order form confirms the billing period, final price, quotas and any one-time setup fee.`}
          {offer &&
            (es
              ? ` La ${offerName(offer, locale).toLowerCase()} se aplica a los formularios de pedido firmados hasta el ${offerEnds(offer, locale)} y cubre los primeros doce meses; las cuotas de configuración no tienen descuento.`
              : ` The ${offer.name} applies to order forms signed by ${offerEnds(offer)} and covers the first twelve months; setup fees are not discounted.`)}
        </p>
      </div>
    </div>
  );
}
