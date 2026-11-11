import "server-only";
import { createRemoteJWKSet, jwtVerify } from "jose";

export const SESSION_COOKIE = "ragsis_session";
export const FLOW_COOKIE = "ragsis_oidc_flow";

export const authMode = () => (process.env.AUTH_MODE === "oidc" ? "oidc" : "dev");
export const secureCookies = () => process.env.SESSION_COOKIE_SECURE !== "false";

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
}

let cached: { at: number; doc: Discovery; jwks: ReturnType<typeof createRemoteJWKSet> } | null = null;

export function oidcConfig() {
  const issuer = process.env.OIDC_ISSUER?.replace(/\/$/, "");
  const clientId = process.env.OIDC_CLIENT_ID;
  const base = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "");
  if (!issuer || !clientId || !base) throw new Error("OIDC requiere OIDC_ISSUER, OIDC_CLIENT_ID y PUBLIC_BASE_URL");
  return {
    issuer,
    clientId,
    clientSecret: process.env.OIDC_CLIENT_SECRET || undefined,
    redirectUri: `${base}/api/auth/callback`,
    postLogoutUri: `${base}/login`,
    scopes: process.env.OIDC_SCOPES ?? "openid email profile",
    base,
  };
}

export async function discovery() {
  if (cached && Date.now() - cached.at < 3600_000) return cached;
  const { issuer } = oidcConfig();
  const res = await fetch(`${issuer}/.well-known/openid-configuration`, { cache: "no-store" });
  if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
  const doc = (await res.json()) as Discovery;
  if (doc.issuer.replace(/\/$/, "") !== issuer) throw new Error("issuer de discovery no coincide");
  cached = { at: Date.now(), doc, jwks: createRemoteJWKSet(new URL(doc.jwks_uri)) };
  return cached;
}

/** Verifica firma, issuer, audiencia (client_id), expiración y, si hubo redirección al IdP, el nonce del id_token. */
export async function verifyIdToken(idToken: string, nonce?: string) {
  const { issuer, clientId } = oidcConfig();
  const { jwks } = await discovery();
  const { payload } = await jwtVerify(idToken, jwks, { issuer, audience: clientId });
  if (nonce !== undefined && payload.nonce !== nonce) throw new Error("invalid nonce");
  if (payload.token_use !== undefined && payload.token_use !== "id") throw new Error("se requiere id_token");
  return payload;
}

/** Solo rutas relativas internas (evita open redirect). */
export function safeReturnTo(value: string | null | undefined): string {
  return value && /^\/(?!\/)[\w\-/?=&.%]*$/.test(value) ? value : "/app";
}
