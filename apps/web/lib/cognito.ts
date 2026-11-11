import "server-only";
import { authMode, oidcConfig } from "@/lib/oidc";

/**
 * Inicio de sesión dentro de la app contra Cognito, sin pasar por su página alojada.
 * Usa la API pública de Cognito para clientes sin secreto (no requiere credenciales AWS).
 * Solo aplica cuando el emisor OIDC es un user pool de Cognito.
 */
export function cognitoPasswordLogin(): boolean {
  if (authMode() !== "oidc") return false;
  try {
    return new URL(process.env.OIDC_ISSUER ?? "").hostname.startsWith("cognito-idp.");
  } catch {
    return false;
  }
}

export const CHALLENGE_COOKIE = "ragsis_auth_challenge";
/** Cognito invalida la sesión de un reto a los 3 minutos. */
export const CHALLENGE_TTL_SECONDS = 170;

export interface AuthResult {
  IdToken: string;
}

type CognitoResponse<T> = { ok: true; data: T } | { ok: false; code: string; message: string };

async function cognito<T>(operation: string, body: Record<string, unknown>): Promise<CognitoResponse<T>> {
  const { issuer, clientId } = oidcConfig();
  const res = await fetch(`${new URL(issuer).origin}/`, {
    method: "POST",
    headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": `AWSCognitoIdentityProviderService.${operation}` },
    body: JSON.stringify({ ClientId: clientId, ...body }),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok) return { ok: true, data: json as T };
  const code = String(json.__type ?? "").split("#").pop() || "UnknownError";
  return { ok: false, code, message: String(json.message ?? json.Message ?? "") };
}

export interface SignInOutcome {
  AuthenticationResult?: AuthResult;
  ChallengeName?: string;
  ChallengeParameters?: Record<string, string>;
  Session?: string;
}

export const signIn = (email: string, password: string) =>
  cognito<SignInOutcome>("InitiateAuth", { AuthFlow: "USER_PASSWORD_AUTH", AuthParameters: { USERNAME: email, PASSWORD: password } });

/** Cuentas invitadas entran con clave temporal y deben fijar la suya. */
export const setNewPassword = (username: string, newPassword: string, session: string) =>
  cognito<SignInOutcome>("RespondToAuthChallenge", {
    ChallengeName: "NEW_PASSWORD_REQUIRED",
    ChallengeResponses: { USERNAME: username, NEW_PASSWORD: newPassword },
    Session: session,
  });

export const requestResetCode = (email: string) => cognito<unknown>("ForgotPassword", { Username: email });

export const confirmReset = (email: string, code: string, password: string) =>
  cognito<unknown>("ConfirmForgotPassword", { Username: email, ConfirmationCode: code, Password: password });

/** Mensajes para personas; nunca se devuelve el texto interno de Cognito salvo la política de clave. */
export function friendlyError(code: string, message: string): { status: number; message: string } {
  switch (code) {
    case "NotAuthorizedException":
    case "UserNotFoundException":
      return { status: 401, message: "Wrong email or password." };
    case "PasswordResetRequiredException":
      return { status: 401, message: "You need to reset your password. Use “Forgot your password?”." };
    case "UserNotConfirmedException":
      return { status: 401, message: "This account isn't active yet. Ask your admin for an invite." };
    case "InvalidPasswordException":
      return { status: 400, message: message.replace(/^.*?:\s*/, "") || "That password doesn't meet the requirements." };
    case "CodeMismatchException":
      return { status: 400, message: "That code isn't right." };
    case "ExpiredCodeException":
      return { status: 400, message: "That code expired. Request a new one." };
    case "LimitExceededException":
    case "TooManyRequestsException":
    case "TooManyFailedAttemptsException":
      return { status: 429, message: "Too many attempts. Wait a few minutes and try again." };
    default:
      return { status: 502, message: "Couldn't complete that. Try again." };
  }
}
