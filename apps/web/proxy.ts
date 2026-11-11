import { NextResponse, type NextRequest } from "next/server";

/**
 * With PUBLIC_SITE_ONLY=1 (the public site on Vercel, with no API behind it) the workspace,
 * sign-in and signing routes don't exist: pages go to the waitlist and their API routes answer 404.
 * Without the flag this does nothing.
 */
export function proxy(req: NextRequest) {
  if (process.env.PUBLIC_SITE_ONLY !== "1") return NextResponse.next();
  if (req.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: { message: "Not found" } }, { status: 404 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/waitlist";
  url.search = "";
  url.hash = "join";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    "/app/:path*",
    "/login/:path*",
    "/connect/:path*",
    "/s/:path*",
    "/sign/:path*",
    "/api/auth/:path*",
    "/api/proxy/:path*",
    "/api/session/:path*",
    "/api/signature-guest/:path*",
    "/api/signature-proof/:path*",
  ],
};
