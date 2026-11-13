"use client";

import Link from "next/link";
import { useState } from "react";
import { IconArrowRight, IconCheck, IconSparkles } from "@/components/icons";
import { Seg, SoftText } from "@/components/motion";
import { SeatStepper } from "@/components/SeatStepper";
import { PLANS } from "./plans";

const BILLING_PERIODS = ["Monthly", "Annual"] as const;
const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
});

/** `discount` is a holiday percent off (lib/season.ts), applied to the self-serve plans; 0 shows list prices. */
export function PricingPlans({ salesHref, startHref, discount = 0 }: { salesHref: string; startHref: string; discount?: number }) {
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
          const off = discount > 0 && !contactSales ? discount : 0;
          const finalPrice = off ? Math.round(price * (1 - off / 100)) : price;

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
                <span className="plan-from">
                  From
                  {off > 0 && <span className="plan-off">-{off}%</span>}
                </span>
                {off > 0 && (
                  <s className="plan-was" aria-label={`was ${usd.format(price)}`}>
                    <SoftText text={usd.format(price)} />
                  </s>
                )}
                <strong>
                  <SoftText text={usd.format(finalPrice)} />
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
