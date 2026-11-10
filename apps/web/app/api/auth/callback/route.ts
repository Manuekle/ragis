import { timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { authMode, discovery, FLOW_COOKIE, oidcConfig, SESSION_COOKIE, secureCookies, verifyIdToken } from "@/lib/oidc";

export const dynamic = "force-dynamic";

const fail = (base: string, code: string) => NextResponse.redirect(`${base}/login?error=${encodeURIComponent(code)}`, 302);

export async function GET(req: Request) {
  if (authMode() !== "oidc") return NextResponse.json({ error: { code: "not_found" } }, { status: 404 });
  const cfg = oidcConfig();
  const params = new URL(req.url).searchParams;
  const jar = await cookies();
  const raw = jar.get(FLOW_COOKIE)?.value;
  jar.delete({ name: FLOW_COOKIE, path: "/api/auth" });
  if (params.get("error")) return fail(cfg.base, "idp_error");
  if (!raw) return fail(cfg.base, "flow_expired");
  const flow = JSON.parse(raw) as { verifier: string; state: string; nonce: string; returnTo: string };
  const state = params.get("state") ?? "";
  if (state.length !== flow.state.length || !timingSafeEqual(Buffer.from(state), Buffer.from(flow.state))) {
    return fail(cfg.base, "state_mismatch");
  }
  const code = params.get("code");
  if (!code) return fail(cfg.base, "missing_code");

  const { doc } = await discovery();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: cfg.redirectUri,
    client_id: cfg.clientId,
    code_verifier: flow.verifier,
  });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (cfg.clientSecret) {
    headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(cfg.clientId)}:${encodeURIComponent(cfg.clientSecret)}`).toString("base64")}`;
  }
  const tokenRes = await fetch(doc.token_endpoint, { method: "POST", headers, body, cache: "no-store" });
  if (!tokenRes.ok) return fail(cfg.base, "token_exchange_failed");
  const tokens = (await tokenRes.json()) as { id_token?: string };
  if (!tokens.id_token) return fail(cfg.base, "missing_id_token");
  let exp: number;
  try {
    const payload = await verifyIdToken(tokens.id_token, flow.nonce);
    exp = payload.exp ?? Math.floor(Date.now() / 1000) + 3600;
  } catch {
    return fail(cfg.base, "invalid_id_token");
  }
  // La API valida el mismo id_token (iss/aud/firma) en cada llamada; el navegador nunca lo ve.
  const res = NextResponse.redirect(`${cfg.base}${flow.returnTo}`, 302);
  res.cookies.set(SESSION_COOKIE, tokens.id_token, {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: "lax",
    path: "/",
    maxAge: Math.max(60, exp - Math.floor(Date.now() / 1000)),
  });
  return res;
}
