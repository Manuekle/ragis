import type { Metadata } from "next";
import Link from "next/link";
import { IconArrowRight, IconCheck } from "@/components/icons";
import { PubTitle } from "../PubTitle";
import { demoCta, salesHref, signInHref } from "../site";
import { PricingPlans } from "./PricingPlans";

export const metadata: Metadata = {
  title: "Pricing · Ragis",
  description: "Plans for cited, permission-aware answers over your company documents.",
};

const EVERY_PLAN = ["Answers cited to the page", "Document-level permissions", "PII redaction", "Encryption in transit and at rest", "SSO with your identity provider", "Tables, figures and scanned pages"];

export default function PricingPage() {
  return (
    <div className="gate-col pub-col pub-col-wide">
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
