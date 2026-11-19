import { NextResponse, type NextRequest } from "next/server";
import { LOCALE_HEADER, localePath, splitLocale } from "@/lib/i18n";

/**
 * Two jobs.
 *
 * 1. Spanish. /es/pricing is the same page as /pricing: the prefix is stripped, the request is
 *    rewritten to the unprefixed route and LOCALE_HEADER tells the page which language to speak
 *    (lib/locale.ts). Workspace and API routes have no Spanish version, so /es/app goes to /app.
 * 2. With PUBLIC_SITE_ONLY=1 (the public site on Vercel, with no API behind it) the workspace,
 *    sign-in and signing routes don't exist: pages go to the waitlist and their API routes answer 404.
 *    Without the flag this part does nothing.
 */
const WORKSPACE = /^\/(app|login|connect|s|sign|api\/(auth|proxy|session|signature-guest|signature-proof))(\/|$)/;
const NO_SPANISH = /^\/(app|connect|s|sign|api)(\/|$)/;

export function proxy(req: NextRequest) {
  const { locale, path } = splitLocale(req.nextUrl.pathname);
  const publicOnly = process.env.PUBLIC_SITE_ONLY === "1";

  if (publicOnly && WORKSPACE.test(path)) {
    if (path.startsWith("/api/")) return NextResponse.json({ error: { message: "Not found" } }, { status: 404 });
    const url = req.nextUrl.clone();
    url.pathname = localePath(locale, "/waitlist");
    url.search = "";
    url.hash = "join";
    return NextResponse.redirect(url);
  }

  if (locale === "en") return NextResponse.next();

  const url = req.nextUrl.clone();
  url.pathname = path;
  if (NO_SPANISH.test(path)) return NextResponse.redirect(url);
  const headers = new Headers(req.headers);
  headers.set(LOCALE_HEADER, locale);
  return NextResponse.rewrite(url, { request: { headers } });
}

export const config = {
  matcher: [
    "/es",
    "/es/:path*",
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
