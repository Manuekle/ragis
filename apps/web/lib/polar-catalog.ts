// What Ragis sells in Polar, derived from the site's own price lists so the two never drift:
//
//   plans     app/(public)/pricing/plans.ts      Team and Business Cloud, monthly and annual
//   sponsors  app/(public)/waitlist/sponsors.ts  one-time waitlist slots
//   offers    lib/season.ts                      first-year holiday discounts
//
// No imports on purpose: scripts/polar-sync.mjs loads this file with plain Node to create the
// products and discounts in Polar, and lib/polar.ts uses the same keys to find them at run time.
// Every object is stored in Polar with `metadata.ragis_key` set to one of the keys below.

export const KEY_META = "ragis_key";

export type Period = "monthly" | "annual";
export type SeasonKey = "black-friday" | "holidays";

export const PERIODS: readonly Period[] = ["monthly", "annual"];
export const SEASONS: readonly SeasonKey[] = ["black-friday", "holidays"];

export const planKey = (plan: string, period: Period) => `plan:${plan}:${period}`;
export const sponsorKey = (tier: string) => `sponsor:${tier}`;
export const discountKey = (season: SeasonKey, period: Period) => `season:${season}:${period}`;

/** Reads a plan key back: "plan:team:annual" gives { plan: "team", period: "annual" }. */
export function parsePlanKey(key: unknown): { plan: string; period: Period } | null {
  const [kind, plan, period] = typeof key === "string" ? key.split(":") : [];
  return kind === "plan" && plan && (period === "monthly" || period === "annual") ? { plan, period } : null;
}

export type CatalogProduct = {
  key: string;
  name: string;
  description: string;
  /** Price in USD cents. */
  cents: number;
  /** Null for a one-time purchase. */
  interval: "month" | "year" | null;
};

export type CatalogDiscount = {
  key: string;
  name: string;
  basisPoints: number;
  /** "repeating" for twelve monthly charges, "once" for the single yearly charge. */
  duration: "repeating" | "once";
  months?: number;
  /** Product keys the discount may be applied to. */
  appliesTo: string[];
};

type PlanInput = { id: string; name: string; monthlyPrice: number; blurb: string; contactSales?: boolean };
type TierInput = { id: string; name: string; price: number; blurb: string; slots: number; perks: readonly string[] };

/**
 * What the buyer reads at checkout for a founding package: the page's own blurb and perks, the
 * number of seats, and what the purchase is not. Polar reviews these descriptions, so they say
 * what is delivered (early access to the software) and nothing else.
 */
export function tierDescription(tier: TierInput, refund?: string): string {
  return [
    tier.blurb,
    "",
    "Includes:",
    ...tier.perks.map((perk) => `- ${perk}`),
    "",
    `One-time payment, ${tier.slots} seats in total. No equity, no revenue share, no return.`,
    ...(refund ? ["", refund] : []),
  ].join("\n");
}

const OFFER_NAMES: Record<SeasonKey, string> = { "black-friday": "Black Friday offer", holidays: "Holiday offer" };

export function buildCatalog({
  plans,
  tiers,
  annualPrice,
  offers,
  refund,
}: {
  plans: readonly PlanInput[];
  tiers: readonly TierInput[];
  /** Yearly price for a monthly one, in whole USD. */
  annualPrice: (monthly: number) => number;
  /** Percent off the first year, per season. */
  offers: Record<SeasonKey, number>;
  /** The refund promise appended to each founding package's description. */
  refund?: string;
}): { products: CatalogProduct[]; discounts: CatalogDiscount[] } {
  // Plans sold with "Contact sales" have no checkout.
  const selfServe = plans.filter((plan) => !plan.contactSales);

  const products: CatalogProduct[] = [
    ...selfServe.flatMap((plan): CatalogProduct[] => [
      { key: planKey(plan.id, "monthly"), name: `Ragis ${plan.name} · Monthly`, description: plan.blurb, cents: plan.monthlyPrice * 100, interval: "month" },
      { key: planKey(plan.id, "annual"), name: `Ragis ${plan.name} · Annual`, description: plan.blurb, cents: annualPrice(plan.monthlyPrice) * 100, interval: "year" },
    ]),
    ...tiers.map((tier): CatalogProduct => ({ key: sponsorKey(tier.id), name: `Ragis Early Access · ${tier.name}`, description: tierDescription(tier, refund), cents: tier.price * 100, interval: null })),
  ];

  const discounts = SEASONS.flatMap((season) =>
    PERIODS.map(
      (period): CatalogDiscount => ({
        key: discountKey(season, period),
        name: OFFER_NAMES[season],
        basisPoints: offers[season] * 100,
        duration: period === "monthly" ? "repeating" : "once",
        months: period === "monthly" ? 12 : undefined,
        appliesTo: selfServe.map((plan) => planKey(plan.id, period)),
      }),
    ),
  );

  return { products, discounts };
}
