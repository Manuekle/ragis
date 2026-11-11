import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { cognitoPasswordLogin } from "@/lib/cognito";
import { authMode, discovery, oidcConfig, SESSION_COOKIE } from "@/lib/oidc";

export const dynamic = "force-dynamic";

/** Cierra la sesión local y, si el IdP lo soporta, también la sesión SSO (RP-initiated logout). */
export async function GET() {
  const jar = await cookies();
  const idToken = jar.get(SESSION_COOKIE)?.value;
  jar.delete(SESSION_COOKIE);
  if (authMode() !== "oidc") return NextResponse.redirect(new URL("/login", process.env.PUBLIC_BASE_URL ?? "http://localhost:3000"));
  const cfg = oidcConfig();
  // Login dentro de la app: no hay sesión en la página de Cognito que cerrar.
  if (cognitoPasswordLogin()) return NextResponse.redirect(cfg.postLogoutUri);
  const { doc } = await discovery();
  if (!doc.end_session_endpoint) return NextResponse.redirect(cfg.postLogoutUri);
  const url = new URL(doc.end_session_endpoint);
  url.search = new URLSearchParams({
    client_id: cfg.clientId,
    post_logout_redirect_uri: cfg.postLogoutUri,
    ...(idToken ? { id_token_hint: idToken } : {}),
  }).toString();
  return NextResponse.redirect(url.toString());
}
