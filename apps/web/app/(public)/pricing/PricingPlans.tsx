"use client";

import Link from "next/link";
import { useState } from "react";
import { IconArrowRight, IconCheck, IconSparkles } from "@/components/icons";
import { Seg, SoftText } from "@/components/motion";
import { SeatStepper } from "@/components/SeatStepper";

// Quotas mirror the `plans` table (db/migrations/0001_init.sql, graph_enabled from 0005).
// Prices are the commercial starting points from the master plan, section 19.
const PLANS = [
  {
    id: "team",
    name: "Team Cloud",
    monthlyPrice: 149,
    additionalCost: "setup",
    blurb: "For a team or department getting started.",
    features: ["3,000 queries / month", "2,000 documents · 5 GB", "50 MB per file · 500 pages per document", "Hybrid search with page citations", "30 queries / minute"],
  },
  {
    id: "business",
    name: "Business Cloud",
    monthlyPrice: 499,
    additionalCost: "setup",
    blurb: "For mid-size companies across many teams.",
    featured: true,
    features: ["20,000 queries / month", "20,000 documents · 50 GB", "100 MB per file · 2,000 pages per document", "Reranking for sharper answers", "Knowledge graph across documents", "120 queries / minute"],
  },
  {
    id: "private",
    name: "Private Cloud",
    monthlyPrice: 1500,
    additionalCost: "infrastructure",
    blurb: "A dedicated stack for sensitive data.",
    contactSales: true,
    features: ["200,000 queries / month", "200,000 documents · 500 GB", "500 MB per file · 5,000 pages per document", "Dedicated AWS account, VPC and KMS keys", "SLA and custom integrations", "600 queries / minute"],
  },
] as const;

const BILLING_PERIODS = ["Monthly", "Annual"] as const;
const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
});

export function PricingPlans({ salesHref, startHref }: { salesHref: string; startHref: string }) {
  const [billingPeriod, setBillingPeriod] = useState<(typeof BILLING_PERIODS)[number]>("Monthly");
  const annual = billingPeriod === "Annual";

  return (
    <>
      <Seg className="plan-billing" role="group" aria-label="Billing period">
        {BILLING_PERIODS.map((period) => (
          <button
            key={period}
            type="button"
            aria-pressed={billingPeriod === period}
            onClick={() => setBillingPeriod(period)}
          >
            {period}
          </button>
        ))}
      </Seg>

      <SeatStepper />

      <div className="plans">
        {PLANS.map((plan) => {
          const featured = "featured" in plan;
          const contactSales = "contactSales" in plan;
          const price = annual ? plan.monthlyPrice * 12 : plan.monthlyPrice;

          return (
            <article key={plan.id} className={`plan${featured ? " is-featured" : ""}`}>
              <header>
                <h2>{plan.name}</h2>
                {featured && (
                  <span className="plan-badge">
                    <IconSparkles size={13} variant="duotone" />
                    Recommended
                  </span>
                )}
              </header>
              <p className="plan-blurb">{plan.blurb}</p>
              <p className="plan-price">
                <span className="plan-from">From</span>
                <strong>
                  <SoftText text={usd.format(price)} />
                </strong>
                <span className="plan-unit">
                  <SoftText text={`/ ${annual ? "year" : "month"} + ${plan.additionalCost}`} />
                </span>
              </p>
              <Link href={contactSales ? salesHref : startHref} className={`gate-cta plan-cta${featured ? " halftone" : " quiet"}`}>
                {contactSales ? "Contact sales" : "Get started"}
                <IconArrowRight size={16} />
              </Link>
              <ul className="plan-features">
                {plan.features.map((feature) => (
                  <li key={feature}>
                    <IconCheck size={12} />
                    {feature}
                  </li>
                ))}
              </ul>
            </article>
          );
        })}
      </div>
    </>
  );
}
