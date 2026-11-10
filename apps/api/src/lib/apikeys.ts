import { createHash, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { withContext } from "../db/pool.js";
import { ApiError } from "./errors.js";
import { effectiveGraph, type Plan, type TenantContext } from "./tenant.js";

export const API_KEY_SCOPES = ["query", "documents:read", "documents:write"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

const KEY_RE = /^rsk_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;

export interface ResolvedApiKey {
  keyId: string;
  organizationId: string;
  serviceUserId: string;
  scopes: ApiKeyScope[];
  workspaceIds: string[];
}

export const hashSecret = (secret: string) => createHash("sha256").update(secret, "utf8").digest("hex");

/** Genera `rsk_<prefix>_<secreto>`; solo se muestra una vez. En BD queda prefijo + sha256 del secreto. */
export function generateApiKey(): { id: string; prefix: string; secret: string; token: string } {
  const prefix = randomBytes(6).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  return { id: randomUUID(), prefix, secret, token: `rsk_${prefix}_${secret}` };
}

export const isApiKeyToken = (authorization?: string) => !!authorization?.startsWith("Bearer rsk_");

export async function resolveApiKey(pool: pg.Pool, authorization: string): Promise<ResolvedApiKey> {
  const m = KEY_RE.exec(authorization.slice(7).trim());
  if (!m) throw new ApiError(401, "unauthenticated", "invalid API key");
  const [, prefix, secret] = m as unknown as [string, string, string];
  const row = await withContext(pool, {}, async (db) => {
    const r = await db.query("SELECT * FROM app.resolve_api_key($1, $2)", [prefix, hashSecret(secret)]);
    return r.rows[0];
  });
  if (!row) throw new ApiError(401, "unauthenticated", "invalid, revoked or expired API key");
  return {
    keyId: row.key_id,
    organizationId: row.organization_id,
    serviceUserId: row.service_user_id,
    scopes: row.scopes,
    workspaceIds: row.workspace_ids,
  };
}

/** `documents:write` implica lectura. */
export function keyAllows(key: ResolvedApiKey, required: readonly string[]): boolean {
  const granted = new Set<string>(key.scopes);
  if (granted.has("documents:write")) granted.add("documents:read");
  return required.some((s) => granted.has(s));
}

/** Contexto de tenant para una clave: rol mínimo, solo sus workspaces, sin grupos. */
export async function tenantFromApiKey(pool: pg.Pool, key: ResolvedApiKey): Promise<TenantContext> {
  const writer = key.scopes.includes("documents:write");
  const org = await withContext(pool, { organizationId: key.organizationId }, async (db) => {
    const r = await db.query(
      `SELECT o.data_class, o.region_policy, o.model_allowlist, o.graph_mode, row_to_json(p.*) AS plan
         FROM organizations o JOIN plans p ON p.id = o.plan_id WHERE o.id = $1`,
      [key.organizationId],
    );
    return r.rows[0];
  });
  if (!org) throw new ApiError(401, "unauthenticated", "invalid API key");
  const workspaces = new Map<string, "editor" | "reader">(key.workspaceIds.map((w) => [w, writer ? "editor" : "reader"]));
  const principals = [`user:${key.serviceUserId}`, ...key.workspaceIds.map((w) => `workspace:${w}`)];
  return {
    organizationId: key.organizationId,
    userId: key.serviceUserId,
    role: writer ? "member" : "viewer",
    dataClass: org.data_class,
    regionPolicy: org.region_policy,
    modelAllowlist: org.model_allowlist ?? [],
    plan: org.plan as Plan,
    graphMode: org.graph_mode,
    graphEnabled: effectiveGraph(org.graph_mode, org.plan as Plan),
    workspaces,
    groups: [],
    functionalRoles: [],
    principals,
    security: { organizationId: key.organizationId, userId: key.serviceUserId, principals },
    apiKeyId: key.keyId,
  };
}
