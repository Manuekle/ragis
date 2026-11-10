import type pg from "pg";
import { withContext, type Db, type SecurityContext } from "../db/pool.js";
import { ApiError, forbidden } from "./errors.js";

export type OrgRole = "owner" | "admin" | "member" | "viewer";

export interface Plan {
  id: string;
  max_documents: number;
  max_storage_bytes: string;
  max_upload_bytes: string;
  max_pages_per_doc: number;
  max_queries_month: number;
  max_context_tokens: number;
  rerank_enabled: boolean;
  queries_per_minute: number;
  /** RAG-05: default del plan; organizations.graph_mode puede forzarlo on/off. */
  graph_enabled: boolean;
}

export type GraphMode = "inherit" | "on" | "off";

export interface TenantContext {
  organizationId: string;
  userId: string;
  role: OrgRole;
  dataClass: string;
  regionPolicy: string;
  modelAllowlist: string[];
  plan: Plan;
  graphMode: GraphMode;
  /** Grafo efectivo: override de la organización o, si hereda, el default del plan. */
  graphEnabled: boolean;
  workspaces: Map<string, "editor" | "reader">;
  groups: string[];
  /** Roles funcionales (reviewer, approver, signatory, auditor…): separación de funciones (ADR-022). */
  functionalRoles: string[];
  principals: string[];
  security: SecurityContext;
  /** Presente cuando la llamada se autentica con una clave de servicio. */
  apiKeyId?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function assertUuid(value: string, what = "id"): string {
  if (!UUID_RE.test(value)) throw new ApiError(404, "not_found", `${what} not found`);
  return value;
}

/**
 * Resuelve el tenant activo SOLO desde una membresía verificada en BD.
 * El org_id de la URL es una solicitud; si no hay membresía activa se responde 404
 * (no se revela la existencia de la organización).
 */
export async function resolveTenant(pool: pg.Pool, userId: string, orgId: string): Promise<TenantContext> {
  assertUuid(orgId, "organization");
  return withContext(pool, { userId }, async (db) => {
    const m = await db.query(
      `SELECT m.role, o.data_class, o.region_policy, o.model_allowlist, o.status, o.graph_mode, row_to_json(p.*) AS plan
         FROM memberships m
         JOIN organizations o ON o.id = m.organization_id
         JOIN plans p ON p.id = o.plan_id
        WHERE m.organization_id = $1 AND m.user_id = $2 AND m.status = 'active'`,
      [orgId, userId],
    );
    const row = m.rows[0];
    if (!row) throw new ApiError(404, "not_found", "organization not found");
    if (row.status !== "active") throw forbidden("organization suspended");
    await db.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    const ws = await db.query("SELECT workspace_id, role FROM workspace_members WHERE user_id = $1", [userId]);
    const gr = await db.query("SELECT group_id FROM group_members WHERE user_id = $1", [userId]);
    const fr = await db.query("SELECT role FROM functional_roles WHERE user_id = $1", [userId]);
    const workspaces = new Map<string, "editor" | "reader">(ws.rows.map((r) => [r.workspace_id, r.role]));
    const groups = gr.rows.map((r) => r.group_id as string);
    const principals = [
      `user:${userId}`,
      ...[...workspaces.keys()].map((w) => `workspace:${w}`),
      ...groups.map((g) => `group:${g}`),
    ];
    return {
      organizationId: orgId,
      userId,
      role: row.role,
      dataClass: row.data_class,
      regionPolicy: row.region_policy,
      modelAllowlist: row.model_allowlist ?? [],
      plan: row.plan,
      graphMode: row.graph_mode,
      graphEnabled: effectiveGraph(row.graph_mode, row.plan),
      workspaces,
      groups,
      functionalRoles: fr.rows.map((r) => r.role as string),
      principals,
      security: { organizationId: orgId, userId, principals },
    };
  });
}

export function effectiveGraph(mode: GraphMode, plan: Plan): boolean {
  return mode === "on" || (mode === "inherit" && plan.graph_enabled === true);
}

export const isAdmin = (t: TenantContext) => t.role === "owner" || t.role === "admin";
export const hasRole = (t: TenantContext, role: string) => t.functionalRoles.includes(role);

export function requireAdmin(t: TenantContext): void {
  if (!isAdmin(t)) throw forbidden("requiere rol admin");
}

export function requireWorkspaceRead(t: TenantContext, workspaceId: string): void {
  assertUuid(workspaceId, "workspace");
  if (!t.workspaces.has(workspaceId)) throw new ApiError(404, "not_found", "workspace not found");
}

export function requireWorkspaceWrite(t: TenantContext, workspaceId: string): void {
  requireWorkspaceRead(t, workspaceId);
  if (t.role === "viewer") throw forbidden("rol viewer es de solo lectura");
  if (t.workspaces.get(workspaceId) !== "editor" && !isAdmin(t)) throw forbidden("requiere rol editor en el workspace");
}

export function tx<T>(pool: pg.Pool, t: TenantContext, fn: (db: Db) => Promise<T>): Promise<T> {
  return withContext(pool, t.security, fn);
}

export async function audit(
  db: Db,
  t: TenantContext,
  action: string,
  resource: string,
  decision: "allow" | "deny" = "allow",
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await db.query(
    "INSERT INTO audit_events (organization_id, actor_id, action, resource, decision, metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb)",
    [t.organizationId, t.userId, action, resource, decision, JSON.stringify(t.apiKeyId ? { ...metadata, api_key_id: t.apiKeyId } : metadata)],
  );
}
