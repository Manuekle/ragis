import { NextResponse } from "next/server";
import { EARLY_ACCESS, INTERESTS, SPONSOR_TIERS } from "@/app/(public)/waitlist/sponsors";
import { companyDomain } from "@/lib/badge-logo";
import { dropConfirmation, findBadge, newBadge, publicBadge, requestConfirmation, saveWaitlistEntry, takenSlots } from "@/lib/waitlist-db";
import { confirmMode, sendConfirmEmail } from "@/lib/waitlist-mail";

export const runtime = "nodejs";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const fail = (status: number, message: string, code?: string) => NextResponse.json({ error: { message, code } }, { status });
const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");

/**
 * Waitlist sign-up, stored in Turso (lib/waitlist-db.ts). Without Turso configured, development
 * logs the entry and production refuses, so a sign-up is never dropped while the page says it
 * was saved. A new sign-up answers with its badge and the token that lets this browser edit it.
 *
 * With email confirmation on (lib/waitlist-mail.ts) nothing joins the list here: the request is
 * kept aside and a link is emailed; opening it is what saves the place and makes the badge
 * (api/waitlist/confirm). The answer is the same for a new address and for one already on the
 * list, so the form never tells who has joined.
 *
 * With confirmation off, an email can still only join once. Sending it again is refused with
 * code `already_joined`, unless it asks for something different (a sponsor tier after early
 * access), which updates the request and makes no new badge. That does tell whoever types an
 * address that it is on the list, which is why confirmation is the better setup.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return fail(400, "Couldn't read that. Try again.");

  // Honeypot: people never see this field, so anything in it is a bot. Answer as if it worked.
  if (text(body.website, 200)) return NextResponse.json({ ok: true });

  const email = text(body.email, 254).toLowerCase();
  if (!EMAIL.test(email)) return fail(400, "Enter a valid email address.");
  const interest = text(body.interest, 40);
  if (!INTERESTS.includes(interest)) return fail(400, "Pick what you're joining for.");

  const entry = { email, company: text(body.company, 120), interest };

  try {
    if (interest !== EARLY_ACCESS) {
      const tier = SPONSOR_TIERS.find((t) => t.id === interest);
      const taken = (await takenSlots())[interest] ?? 0;
      if (tier && taken >= tier.slots) return fail(409, `${tier.name} is full. Pick another tier or join for early access.`);
    }
    const mode = confirmMode();
    const asked = mode === "off" ? null : await requestConfirmation(entry, mode === "email");
    if (asked === "wait") return NextResponse.json({ ok: true, confirm: true });
    if (asked) {
      const base = (process.env.PUBLIC_BASE_URL ?? new URL(req.url).origin).replace(/\/$/, "");
      const link = `${base}/waitlist/confirm?token=${asked.token}`;
      if (mode === "test") {
        console.info(`[waitlist] test mode, no email sent. Confirmation link for ${email}: ${link}`);
        return NextResponse.json({ ok: true, confirm: true, testLink: link });
      }
      try {
        await sendConfirmEmail(email, link);
      } catch (err) {
        console.error("[waitlist] could not send the confirmation email:", err instanceof Error ? err.message : err);
        // Without the email the link is lost: forget the request so trying again sends a new one.
        await dropConfirmation(email).catch(() => {});
        return fail(502, "We couldn't send the confirmation email. Try again in a moment.");
      }
      return NextResponse.json({ ok: true, confirm: true });
    }

    const badge = newBadge(companyDomain(email));
    const result = await saveWaitlistEntry(entry, badge);
    if (result === "exists") return fail(409, "This email is already on the list. We'll write to it when your place opens.", "already_joined");
    if (result === "changed") return NextResponse.json({ ok: true });
    if (result === "joined") {
      // The badge is a bonus: if it can't be read back the sign-up still counts.
      const saved = await findBadge(badge.slug).catch(() => null);
      return NextResponse.json(saved ? { ok: true, badge: publicBadge(saved), editToken: badge.editToken } : { ok: true });
    }
  } catch (err) {
    console.error("[waitlist] could not store entry:", err instanceof Error ? err.message : err);
    return fail(502, "Couldn't save your place. Try again in a moment.");
  }

  if (process.env.NODE_ENV === "production") return fail(503, "The waitlist isn't open yet. Try again soon.");
  console.info("[waitlist] Turso is not configured; entry not stored:", entry);
  return NextResponse.json({ ok: true });
}
