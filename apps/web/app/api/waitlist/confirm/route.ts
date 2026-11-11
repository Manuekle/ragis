import { NextResponse } from "next/server";
import { companyDomain } from "@/lib/badge-logo";
import { confirmSignUp, newBadge } from "@/lib/waitlist-db";

export const runtime = "nodejs";

const fail = (status: number, message: string) => NextResponse.json({ error: { message } }, { status });

/**
 * The emailed link was opened and the person pressed the button on /waitlist/confirm: the
 * sign-up becomes a place on the list. This is a POST from that page, not something the link
 * does by itself, because mail scanners open every link in a message before the person does
 * and would use it up.
 *
 * Answers with the badge and the token that lets this browser edit it.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  if (!token || token.length > 200) return fail(400, "This link isn't complete. Open it again from the email.");

  try {
    const done = await confirmSignUp(token, (email) => newBadge(companyDomain(email)));
    if (done === "expired") return fail(410, "This link has expired or was already used. Join again and we'll send you a new one.");
    if (!done) return fail(503, "The waitlist isn't open yet. Try again soon.");
    return NextResponse.json({ ok: true, state: done.result, email: done.email, interest: done.interest, badge: done.badge, editToken: done.editToken });
  } catch (err) {
    console.error("[waitlist] could not confirm:", err instanceof Error ? err.message : err);
    return fail(502, "Couldn't save your place. Try again in a moment.");
  }
}
