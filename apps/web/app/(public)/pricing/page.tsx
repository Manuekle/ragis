import Link from "next/link";
import { IconArrowRight, IconCheck } from "@/components/icons";
import { breadcrumbLd, JsonLd, pageMetadata, softwareLd, webPageLd } from "@/lib/seo";
import { PubTitle } from "../PubTitle";
import { demoCta, pageUpdated, salesHref, signInHref } from "../site";
import { EVERY_PLAN, PRICE_RANGE } from "./plans";
import { PricingPlans } from "./PricingPlans";

const DESCRIPTION = `Ragis plans start at $${PRICE_RANGE.low} a month: Team Cloud, Business Cloud, Private Cloud and self-hosted. Every plan cites the page and respects who can see what.`;

export const metadata = pageMetadata({ title: `Pricing: plans from $${PRICE_RANGE.low} a month`, description: DESCRIPTION, path: "/pricing" });


export default function PricingPage() {
  return (
    <div className="gate-col pub-col pub-col-wide">
      <JsonLd graph={[webPageLd({ path: "/pricing", name: "Ragis pricing", description: DESCRIPTION, updated: pageUpdated("/pricing") }), softwareLd({ detailed: true }), breadcrumbLd([{ name: "Pricing", path: "/pricing" }])]} />
      <i className="gate-beam" data-line="left" aria-hidden="true" />
      <i className="gate-beam" data-line="right" aria-hidden="true" />

      <PubTitle
        title={
          <>
            Pricing that grows
            <br />
            with your <em>corpus</em>.
          </>
        }
        lead="Every plan answers with citations and respects who can see what. Pick by how much you index and ask."
        art="pricing"
      />

      <div className="pub-body">
        <PricingPlans salesHref={salesHref} startHref={signInHref} />

        <section className="plan-wide">
          <div>
            <h2>Self-hosted</h2>
            <p>Run Ragis on your own infrastructure with local models. Annual license, implementation and support.</p>
          </div>
          <div className="plan-wide-actions">
            {demoCta && (
              <a href={demoCta.href} className="gate-cta quiet premium plan-cta">
                {demoCta.label}
              </a>
            )}
            <Link href={salesHref} className="gate-cta quiet plan-cta">
              Contact sales
              <IconArrowRight size={16} />
            </Link>
          </div>
        </section>

        <section className="plan-all">
          <h2>In every plan</h2>
          <ul className="gate-checks">
            {EVERY_PLAN.map((f) => (
              <li key={f}>
                <IconCheck size={12} />
                {f}
              </li>
            ))}
          </ul>
        </section>

        <p className="pub-note">Prices in USD. Your order form confirms the billing period, final price, quotas and any one-time setup fee.</p>
      </div>
    </div>
  );
}
