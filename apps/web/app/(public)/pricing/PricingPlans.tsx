"use client";

import Link from "next/link";
import { useState } from "react";
import { IconAlert, IconArrowRight, IconCheck, IconSparkles, IconSpinner } from "@/components/icons";
import { Seg, SoftText } from "@/components/motion";
import { SeatStepper } from "@/components/SeatStepper";
import { annualPrice, PLANS } from "./plans";

const BILLING_PERIODS = ["Monthly", "Annual"] as const;
const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
});

/**
 * `discount` is a holiday percent off (lib/season.ts), applied to the self-serve plans; 0 shows list prices.
 * With `checkout` on (Polar is configured) "Get started" opens the payment page for the plan and period
 * picked; otherwise it links to `startHref`. `season` is the page's own ?season= preview, passed back so
 * the checkout applies the same discount the page showed.
 */
export function PricingPlans({ salesHref, startHref, discount = 0, checkout = false, season }: { salesHref: string; startHref: string; discount?: number; checkout?: boolean; season?: string }) {
  const [billingPeriod, setBillingPeriod] = useState<(typeof BILLING_PERIODS)[number]>("Monthly");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const annual = billingPeriod === "Annual";

  async function subscribe(plan: string) {
    setBusy(plan);
    setError(null);
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan, period: annual ? "annual" : "monthly", season }),
      });
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: { message?: string } };
      if (res.ok && data.url) {
        window.location.assign(data.url);
        return; // leaving the page: keep the button busy
      }
      setError(data.error?.message ?? "Couldn't open the payment page. Try again.");
    } catch {
      setError("Couldn't reach the server. Check your connection.");
    }
    setBusy(null);
  }

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
          const price = annual ? annualPrice(plan.monthlyPrice) : plan.monthlyPrice;
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
              {checkout && !contactSales ? (
                <button type="button" className={`gate-cta plan-cta${featured ? " halftone" : " quiet"}`} disabled={busy !== null} onClick={() => subscribe(plan.id)}>
                  {busy === plan.id ? "Opening checkout…" : "Get started"}
                  {busy === plan.id ? <IconSpinner size={16} /> : <IconArrowRight size={16} />}
                </button>
              ) : (
                <Link href={contactSales ? salesHref : startHref} className={`gate-cta plan-cta${featured ? " halftone" : " quiet"}`}>
                  {contactSales ? "Contact sales" : "Get started"}
                  <IconArrowRight size={16} />
                </Link>
              )}
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

      {error && (
        <p className="plan-error" role="alert">
          <IconAlert size={14} />
          <span>{error}</span>
        </p>
      )}
    </>
  );
}
