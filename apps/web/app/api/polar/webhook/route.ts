import { NextResponse } from "next/server";
import { verifyWebhook } from "@/lib/polar";
import { parsePlanKey } from "@/lib/polar-catalog";
import { confirmSponsorPayment, releaseSponsorSlot, saveSubscription } from "@/lib/waitlist-db";

export const runtime = "nodejs";

/**
 * Polar's webhook. Register https://<site>/api/polar/webhook in Polar > Settings > Webhooks with
 * the events order.paid, order.refunded and subscription.created / .updated / .active / .canceled /
 * .uncanceled / .revoked / .past_due, and put the endpoint's secret in POLAR_WEBHOOK_SECRET.
 *
 *   order.paid         of a sponsor product: the slot is taken (first paid, first served).
 *   order.refunded     of a sponsor product, in full: the slot opens again.
 *   subscription.*     a cloud plan: stored as Polar last reported it (billing_subscriptions).
 *
 * Answers 2xx for anything it understood or can safely ignore, so Polar stops retrying. A 5xx
 * (the database is down) makes Polar deliver the event again later. Handlers are idempotent, so a
 * repeated delivery changes nothing.
 */

type Json = Record<string, unknown>;
const obj = (value: unknown): Json => (value && typeof value === "object" ? (value as Json) : {});
const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

export async function POST(req: Request) {
  // The signature covers the raw text, so read it as text and only then parse.
  const raw = await req.text();
  if (!verifyWebhook(raw, req.headers)) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });

  let event: Json;
  try {
    event = obj(JSON.parse(raw));
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const type = str(event.type) ?? "";
  const data = obj(event.data);

  try {
    if (type === "order.paid" || type === "order.refunded") await handleSponsorOrder(type, data);
    else if (type.startsWith("subscription.")) await handleSubscription(data);
  } catch (err) {
    console.error(`[polar] could not handle ${type}:`, err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Could not store the event" }, { status: 503 });
  }
  return NextResponse.json({ ok: true });
}

async function handleSponsorOrder(type: string, order: Json) {
  const metadata = obj(order.metadata);
  const key = str(obj(obj(order.product).metadata).ragis_key);
  // A sponsor order says so on the checkout we made, and on its product.
  if (metadata.ragis_kind !== "sponsor" && !key?.startsWith("sponsor:")) return;

  const orderId = str(order.id);
  if (!orderId) return;

  if (type === "order.refunded") {
    // A partial refund leaves the slot with its sponsor.
    if (order.status !== "refunded") return;
    if (await releaseSponsorSlot(orderId)) console.info(`[polar] order ${orderId} was refunded: sponsor slot released`);
    return;
  }

  const tier = str(metadata.tier) ?? key?.slice("sponsor:".length) ?? "";
  const waitlistId = Number(metadata.waitlist_id);
  if (!Number.isInteger(waitlistId) || !tier) {
    console.error(`[polar] sponsor order ${orderId} has no waitlist_id/tier in its metadata: confirm it by hand`);
    return;
  }
  const result = await confirmSponsorPayment(waitlistId, tier, orderId);
  if (result === "full" || result === "unknown") console.error(`[polar] sponsor order ${orderId} (${tier}, waitlist ${waitlistId}) could not take a slot (${result}): refund it in Polar`);
  else console.info(`[polar] sponsor order ${orderId} (${tier}): ${result}`);
}

async function handleSubscription(sub: Json) {
  const id = str(sub.id);
  const email = str(obj(sub.customer).email)?.toLowerCase();
  // The plan comes from the product we made, which is what the buyer actually bought.
  const plan = parsePlanKey(obj(obj(sub.product).metadata).ragis_key);
  if (!id || !email || !plan) return; // not one of our cloud plans

  await saveSubscription({
    id,
    customerId: str(sub.customer_id) ?? str(obj(sub.customer).id),
    email,
    plan: plan.plan,
    period: plan.period,
    status: str(sub.status) ?? "unknown",
    currentPeriodEnd: str(sub.current_period_end),
    cancelAtPeriodEnd: sub.cancel_at_period_end === true,
    modifiedAt: str(sub.modified_at) ?? str(sub.created_at) ?? new Date().toISOString(),
  });
}
