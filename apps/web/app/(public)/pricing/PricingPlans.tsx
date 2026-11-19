"use client";

import { LocaleLink as Link, useLocale } from "@/components/LocaleProvider";
import { useState } from "react";
import { IconAlert, IconArrowRight, IconCheck, IconSparkles, IconSpinner } from "@/components/icons";
import { Seg, SoftText } from "@/components/motion";
import { SeatStepper } from "@/components/SeatStepper";
import { usdFor } from "@/lib/i18n";
import { annualPrice, plansFor } from "./plans";

const BILLING_PERIODS = ["Monthly", "Annual"] as const;
const TEXT = {
  en: {
    billing: "Billing period",
    periods: { Monthly: "Monthly", Annual: "Annual" },
    recommended: "Recommended",
    from: "From",
    was: (price: string) => `was ${price}`,
    year: "year",
    month: "month",
    opening: "Opening checkout…",
    start: "Get started",
    sales: "Contact sales",
    noPage: "Couldn't open the payment page. Try again.",
    noServer: "Couldn't reach the server. Check your connection.",
    localHint: (code: string) => `Approximate ${code} equivalent. You are charged in USD.`,
  },
  es: {
    billing: "Periodo de facturación",
    periods: { Monthly: "Mensual", Annual: "Anual" },
    recommended: "Recomendado",
    from: "Desde",
    was: (price: string) => `antes ${price}`,
    year: "año",
    month: "mes",
    opening: "Abriendo el pago…",
    start: "Empezar",
    sales: "Contactar con ventas",
    noPage: "No se pudo abrir la página de pago. Inténtalo de nuevo.",
    noServer: "No se pudo conectar con el servidor. Comprueba tu conexión.",
    localHint: (code: string) => `Equivalente aproximado en ${code}. El cobro es en USD.`,
  },
};

/**
 * `discount` is a holiday percent off (lib/season.ts), applied to the self-serve plans; 0 shows list prices.
 * With `checkout` on (Polar is configured) "Get started" opens the payment page for the plan and period
 * picked; otherwise it links to `startHref`. `season` is the page's own ?season= preview, passed back so
 * the checkout applies the same discount the page showed.
 */
export function PricingPlans({ salesHref, startHref, discount = 0, checkout = false, local = null, season }: { salesHref: string; startHref: string; discount?: number; checkout?: boolean; /** Visitor's currency and today's USD rate: shown as an approximate equivalent, never charged. */ local?: { currency: string; rate: number } | null; season?: string }) {
  const locale = useLocale();
  const t = TEXT[locale];
  const usd = usdFor(locale);
  // Rounded to two significant figures at most past the thousands, so a guide never looks like a quote.
  const localMoney = (amount: number) => {
    if (!local) return "";
    const raw = amount * local.rate;
    const step = raw >= 100000 ? 1000 : raw >= 10000 ? 100 : raw >= 1000 ? 10 : 1;
    return new Intl.NumberFormat(locale === "es" ? "es-ES" : "en-US", { style: "currency", currency: local.currency, maximumFractionDigits: 0, useGrouping: "always" }).format(Math.round(raw / step) * step);
  };
  const plans = plansFor(locale);
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
      setError(data.error?.message ?? t.noPage);
    } catch {
      setError(t.noServer);
    }
    setBusy(null);
  }

  return (
    <>
      <Seg className="plan-billing" role="group" aria-label={t.billing}>
        {BILLING_PERIODS.map((period) => (
          <button
            key={period}
            type="button"
            aria-pressed={billingPeriod === period}
            onClick={() => setBillingPeriod(period)}
          >
            {t.periods[period]}
          </button>
        ))}
      </Seg>

      <SeatStepper />

      <div className="plans">
        {plans.map((plan) => {
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
                    {t.recommended}
                  </span>
                )}
              </header>
              <p className="plan-blurb">{plan.blurb}</p>
              <p className="plan-price">
                <span className="plan-from">
                  {t.from}
                  {off > 0 && <span className="plan-off">-{off}%</span>}
                </span>
                {off > 0 && (
                  <s className="plan-was" aria-label={t.was(usd.format(price))}>
                    <SoftText text={usd.format(price)} />
                  </s>
                )}
                <strong>
                  <SoftText text={usd.format(finalPrice)} />
                </strong>
                <span className="plan-unit">
                  <SoftText text={`/ ${annual ? t.year : t.month} + ${plan.additionalCost}`} />
                </span>
              </p>
              {local && (
                <p className="plan-local" title={t.localHint(local.currency)}>
                  ≈ <SoftText text={`${localMoney(finalPrice)} / ${annual ? t.year : t.month}`} />
                </p>
              )}
              {checkout && !contactSales ? (
                <button type="button" className={`gate-cta plan-cta${featured ? " halftone" : " quiet"}`} disabled={busy !== null} onClick={() => subscribe(plan.id)}>
                  {busy === plan.id ? t.opening : t.start}
                  {busy === plan.id ? <IconSpinner size={16} /> : <IconArrowRight size={16} />}
                </button>
              ) : (
                <Link href={contactSales ? salesHref : startHref} className={`gate-cta plan-cta${featured ? " halftone" : " quiet"}`}>
                  {contactSales ? t.sales : t.start}
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
