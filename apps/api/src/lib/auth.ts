import { createRemoteJWKSet, jwtVerify, SignJWT, type JWTPayload } from "jose";
import type pg from "pg";
import type { Config } from "../config.js";
import { withContext } from "../db/pool.js";
import { ApiError } from "./errors.js";

export interface Identity {
  idp: string;
  subject: string;
  email: string;
  name?: string;
}

export interface AuthUser extends Identity {
  userId: string;
  emailVerified: boolean;
  /** Métodos de autenticación del IdP (OIDC `amr`), p. ej. ["pwd","mfa"]. Exigido para enviar firmas si el tenant lo pide. */
  amr: string[];
}

const DEV_ISSUER = "ragsis-dev";
const DEV_AUDIENCE = "ragsis-api";

export class Authenticator {
  private jwks?: ReturnType<typeof createRemoteJWKSet>;
  private devKey?: Uint8Array;

  constructor(
    private readonly cfg: Config,
    private readonly pool: pg.Pool,
  ) {
    if (cfg.AUTH_MODE === "dev") this.devKey = new TextEncoder().encode(cfg.JWT_DEV_SECRET);
    else this.jwks = createRemoteJWKSet(new URL(`${cfg.OIDC_ISSUER!.replace(/\/$/, "")}/.well-known/jwks.json`));
  }

  async issueDevToken(email: string, name?: string, mfa = false): Promise<string> {
    if (!this.devKey) throw new ApiError(404, "not_found");
    // Solo dev: permite probar la exigencia de MFA del tenant; en OIDC el `amr` lo emite el IdP.
    return new SignJWT({ email, name, amr: mfa ? ["pwd", "mfa"] : ["pwd"] })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(`dev|${email.toLowerCase()}`)
      .setIssuer(DEV_ISSUER)
      .setAudience(DEV_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("8h")
      .sign(this.devKey);
  }

  async verify(authorization: string | undefined): Promise<AuthUser> {
    if (!authorization?.startsWith("Bearer ")) throw new ApiError(401, "unauthenticated", "falta token");
    const token = authorization.slice(7).trim();
    let payload: JWTPayload;
    let idp: string;
    try {
      if (this.devKey) {
        ({ payload } = await jwtVerify(token, this.devKey, { issuer: DEV_ISSUER, audience: DEV_AUDIENCE, algorithms: ["HS256"] }));
        idp = "dev";
      } else {
        ({ payload } = await jwtVerify(token, this.jwks!, { issuer: this.cfg.OIDC_ISSUER, audience: this.cfg.OIDC_AUDIENCE }));
        idp = this.cfg.OIDC_ISSUER!;
      }
    } catch {
      throw new ApiError(401, "unauthenticated", "invalid or expired token");
    }
    const email = typeof payload.email === "string" ? payload.email : undefined;
    if (!payload.sub || !email) throw new ApiError(401, "unauthenticated", "token sin sub/email");
    // Cognito/OIDC: no aceptar emails no verificados (evita suplantación por registro con email ajeno).
    if (payload.email_verified === false || payload.email_verified === "false") {
      throw new ApiError(401, "unauthenticated", "email no verificado por el proveedor de identidad");
    }
    if (payload.token_use !== undefined && payload.token_use !== "id") {
      throw new ApiError(401, "unauthenticated", "se requiere id_token");
    }
    const name = typeof payload.name === "string" ? payload.name : undefined;
    // El tenant NO viene del token: se resuelve después con membresía verificada.
    const userId = await withContext(this.pool, {}, async (db) => {
      const r = await db.query("SELECT app.upsert_user($1, $2, $3, $4) AS id", [idp, payload.sub, email, name ?? null]);
      return r.rows[0].id as string;
    });
    const amr = Array.isArray(payload.amr) ? payload.amr.filter((x): x is string => typeof x === "string") : [];
    return { idp, subject: payload.sub, email, name, userId, amr, emailVerified: !!this.devKey || payload.email_verified === true || payload.email_verified === "true" };
  }
}

/** Token interno de vida corta para rag-engine (HS256, aud ragsis-rag). */
export async function issueInternalToken(
  secret: string,
  claims: {
    userId: string;
    organizationId: string;
    workspaceId: string;
    principals: string[];
    plan: string;
    dataClass: string;
    allowlist: string[];
    maxContextTokens: number;
    rerank: boolean;
    graph: boolean;
  },
): Promise<string> {
  return new SignJWT({
    org: claims.organizationId,
    ws: claims.workspaceId,
    principals: claims.principals,
    plan: claims.plan,
    data_class: claims.dataClass,
    allowlist: claims.allowlist,
    max_ctx: claims.maxContextTokens,
    rerank: claims.rerank,
    graph: claims.graph,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.userId)
    .setIssuer("ragsis-api")
    .setAudience("ragsis-rag")
    .setIssuedAt()
    .setExpirationTime("60s")
    .sign(new TextEncoder().encode(secret));
}
