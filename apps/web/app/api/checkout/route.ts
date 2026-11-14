import { NextResponse } from "next/server";
import { PLANS } from "@/app/(public)/pricing/plans";
import { absoluteUrl } from "@/app/(public)/site";
import { currentSeason } from "@/lib/season";
import { clientIp, createCheckout, PolarError, polarEnabled } from "@/lib/polar";
import { discountKey, PERIODS, planKey, type Period } from "@/lib/polar-catalog";

export const runtime = "nodejs";

const fail = (status: number, message: string, code?: string) => NextResponse.json({ error: { message, code } }, { status });

/**
 * Starts the payment for a cloud plan on /pricing: opens a Polar checkout for the plan and the
 * billing period the visitor picked, and answers with the page to pay on.
 *
 * The first-year holiday discount (lib/season.ts) is applied here, by the server, from the same
 * season the page used to show the price. The visitor never sends a discount: Polar's discounts
 * have no code, so only this route can apply one. If the season has a discount and Polar does not
 * have it, the checkout is refused instead of charging more than the page showed.
 *
 * Private Cloud is sold through sales, so it has no checkout. With POLAR_ACCESS_TOKEN unset the
 * page does not offer this at all (see pricing/page.tsx).
 */
export async function POST(req: Request) {
  if (!polarEnabled()) return fail(503, "Online checkout isn't open yet. Contact us to get started.", "checkout_off");

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const plan = PLANS.find((p) => p.id === body?.plan && !("contactSales" in p));
  const period = PERIODS.find((p): p is Period => p === body?.period);
  if (!plan || !period) return fail(400, "Pick a plan and a billing period.");

  // `season` is a preview from the page's own ?season=; the season module ignores it in production.
  const season = currentSeason(typeof body?.season === "string" ? body.season : undefined);
  const discount = season.offer && season.id !== "none" ? discountKey(season.id, period) : undefined;

  try {
    const { url } = await createCheckout({
      productKey: planKey(plan.id, period),
      discountKey: discount,
      metadata: { ragis_kind: "plan", plan: plan.id, period, ...(discount ? { offer: season.id } : {}) },
      successUrl: absoluteUrl("/pricing/thanks"),
      returnUrl: absoluteUrl("/pricing"),
      ip: clientIp(req.headers),
    });
    return NextResponse.json({ url });
  } catch (err) {
    console.error("[checkout] could not open a Polar checkout:", err instanceof Error ? err.message : err);
    if (err instanceof PolarError && err.code === "missing_discount") return fail(503, "This offer isn't available right now. Try again in a moment, or contact us.", "offer_unavailable");
    return fail(502, "Couldn't open the payment page. Try again in a moment.");
  }
}
