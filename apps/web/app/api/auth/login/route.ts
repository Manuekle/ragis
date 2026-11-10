import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { authMode, discovery, FLOW_COOKIE, oidcConfig, safeReturnTo, secureCookies } from "@/lib/oidc";

export const dynamic = "force-dynamic";

/** Inicio del Authorization Code Flow con PKCE (S256), state y nonce. */
export async function GET(req: Request) {
  if (authMode() !== "oidc") return NextResponse.json({ error: { code: "not_found" } }, { status: 404 });
  const cfg = oidcConfig();
  const { doc } = await discovery();
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(24).toString("base64url");
  const nonce = randomBytes(24).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const returnTo = safeReturnTo(new URL(req.url).searchParams.get("returnTo"));
  const url = new URL(doc.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: cfg.scopes,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  const res = NextResponse.redirect(url.toString(), 302);
  // SameSite=Lax: el callback llega como navegación top-level desde el IdP.
  res.cookies.set(FLOW_COOKIE, JSON.stringify({ verifier, state, nonce, returnTo }), {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: "lax",
    path: "/api/auth",
    maxAge: 600,
  });
  return res;
}
