/**
 * CON-01 · Conectores (ADR-025). Gmail lo conecta cada persona (solo ella ve su correo); Slack y ClickUp los conecta
 * un admin para un workspace. Los mensajes de error son visibles en la UI: lenguaje llano, sin jerga.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../app.js";
import type { Db } from "../db/pool.js";
import { ProviderError } from "../lib/connectors/http.js";
import { ADAPTERS, type ConnectorService, type FullConnectorRow } from "../lib/connectors/service.js";
import { PROVIDERS, type ProviderId } from "../lib/connectors/types.js";
import { ApiError, forbidden, notFound } from "../lib/errors.js";
import { assertUuid, audit, isAdmin, requireAdmin, requireWorkspaceRead, requireWorkspaceWrite, resolveTenant, tx, type TenantContext } from "../lib/tenant.js";

const Provider = z.enum(PROVIDERS);

const problem = (status: number, code: string, message: string) => new ApiError(status, code, message);

function requireConnectPermission(t: TenantContext, provider: ProviderId, workspaceId: string) {
  if (ADAPTERS[provider].scope === "organization") {
    requireAdmin(t);
    requireWorkspaceWrite(t, workspaceId);
  } else {
    requireWorkspaceRead(t, workspaceId);
    if (t.role === "viewer") throw forbidden("Your role can't add content. Ask an administrator.");
  }
}

async function loadConnector(db: Db, t: TenantContext, id: string, manage = true): Promise<FullConnectorRow> {
  assertUuid(id, "connection");
  // RLS: conectores de organización + los personales propios. El de otra persona es inexistente.
  const row = (await db.query("SELECT * FROM connectors WHERE id=$1", [id])).rows[0] as FullConnectorRow | undefined;
  if (!row) throw notFound("connection");
  if (manage && row.scope === "organization" && !isAdmin(t)) throw forbidden("Only administrators can change company connections.");
  return row;
}

function problems(row: { provider: string; cursor: Record<string, unknown> }) {
  if (row.provider !== "slack") return [];
  const channels = (row.cursor?.channels ?? {}) as Record<string, { problem?: string }>;
  return Object.entries(channels).filter(([, c]) => c.problem).map(([id, c]) => ({ id, problem: c.problem }));
}

export async function connectorRoutes(app: FastifyInstance, deps: Deps, service: ConnectorService) {
  const { pool } = deps;

  app.get("/v1/organizations/:org/connectors", async (req) => {
    const t = req.tenant!;
    return tx(pool, t, async (db) => {
      const allowed = ((await db.query("SELECT allowed_connectors FROM organizations WHERE id=$1", [t.organizationId])).rows[0]?.allowed_connectors ?? []) as string[];
      const rows = (
        await db.query(
          `SELECT c.id, c.provider, c.scope, c.workspace_id, w.name AS workspace_name, c.account_label, c.status, c.settings, c.cursor,
                  c.last_sync_at, c.last_success_at, c.next_sync_at, c.last_error_code, c.created_at, c.owner_id,
                  coalesce(u.display_name, u.email) AS owner_name,
                  (SELECT count(*)::int FROM connector_items ci WHERE ci.connector_id = c.id) AS item_count
             FROM connectors c
             JOIN workspaces w ON w.id = c.workspace_id
             LEFT JOIN users u ON u.id = c.owner_id
            ORDER BY c.scope DESC, c.provider, c.created_at`,
        )
      ).rows;
      return {
        can_manage_company: isAdmin(t),
        providers: PROVIDERS.map((p) => ({
          id: p,
          name: ADAPTERS[p].name,
          scope: ADAPTERS[p].scope,
          available: service.available(p),
          allowed: allowed.includes(p),
        })),
        demo: service.demo,
        connectors: rows.map(({ cursor, owner_id, ...r }) => ({
          ...r,
          is_mine: owner_id === t.userId,
          allowed: allowed.includes(r.provider),
          syncing: r.status === "active" && !!r.next_sync_at && new Date(r.next_sync_at).getTime() <= Date.now() + 10_000,
          problems: problems({ provider: r.provider, cursor }),
        })),
      };
    });
  });

  /** Qué apps puede conectar la organización. Desactivar una pausa sus conexiones (no borra nada). */
  app.put("/v1/organizations/:org/connectors/policy", async (req) => {
    const t = req.tenant!;
    requireAdmin(t);
    const body = z.object({ allowed: z.array(Provider).max(PROVIDERS.length) }).parse(req.body);
    const allowed = [...new Set(body.allowed)];
    await tx(pool, t, async (db) => {
      await db.query("UPDATE organizations SET allowed_connectors=$2 WHERE id=$1", [t.organizationId, allowed]);
      await audit(db, t, "connector.policy_updated", `organization:${t.organizationId}`, "allow", { allowed });
    });
    return { allowed };
  });

  app.post("/v1/organizations/:org/connectors/:provider/authorize", async (req) => {
    const t = req.tenant!;
    const provider = Provider.parse((req.params as { provider: string }).provider);
    const body = z.object({ workspace_id: z.string().uuid() }).parse(req.body);
    requireConnectPermission(t, provider, body.workspace_id);
    if (!service.available(provider)) throw problem(409, "not_configured", `${ADAPTERS[provider].name} isn't set up on this server yet. Ask your administrator.`);
    const url = await tx(pool, t, async (db) => {
      const allowed = (await db.query("SELECT allowed_connectors FROM organizations WHERE id=$1", [t.organizationId])).rows[0]?.allowed_connectors as string[];
      if (!allowed?.includes(provider)) throw problem(403, "provider_disabled", `Your administrator has turned off ${ADAPTERS[provider].name}.`);
      const u = await service.beginOAuth(db, { orgId: t.organizationId, userId: t.userId, provider, workspaceId: body.workspace_id });
      await audit(db, t, "connector.connect_started", `connector_provider:${provider}`, "allow", { workspace_id: body.workspace_id });
      return u;
    });
    return { authorize_url: url };
  });

  /** Vuelta del proveedor: la página /connect/callback reenvía code+state con la sesión de la misma persona. */
  app.post("/v1/connectors/oauth/complete", async (req) => {
    const body = z.object({ state: z.string().min(40).max(200), code: z.string().min(1).max(4096) }).parse(req.body);
    const orgId = body.state.split(".")[0] ?? "";
    assertUuid(orgId, "connection");
    const t = await resolveTenant(pool, req.user!.userId, orgId);
    const st = await tx(pool, t, (db) => service.consumeState(db, body.state));
    if (!st) throw problem(400, "connect_expired", "This connection link has expired. Please try connecting again.");
    const provider = st.provider;
    const adapter = ADAPTERS[provider];
    requireConnectPermission(t, provider, st.workspace_id);
    const client = service.client(provider);
    if (!client) throw problem(409, "not_configured", `${adapter.name} isn't set up on this server yet. Ask your administrator.`);
    let exchanged;
    try {
      exchanged = await adapter.exchange(service.http, { client, code: body.code, redirectUri: service.redirectUri(), codeVerifier: st.code_verifier });
    } catch (err) {
      if (err instanceof ProviderError) {
        req.log.warn({ provider, code: err.code, status: err.status }, "connector oauth exchange failed");
        const msg = err.code === "forbidden" ? `${adapter.name} didn't grant read access. Please try again and allow access.` : `We couldn't finish connecting to ${adapter.name}. Please try again.`;
        throw problem(400, "connect_failed", msg);
      }
      throw err;
    }
    const { tokens, account } = exchanged;
    const result = await tx(pool, t, async (db) => {
      const existing = (
        adapter.scope === "personal"
          ? await db.query("SELECT * FROM connectors WHERE provider=$1 AND scope='personal' AND owner_id=$2 FOR UPDATE", [provider, t.userId])
          : await db.query("SELECT * FROM connectors WHERE provider=$1 AND scope='organization' AND external_account_id=$2 FOR UPDATE", [provider, account.id])
      ).rows[0] as (FullConnectorRow & { external_account_id: string }) | undefined;
      let id: string;
      let status: string;
      if (existing) {
        const settings = adapter.parseSettings(existing.settings);
        status = existing.status === "paused" ? "paused" : adapter.ready?.(settings) === false ? "needs_setup" : "active";
        const sameAccount = existing.external_account_id === account.id;
        await db.query(
          `UPDATE connectors SET owner_id=$2, external_account_id=$3, account_label=$4, status=$5, cursor=$6::jsonb, last_error_code=NULL,
             last_error_detail=NULL, consecutive_failures=0, next_sync_at=now(), lease_until=NULL, updated_at=now() WHERE id=$1`,
          [existing.id, t.userId, account.id, account.label, status, JSON.stringify(sameAccount ? existing.cursor : {})],
        );
        id = existing.id;
      } else {
        status = adapter.initialStatus;
        id = (
          await db.query(
            `INSERT INTO connectors (organization_id, provider, scope, owner_id, workspace_id, external_account_id, account_label, settings, status, next_sync_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9, now()) RETURNING id`,
            [t.organizationId, provider, adapter.scope, t.userId, st.workspace_id, account.id, account.label, JSON.stringify(adapter.defaultSettings()), status],
          )
        ).rows[0].id;
      }
      await service.saveTokens(db, { id, organization_id: t.organizationId }, tokens);
      await audit(db, t, "connector.connected", `connector:${id}`, "allow", { provider, reconnect: !!existing, workspace_id: existing?.workspace_id ?? st.workspace_id });
      return { id, status };
    });
    if (result.status === "active") service.kick();
    return { organization_id: t.organizationId, connector_id: result.id, provider, status: result.status };
  });

  app.get("/v1/organizations/:org/connectors/:id/options", async (req) => {
    const t = req.tenant!;
    const row = await tx(pool, t, (db) => loadConnector(db, t, (req.params as { id: string }).id));
    const adapter = ADAPTERS[row.provider as ProviderId];
    try {
      const tokens = await service.tokensFor(row);
      return { groups: await adapter.options(service.http, tokens, adapter.parseSettings(row.settings)) };
    } catch (err) {
      if (err instanceof ProviderError && err.code === "auth_revoked") {
        await tx(pool, t, (db) => db.query("UPDATE connectors SET status='error', last_error_code='reconnect_needed', updated_at=now() WHERE id=$1", [row.id]));
        throw problem(409, "reconnect_needed", `${adapter.name} access has expired. Please reconnect.`);
      }
      if (err instanceof ProviderError) throw problem(502, "provider_unavailable", `${adapter.name} didn't respond. Try again in a moment.`);
      throw err;
    }
  });

  app.put("/v1/organizations/:org/connectors/:id", async (req) => {
    const t = req.tenant!;
    const body = z.object({ settings: z.record(z.string(), z.unknown()).optional(), paused: z.boolean().optional() }).parse(req.body);
    const out = await tx(pool, t, async (db) => {
      const row = await loadConnector(db, t, (req.params as { id: string }).id);
      const adapter = ADAPTERS[row.provider as ProviderId];
      const prev = adapter.parseSettings(row.settings);
      const next = adapter.parseSettings({ ...row.settings, ...(body.settings ?? {}) });
      const resync = adapter.needsResync?.(prev, next) ?? false;
      let status = row.status;
      if (status !== "error") {
        if (body.paused === true) status = "paused";
        else if (body.paused === false || status === "needs_setup" || status === "active") status = adapter.ready?.(next) === false ? "needs_setup" : "active";
      }
      const cursor = resync ? adapter.resetCursor?.(row.cursor) ?? {} : row.cursor;
      await db.query(
        `UPDATE connectors SET settings=$2::jsonb, status=$3, cursor=$4::jsonb, next_sync_at = CASE WHEN $3 = 'active' THEN now() ELSE next_sync_at END,
           updated_at=now() WHERE id=$1`,
        [row.id, JSON.stringify(next), status, JSON.stringify(cursor)],
      );
      await audit(db, t, "connector.updated", `connector:${row.id}`, "allow", { provider: row.provider, status, resync });
      return { id: row.id, status, settings: next };
    });
    if (out.status === "active") service.kick();
    return out;
  });

  app.post("/v1/organizations/:org/connectors/:id/sync", { config: { scopes: ["documents:write"] } }, async (req, reply) => {
    const t = req.tenant!;
    await tx(pool, t, async (db) => {
      const row = await loadConnector(db, t, (req.params as { id: string }).id);
      const name = ADAPTERS[row.provider as ProviderId].name;
      if (row.status === "needs_setup") throw problem(409, "setup_needed", `Choose what to bring in from ${name} first.`);
      if (row.status === "paused") throw problem(409, "paused", "This connection is paused. Resume it first.");
      const code = (await db.query("SELECT last_error_code FROM connectors WHERE id=$1", [row.id])).rows[0]?.last_error_code;
      if (row.status === "error" && (code === "reconnect_needed" || code === "owner_removed")) throw problem(409, "reconnect_needed", `Please reconnect ${name}.`);
      await db.query("UPDATE connectors SET status='active', consecutive_failures=0, next_sync_at=now(), updated_at=now() WHERE id=$1", [row.id]);
      await audit(db, t, "connector.sync_requested", `connector:${row.id}`);
    });
    service.kick();
    reply.code(202);
    return { state: "queued" };
  });

  /** Desconectar: revoca el acceso y retira de la búsqueda todo lo que se trajo de esa app. */
  app.delete("/v1/organizations/:org/connectors/:id", async (req, reply) => {
    const t = req.tenant!;
    const row = await tx(pool, t, (db) => loadConnector(db, t, (req.params as { id: string }).id));
    const removed = await service.purge(row, t.userId);
    reply.code(202);
    return { removed_items: removed };
  });
}
