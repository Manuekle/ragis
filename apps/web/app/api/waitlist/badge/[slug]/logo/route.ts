import { NextResponse } from "next/server";
import { LOGO_MAX_BYTES, LOGO_MAX_PX } from "@/lib/badge";
import { badgeLogo, type Logo, pngSize } from "@/lib/badge-logo";
import { findBadge, setBadgeLogo } from "@/lib/waitlist-db";

export const runtime = "nodejs";

type Params = { params: Promise<{ slug: string }> };

const fail = (status: number, message: string) => NextResponse.json({ error: { message } }, { status });

/**
 * The logo of one badge (the owner's upload, otherwise the company's icon), served from our
 * origin so the 3D texture can draw it. Looked up by badge, not by domain, so this is not an
 * open image proxy.
 */
export async function GET(req: Request, { params }: Params) {
  let logo: Logo | null;
  try {
    const badge = await findBadge((await params).slug);
    logo = badge ? await badgeLogo(badge) : null;
  } catch (err) {
    // A failed lookup must not stick in the browser cache: the next view tries again.
    console.warn("[badge] logo unavailable:", err instanceof Error ? err.message : err);
    return new Response(null, { status: 503, headers: { "cache-control": "no-store" } });
  }
  if (!logo) return new Response(null, { status: 404, headers: { "cache-control": "public, max-age=3600" } });
  // Uploads are addressed with ?v=<date>, so that URL never changes content. The bare URL can
  // (the owner may upload later), so it is only kept for a short while.
  const versioned = new URL(req.url).searchParams.has("v");
  return new Response(logo.bytes, {
    headers: {
      "content-type": logo.type,
      "cache-control": versioned ? "public, max-age=31536000, immutable" : "public, max-age=300",
      "x-content-type-options": "nosniff",
    },
  });
}

async function answer(change: () => ReturnType<typeof setBadgeLogo>) {
  try {
    const result = await change();
    if (result === "forbidden") return fail(403, "This badge can only be changed from the browser that made it.");
    if (!result) return fail(404, "Badge not found.");
    return NextResponse.json({ badge: result });
  } catch (err) {
    console.error("[badge] could not save the logo:", err instanceof Error ? err.message : err);
    return fail(502, "Couldn't save your logo. Try again in a moment.");
  }
}

/**
 * The owner uploads their company logo. The browser has already turned whatever file they
 * picked into a small PNG; anything that is not exactly that (wrong type, too big) is refused,
 * so the only thing ever stored and served back is a plain PNG image.
 */
export async function PUT(req: Request, { params }: Params) {
  const token = req.headers.get("x-badge-token") ?? "";
  if (!token) return fail(400, "Couldn't read that. Try again.");
  if (Number(req.headers.get("content-length") ?? 0) > LOGO_MAX_BYTES) return fail(413, "That image is too large. Try a smaller one.");

  const bytes = new Uint8Array(await req.arrayBuffer().catch(() => new ArrayBuffer(0)));
  if (bytes.byteLength > LOGO_MAX_BYTES) return fail(413, "That image is too large. Try a smaller one.");
  const size = pngSize(bytes);
  if (!size || size.width < 1 || size.height < 1 || size.width > LOGO_MAX_PX || size.height > LOGO_MAX_PX) return fail(400, "That file isn't an image we can use. Try a PNG, JPG or SVG.");

  const { slug } = await params;
  // The browser looked at the pixels and says whether this is a solid square picture (see toLogoPng).
  const fill = new URL(req.url).searchParams.get("fill") === "1";
  return answer(() => setBadgeLogo(slug, token, bytes, fill));
}

/** The owner removes their logo; the badge goes back to the company's icon, or initials. */
export async function DELETE(req: Request, { params }: Params) {
  const token = req.headers.get("x-badge-token") ?? "";
  if (!token) return fail(400, "Couldn't read that. Try again.");
  const { slug } = await params;
  return answer(() => setBadgeLogo(slug, token, null));
}
