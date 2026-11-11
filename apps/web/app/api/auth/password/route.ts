import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  CHALLENGE_COOKIE,
  CHALLENGE_TTL_SECONDS,
  cognitoPasswordLogin,
  confirmReset,
  friendlyError,
  requestResetCode,
  setNewPassword,
  signIn,
  type SignInOutcome,
} from "@/lib/cognito";
import { SESSION_COOKIE, secureCookies, verifyIdToken } from "@/lib/oidc";

export const dynamic = "force-dynamic";

const text = (v: unknown, max: number) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);
const error = (status: number, message: string) => NextResponse.json({ error: { message } }, { status });

/** Guarda el id_token como cookie de sesión; la API lo valida (iss/aud/firma) en cada llamada y el navegador nunca lo lee. */
async function startSession(idToken: string) {
  const payload = await verifyIdToken(idToken);
  const exp = payload.exp ?? Math.floor(Date.now() / 1000) + 3600;
  const res = NextResponse.json({ next: "/app" });
  res.cookies.set(SESSION_COOKIE, idToken, {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: "lax",
    path: "/",
    maxAge: Math.max(60, exp - Math.floor(Date.now() / 1000)),
  });
  res.cookies.delete({ name: CHALLENGE_COOKIE, path: "/api/auth" });
  return res;
}

async function finish(outcome: SignInOutcome, fallbackUsername: string) {
  const token = outcome.AuthenticationResult?.IdToken;
  if (token) return startSession(token);
  if (outcome.ChallengeName === "NEW_PASSWORD_REQUIRED" && outcome.Session) {
    // El reto vive en una cookie httpOnly de corta vida: el navegador no ve el token de sesión de Cognito.
    const res = NextResponse.json({ step: "new_password" });
    res.cookies.set(
      CHALLENGE_COOKIE,
      JSON.stringify({ session: outcome.Session, username: outcome.ChallengeParameters?.USER_ID_FOR_SRP ?? fallbackUsername }),
      { httpOnly: true, secure: secureCookies(), sameSite: "lax", path: "/api/auth", maxAge: CHALLENGE_TTL_SECONDS },
    );
    return res;
  }
  return error(502, "This account needs a step we can't do here. Ask your admin.");
}

/**
 * Inicio de sesión dentro de la app (sin la página alojada de Cognito).
 * Pasos: signin → (new_password) y forgot → reset.
 */
export async function POST(req: Request) {
  if (!cognitoPasswordLogin()) return NextResponse.json({ error: { code: "not_found" } }, { status: 404 });
  // Un formulario de otro sitio no puede enviar JSON sin preflight: corta el login cruzado.
  if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return error(415, "Unsupported request.");
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return error(400, "Invalid request.");

  const email = text(body.email, 254)?.trim().toLowerCase() ?? null;

  switch (body.step) {
    case "signin": {
      const password = text(body.password, 256);
      if (!email || !password) return error(400, "Enter your email and password.");
      const r = await signIn(email, password);
      if (!r.ok) {
        const f = friendlyError(r.code, r.message);
        return error(f.status, f.message);
      }
      return finish(r.data, email);
    }
    case "new_password": {
      const password = text(body.password, 256);
      if (!password) return error(400, "Enter a new password.");
      const raw = (await cookies()).get(CHALLENGE_COOKIE)?.value;
      let challenge: { session?: string; username?: string } = {};
      try {
        challenge = raw ? JSON.parse(raw) : {};
      } catch {
        /* cookie corrupta: se trata como vencida */
      }
      if (!challenge.session || !challenge.username) return error(410, "That took too long. Sign in again.");
      const r = await setNewPassword(challenge.username, password, challenge.session);
      if (!r.ok) {
        // Cognito responde NotAuthorizedException cuando la sesión del reto ya venció.
        if (r.code === "NotAuthorizedException") return error(410, "That took too long. Sign in again.");
        const f = friendlyError(r.code, r.message);
        return error(f.status, f.message);
      }
      return finish(r.data, challenge.username);
    }
    case "forgot": {
      if (!email) return error(400, "Enter your email.");
      const r = await requestResetCode(email);
      // Con prevent_user_existence_errors Cognito responde igual si la cuenta no existe; solo se informan los límites de uso.
      if (!r.ok && ["LimitExceededException", "TooManyRequestsException"].includes(r.code)) {
        const f = friendlyError(r.code, r.message);
        return error(f.status, f.message);
      }
      return NextResponse.json({ step: "reset" });
    }
    case "reset": {
      const code = text(body.code, 32)?.trim();
      const password = text(body.password, 256);
      if (!email || !code || !password) return error(400, "Enter the code and a new password.");
      const r = await confirmReset(email, code, password);
      if (!r.ok) {
        const f = friendlyError(r.code, r.message);
        return error(f.status, f.message);
      }
      return NextResponse.json({ step: "signin" });
    }
    default:
      return error(400, "Invalid request.");
  }
}
