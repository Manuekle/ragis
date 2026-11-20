import { NextResponse } from "next/server";
import { companyDomain } from "@/lib/badge-logo";
import { confirmSignUp, newBadge } from "@/lib/waitlist-db";

export const runtime = "nodejs";

const fail = (status: number, message: string) => NextResponse.json({ error: { message } }, { status });

const MSG = {
  en: {
    incomplete: "This link isn't complete. Open it again from the email.",
    expired: "This link has expired or was already used. Join again and we'll send you a new one.",
    closed: "The waitlist isn't open yet. Try again soon.",
    save: "Couldn't save your place. Try again in a moment.",
  },
  es: {
    incomplete: "Este enlace está incompleto. Ábrelo de nuevo desde el correo.",
    expired: "Este enlace ha caducado o ya se usó. Únete de nuevo y te enviaremos uno nuevo.",
    closed: "La lista de espera todavía no está abierta. Inténtalo de nuevo pronto.",
    save: "No se pudo guardar tu lugar. Inténtalo de nuevo en un momento.",
  },
};

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
  const m = MSG[body?.locale === "es" ? "es" : "en"];
  if (!token || token.length > 200) return fail(400, m.incomplete);

  try {
    const done = await confirmSignUp(token, (email) => newBadge(companyDomain(email)));
    if (done === "expired") return fail(410, m.expired);
    if (!done) return fail(503, m.closed);
    return NextResponse.json({ ok: true, state: done.result, email: done.email, interest: done.interest, badge: done.badge, editToken: done.editToken });
  } catch (err) {
    console.error("[waitlist] could not confirm:", err instanceof Error ? err.message : err);
    return fail(502, m.save);
  }
}
