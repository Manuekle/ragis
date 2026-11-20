import { NextResponse, type NextRequest } from "next/server";
import { isLocale, LOCALE_COOKIE, LOCALE_HEADER, localePath, preferredLocale, splitLocale } from "@/lib/i18n";

/**
 * Two jobs.
 *
 * 1. Spanish. /es/pricing is the same page as /pricing: the prefix is stripped, the request is
 *    rewritten to the unprefixed route and LOCALE_HEADER tells the page which language to speak
 *    (lib/locale.ts). Workspace and API routes have no Spanish version, so /es/app goes to /app.
 * 2. First visit: a browser whose Accept-Language prefers Spanish and that has not chosen a language
 *    (no LOCALE_COOKIE) is sent from the English page to its /es twin. The switch and any /es visit
 *    set the cookie, so the choice sticks and English links keep working for everyone else.
 * 3. The workspace, sign-in and signing pages (/app, /login, /sign, /connect, /s) have no /es twin: their
 *    language is the cookie's, else the browser's, passed to the page in the same header.
 * 4. With PUBLIC_SITE_ONLY=1 (the public site on Vercel, with no API behind it) the workspace,
 *    sign-in and signing routes don't exist: pages go to the waitlist and their API routes answer 404.
 *    Without the flag this part does nothing.
 */
const WORKSPACE = /^\/(app|login|connect|s|sign|api\/(auth|proxy|session|signature-guest|signature-proof))(\/|$)/;
/** Public pages that exist in both languages; the only ones the first-visit redirect applies to. */
const TRANSLATED = /^\/(waitlist(\/confirm)?|pricing|terms|privacy)?\/?$/;
/** Pages whose language comes from the cookie or the browser, not from the URL. */
const BY_PREFERENCE = /^\/(app|login|connect|s|sign)(\/|$)/;
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

  if (locale === "en" && BY_PREFERENCE.test(path)) {
    const chosen = req.cookies.get(LOCALE_COOKIE)?.value;
    const headers = new Headers(req.headers);
    headers.set(LOCALE_HEADER, isLocale(chosen) ? chosen : preferredLocale(req.headers.get("accept-language")));
    return NextResponse.next({ request: { headers } });
  }

  if (locale === "en") {
    const answer = !req.cookies.has(LOCALE_COOKIE) && req.method === "GET" && TRANSLATED.test(path) && preferredLocale(req.headers.get("accept-language")) === "es";
    if (!answer) return NextResponse.next();
    const url = req.nextUrl.clone();
    url.pathname = localePath("es", path);
    const res = NextResponse.redirect(url);
    res.cookies.set(LOCALE_COOKIE, "es", { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" });
    res.headers.set("Vary", "Accept-Language, Cookie");
    return res;
  }

  const url = req.nextUrl.clone();
  url.pathname = path;
  if (NO_SPANISH.test(path)) {
    // /es/app: the workspace has no /es twin, but the person asked for Spanish, so keep that for the app.
    const res = NextResponse.redirect(url);
    res.cookies.set(LOCALE_COOKIE, "es", { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" });
    return res;
  }
  const headers = new Headers(req.headers);
  headers.set(LOCALE_HEADER, locale);
  const res = NextResponse.rewrite(url, { request: { headers } });
  // Asking for the Spanish page is a choice: remember it, so English links don't bounce back here later.
  if (req.cookies.get(LOCALE_COOKIE)?.value !== "es") res.cookies.set(LOCALE_COOKIE, "es", { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" });
  return res;
}

export const config = {
  matcher: [
    "/es",
    "/es/:path*",
    "/",
    "/pricing",
    "/waitlist",
    "/waitlist/confirm",
    "/terms",
    "/privacy",
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
