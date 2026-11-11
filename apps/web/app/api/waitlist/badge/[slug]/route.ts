import { NextResponse } from "next/server";
import { COMPANY_MAX, isBadgeTheme, NAME_MAX } from "@/lib/badge";
import { type BadgeChanges, findBadge, publicBadge, updateBadge } from "@/lib/waitlist-db";

export const runtime = "nodejs";

const fail = (status: number, message: string) => NextResponse.json({ error: { message } }, { status });

/** Plain one-line text: control characters out, spaces collapsed, cut to `max`. */
function line(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/\s+/g, " ").trim().slice(0, max);
}

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const badge = await findBadge((await params).slug).catch(() => null);
  return badge ? NextResponse.json({ badge: publicBadge(badge) }) : fail(404, "Badge not found.");
}

/** The owner edits the name or company; their browser also reports which look (light or dark) it shows. Needs the token handed out at sign-up. */
export async function PATCH(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const token = typeof body?.token === "string" ? body.token : "";
  if (!body || !token) return fail(400, "Couldn't read that. Try again.");

  const changes: BadgeChanges = { name: line(body.name, NAME_MAX), company: line(body.company, COMPANY_MAX) };
  if (body.theme !== undefined) {
    if (!isBadgeTheme(body.theme)) return fail(400, "Couldn't read that. Try again.");
    changes.theme = body.theme;
  }

  try {
    const result = await updateBadge(slug, token, changes);
    if (result === "forbidden") return fail(403, "This badge can only be changed from the browser that made it.");
    if (!result) return fail(404, "Badge not found.");
    return NextResponse.json({ badge: result });
  } catch (err) {
    console.error("[badge] could not update:", err instanceof Error ? err.message : err);
    return fail(502, "Couldn't save your badge. Try again in a moment.");
  }
}
