import { NextResponse } from "next/server";
import { SPONSOR_TIERS } from "@/app/(public)/waitlist/sponsors";
import { absoluteUrl } from "@/app/(public)/site";
import { clientIp, createCheckout, polarEnabled } from "@/lib/polar";
import { sponsorKey } from "@/lib/polar-catalog";
import { slotDue, takenSlots } from "@/lib/waitlist-db";

export const runtime = "nodejs";

const fail = (status: number, message: string, code?: string) => NextResponse.json({ error: { message, code } }, { status });

/**
 * Paying for a sponsor slot (lib/waitlist-db.ts → slotDue). Both calls are for the owner of a
 * badge: the badge's edit token, which only the browser that confirmed the email holds, is what
 * proves the sign-up is theirs. Without it nobody learns whether an email is on the list.
 *
 *   GET  ?slug=…   header x-badge-token   what is left to pay: { enabled, due }
 *   POST {slug, editToken}                opens a Polar checkout: { url }
 *
 * The slot is only taken when the payment arrives (api/polar/webhook), first paid first served.
 */

export async function GET(req: Request) {
  const slug = new URL(req.url).searchParams.get("slug") ?? "";
  const token = req.headers.get("x-badge-token") ?? "";
  if (!polarEnabled() || !slug || !token) return NextResponse.json({ enabled: polarEnabled(), due: null });
  try {
    const due = await slotDue(slug, token);
    if (due === "forbidden") return fail(403, "That isn't your badge.");
    const tier = due && SPONSOR_TIERS.find((t) => t.id === due.tier);
    return NextResponse.json({ enabled: true, due: tier ? { tier: tier.id, name: tier.name, price: tier.price } : null });
  } catch (err) {
    console.error("[waitlist] could not read what is left to pay:", err instanceof Error ? err.message : err);
    return fail(502, "Couldn't check your slot. Try again in a moment.");
  }
}

export async function POST(req: Request) {
  if (!polarEnabled()) return fail(503, "Online payment isn't open yet. We'll email you how to pay.", "checkout_off");

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const slug = typeof body?.slug === "string" ? body.slug : "";
  const token = typeof body?.editToken === "string" ? body.editToken : "";
  if (!slug || !token) return fail(400, "Open this from your badge page.");

  try {
    const due = await slotDue(slug, token);
    if (due === "forbidden") return fail(403, "That isn't your badge.");
    if (!due) return fail(409, "There is nothing to pay for this badge.", "nothing_due");

    const tier = SPONSOR_TIERS.find((t) => t.id === due.tier);
    if (!tier) return fail(409, "There is nothing to pay for this badge.", "nothing_due");
    const taken = (await takenSlots())[tier.id] ?? 0;
    if (taken >= tier.slots) return fail(409, `${tier.name} is full. Pick another tier.`, "tier_full");

    const { url } = await createCheckout({
      productKey: sponsorKey(tier.id),
      email: due.email,
      // The payment finds its sign-up by this id, not by email: the buyer may pay from another address.
      metadata: { ragis_kind: "sponsor", tier: tier.id, waitlist_id: String(due.waitlistId) },
      successUrl: `${absoluteUrl(`/waitlist/badge/${slug}`)}?paid=1`,
      returnUrl: absoluteUrl(`/waitlist/badge/${slug}`),
      ip: clientIp(req.headers),
    });
    return NextResponse.json({ url });
  } catch (err) {
    console.error("[waitlist] could not open a Polar checkout:", err instanceof Error ? err.message : err);
    return fail(502, "Couldn't open the payment page. Try again in a moment.");
  }
}
