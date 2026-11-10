import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withContext } from "../db/pool.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { assertUuid, audit, effectiveGraph, requireAdmin, tx } from "../lib/tenant.js";
import type { Deps } from "../app.js";
import { API_KEY_SCOPES, generateApiKey, hashSecret } from "../lib/apikeys.js";
import { Qualification, scoreLead } from "../lib/lead-fit.js";
import { SECTORS, SECTOR_TEMPLATES, recommend } from "../lib/presets.js";

const CreateOrg = z.object({
  name: z.string().trim().min(2).max(120),
  // Calificación comercial recogida en la pantalla de alta, antes de entrar a la app (ADR-021).
  qualification: Qualification.optional(),
  slug: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,48}$/)
    .optional(),
});
const UpdateSettings = z.object({ graph_mode: z.enum(["inherit", "on", "off"]) }).strict();
const CreateWorkspace = z.object({ name: z.string().trim().min(1).max(120) });
const AddMember = z.object({ email: z.string().email(), role: z.enum(["admin", "member", "viewer"]).default("member") });
const AddWsMember = z.object({ user_id: z.string().uuid(), role: z.enum(["editor", "reader"]).default("reader") });
const CreateGroup = z.object({ name: z.string().trim().min(1).max(120) });
const AddGroupMember = z.object({ user_id: z.string().uuid() });
const CreateApiKey = z.object({
  name: z.string().trim().min(1).max(120),
  scopes: z.array(z.enum(API_KEY_SCOPES)).min(1),
  workspace_ids: z.array(z.string().uuid()).min(1).max(50),
  expires_in_days: z.number().int().min(1).max(365).default(90),
});

export async function orgRoutes(app: FastifyInstance, deps: Deps) {
  const { pool } = deps;

  // Catálogo para la pantalla de alta (antes de que exista una organización): sector, enfoque RAG y despliegue probable.
  app.get("/v1/onboarding/catalog", async () => ({
    sectors: SECTORS.map((s) => ({ code: s, label: SECTOR_TEMPLATES[s].label, approach: SECTOR_TEMPLATES[s].approach, deployment: SECTOR_TEMPLATES[s].deployment })),
  }));

  app.get("/v1/me", async (req) => {
    const user = req.user!;
    const orgs = await withContext(pool, { userId: user.userId }, async (db) =>
      (
        await db.query(
          `SELECT o.id, o.name, o.slug, o.plan_id, m.role FROM memberships m
             JOIN organizations o ON o.id = m.organization_id
            WHERE m.user_id = $1 AND m.status = 'active' ORDER BY o.created_at`,
          [user.userId],
        )
      ).rows,
    );
    return { user: { id: user.userId, email: user.email, name: user.name ?? null }, organizations: orgs };
  });

  app.post("/v1/organizations", async (req, reply) => {
    const body = CreateOrg.parse(req.body);
    const user = req.user!;
    const orgId = randomUUID();
    const wsId = randomUUID();
    const slug = body.slug ?? `${body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "org"}-${orgId.slice(0, 6)}`;
    try {
      await withContext(pool, { organizationId: orgId, userId: user.userId }, async (db) => {
        await db.query("INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)", [orgId, body.name, slug]);
        await db.query("INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'owner')", [orgId, user.userId]);
        await db.query("INSERT INTO workspaces (id, organization_id, name) VALUES ($1, $2, 'General')", [wsId, orgId]);
        await db.query(
          "INSERT INTO workspace_members (workspace_id, organization_id, user_id, role) VALUES ($1, $2, $3, 'editor')",
          [wsId, orgId, user.userId],
        );
        // La calificación comercial llega desde el alta. Si trae sector y tamaño, el paso 2 del wizard ya está resuelto
        // y la recomendación sectorial parte calculada; el resto de Setup es configuración del producto.
        const q = body.qualification;
        const fit = q ? scoreLead(q) : null;
        await db.query(
          `INSERT INTO organization_profiles (organization_id, sector_primary, team_size, buyer_role, initial_users, volume_estimate,
             document_sources, fit_signals, referral_source, referral_detail, lead_score, lead_tier)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [orgId, q?.sector_primary ?? null, q?.team_size ?? null, q?.buyer_role ?? null, q?.initial_users ?? null, q?.volume_estimate ?? null,
           q?.document_sources ?? [], q?.fit_signals ?? [], q?.referral_source ?? null, q?.referral_detail ?? null, fit?.score ?? null, fit?.tier ?? null],
        );
        const sectorDone = !!(q?.sector_primary && q.team_size);
        const recommendation = sectorDone
          ? recommend({ sector_primary: q!.sector_primary!, sector_secondary: [], goals: [], data_classification: null, llm_policy: null, doc_types: [], deployment_preference: null }, { plan: "team", orgDataClass: "internal" })
          : null;
        await db.query(
          `INSERT INTO onboarding_sessions (organization_id, status, current_step, completed_steps, template_version, recommendation)
           VALUES ($1, 'PROFILE_STARTED', 1, $2, $3, $4::jsonb)`,
          [orgId, sectorDone ? [2] : [], recommendation?.template_version ?? null, JSON.stringify(recommendation)],
        );
        await db.query(
          "INSERT INTO audit_events (organization_id, actor_id, action, resource, decision) VALUES ($1,$2,'organization.created',$3,'allow')",
          [orgId, user.userId, `organization:${orgId}`],
        );
      });
    } catch (err: unknown) {
      if ((err as { code?: string }).code === "23505") throw conflict("slug already exists");
      throw err;
    }
    reply.code(201);
    return { id: orgId, name: body.name, slug, default_workspace_id: wsId, onboarding: { status: "PROFILE_STARTED", current_step: 1 } };
  });

  app.get("/v1/organizations/:org", async (req) => {
    const t = req.tenant!;
    const org = await tx(pool, t, async (db) =>
      (await db.query("SELECT id, name, slug, plan_id, data_class, region_policy, graph_mode, created_at FROM organizations WHERE id=$1", [t.organizationId])).rows[0],
    );
    return { ...org, role: t.role, plan: t.plan, graph_enabled: t.graphEnabled, functional_roles: t.functionalRoles };
  });

  // RAG-05: GraphRAG por tenant (inherit = default del plan). Activarlo no reprocesa documentos existentes:
  // backfill con `make reindex ARGS="--org <uuid> --mode graph"`.
  app.patch("/v1/organizations/:org/settings", async (req) => {
    const t = req.tenant!;
    requireAdmin(t);
    const body = UpdateSettings.parse(req.body);
    await tx(pool, t, async (db) => {
      await db.query("UPDATE organizations SET graph_mode=$2 WHERE id=$1", [t.organizationId, body.graph_mode]);
      await audit(db, t, "organization.settings_updated", `organization:${t.organizationId}`, "allow", {
        graph_mode: { from: t.graphMode, to: body.graph_mode },
      });
    });
    return { graph_mode: body.graph_mode, graph_enabled: effectiveGraph(body.graph_mode, t.plan) };
  });

  // ---------------------------------------------------------------- workspaces
  app.get("/v1/organizations/:org/workspaces", async (req) => {
    const t = req.tenant!;
    const rows = await tx(pool, t, async (db) =>
      (
        await db.query(
          `SELECT w.id, w.name, w.created_at, wm.role AS my_role,
                  CASE WHEN wm.role IS NOT NULL THEN EXISTS (
                    SELECT 1 FROM documents d
                     WHERE d.organization_id = w.organization_id AND d.workspace_id = w.id AND d.status = 'active'
                  ) END AS has_documents
             FROM workspaces w LEFT JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.user_id = $1
            ORDER BY w.created_at`,
          [t.userId],
        )
      ).rows,
    );
    // Los admins ven todos; el resto solo aquellos de los que son miembros.
    return { workspaces: rows.filter((w) => w.my_role || t.role === "owner" || t.role === "admin") };
  });

  app.post("/v1/organizations/:org/workspaces", async (req, reply) => {
    const t = req.tenant!;
    requireAdmin(t);
    const body = CreateWorkspace.parse(req.body);
    const id = randomUUID();
    await tx(pool, t, async (db) => {
      try {
        await db.query("INSERT INTO workspaces (id, organization_id, name) VALUES ($1,$2,$3)", [id, t.organizationId, body.name]);
      } catch (err: unknown) {
        if ((err as { code?: string }).code === "23505") throw conflict("workspace already exists");
        throw err;
      }
      await db.query("INSERT INTO workspace_members (workspace_id, organization_id, user_id, role) VALUES ($1,$2,$3,'editor')", [
        id,
        t.organizationId,
        t.userId,
      ]);
      await audit(db, t, "workspace.created", `workspace:${id}`);
    });
    reply.code(201);
    return { id, name: body.name };
  });

  app.post("/v1/organizations/:org/workspaces/:ws/members", async (req, reply) => {
    const t = req.tenant!;
    requireAdmin(t);
    const ws = assertUuid((req.params as { ws: string }).ws, "workspace");
    const body = AddWsMember.parse(req.body);
    await tx(pool, t, async (db) => {
      const okWs = await db.query("SELECT 1 FROM workspaces WHERE id=$1", [ws]);
      const okMember = await db.query("SELECT 1 FROM memberships WHERE organization_id=$1 AND user_id=$2", [t.organizationId, body.user_id]);
      if (!okWs.rowCount || !okMember.rowCount) throw notFound("workspace o miembro");
      await db.query(
        `INSERT INTO workspace_members (workspace_id, organization_id, user_id, role) VALUES ($1,$2,$3,$4)
         ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
        [ws, t.organizationId, body.user_id, body.role],
      );
      await audit(db, t, "workspace.member_set", `workspace:${ws}`, "allow", { user_id: body.user_id, role: body.role });
    });
    reply.code(204);
  });

  // ---------------------------------------------------------------- miembros y grupos
  app.get("/v1/organizations/:org/members", async (req) => {
    const t = req.tenant!;
    requireAdmin(t);
    const rows = await tx(pool, t, async (db) =>
      (
        await db.query(
          `SELECT u.id, u.email, u.display_name, m.role, m.status FROM memberships m JOIN users u ON u.id = m.user_id
            WHERE m.organization_id = $1 ORDER BY u.email`,
          [t.organizationId],
        )
      ).rows,
    );
    return { members: rows };
  });

  app.post("/v1/organizations/:org/members", async (req, reply) => {
    const t = req.tenant!;
    requireAdmin(t);
    const body = AddMember.parse(req.body);
    const userId = await tx(pool, t, async (db) => {
      const r = await db.query("SELECT app.user_id_for_invite($1) AS id", [body.email]);
      const uid = r.rows[0]?.id as string | null;
      // Respuesta uniforme: no se revela si el email existe en otro tenant.
      if (!uid) throw badRequest("the user must sign in once before being added");
      await db.query(
        `INSERT INTO memberships (organization_id, user_id, role) VALUES ($1,$2,$3)
         ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role, status = 'active'`,
        [t.organizationId, uid, body.role],
      );
      await audit(db, t, "member.added", `user:${uid}`, "allow", { role: body.role });
      return uid;
    });
    reply.code(201);
    return { user_id: userId, role: body.role };
  });

  app.get("/v1/organizations/:org/groups", async (req) => {
    const t = req.tenant!;
    const rows = await tx(pool, t, async (db) =>
      (
        await db.query(
          `SELECT g.id, g.name, count(gm.user_id)::int AS members FROM groups g
             LEFT JOIN group_members gm ON gm.group_id = g.id GROUP BY g.id ORDER BY g.name`,
        )
      ).rows,
    );
    return { groups: rows };
  });

  app.post("/v1/organizations/:org/groups", async (req, reply) => {
    const t = req.tenant!;
    requireAdmin(t);
    const body = CreateGroup.parse(req.body);
    const id = randomUUID();
    await tx(pool, t, async (db) => {
      await db.query("INSERT INTO groups (id, organization_id, name) VALUES ($1,$2,$3)", [id, t.organizationId, body.name]);
      await audit(db, t, "group.created", `group:${id}`);
    });
    reply.code(201);
    return { id, name: body.name };
  });

  app.post("/v1/organizations/:org/groups/:group/members", async (req, reply) => {
    const t = req.tenant!;
    requireAdmin(t);
    const group = assertUuid((req.params as { group: string }).group, "grupo");
    const body = AddGroupMember.parse(req.body);
    await tx(pool, t, async (db) => {
      const okG = await db.query("SELECT 1 FROM groups WHERE id=$1", [group]);
      const okM = await db.query("SELECT 1 FROM memberships WHERE organization_id=$1 AND user_id=$2", [t.organizationId, body.user_id]);
      if (!okG.rowCount || !okM.rowCount) throw notFound("grupo o miembro");
      await db.query("INSERT INTO group_members (group_id, organization_id, user_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [
        group,
        t.organizationId,
        body.user_id,
      ]);
      await audit(db, t, "group.member_added", `group:${group}`, "allow", { user_id: body.user_id });
    });
    reply.code(204);
  });

  // ---------------------------------------------------------------- claves de servicio (API-01)
  app.post("/v1/organizations/:org/api-keys", async (req, reply) => {
    const t = req.tenant!;
    requireAdmin(t);
    const body = CreateApiKey.parse(req.body);
    const key = generateApiKey();
    const expiresAt = new Date(Date.now() + body.expires_in_days * 86_400_000);
    await tx(pool, t, async (db) => {
      const ws = await db.query("SELECT count(*)::int AS n FROM workspaces WHERE id = ANY($1::uuid[])", [body.workspace_ids]);
      if (ws.rows[0].n !== new Set(body.workspace_ids).size) throw notFound("workspace");
      const su = await db.query("SELECT app.create_service_user($1) AS id", [key.id]);
      await db.query(
        `INSERT INTO service_api_keys (id, organization_id, service_user_id, name, prefix, key_hash, scopes, workspace_ids,
           created_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [key.id, t.organizationId, su.rows[0].id, body.name, key.prefix, hashSecret(key.secret), body.scopes,
         [...new Set(body.workspace_ids)], t.userId, expiresAt],
      );
      await audit(db, t, "api_key.created", `api_key:${key.id}`, "allow", { scopes: body.scopes, workspaces: body.workspace_ids });
    });
    reply.code(201);
    // El secreto se muestra una única vez; no es recuperable.
    return { id: key.id, name: body.name, prefix: key.prefix, token: key.token, scopes: body.scopes,
             workspace_ids: body.workspace_ids, expires_at: expiresAt.toISOString() };
  });

  app.get("/v1/organizations/:org/api-keys", async (req) => {
    const t = req.tenant!;
    requireAdmin(t);
    const rows = await tx(pool, t, async (db) =>
      (
        await db.query(
          `SELECT id, name, prefix, scopes, workspace_ids, created_at, expires_at, last_used_at, revoked_at
             FROM service_api_keys ORDER BY created_at DESC`,
        )
      ).rows,
    );
    return { api_keys: rows };
  });

  app.delete("/v1/organizations/:org/api-keys/:id", async (req, reply) => {
    const t = req.tenant!;
    requireAdmin(t);
    const id = assertUuid((req.params as { id: string }).id, "clave");
    await tx(pool, t, async (db) => {
      const r = await db.query("UPDATE service_api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL", [id]);
      if (!r.rowCount) throw notFound("clave");
      await audit(db, t, "api_key.revoked", `api_key:${id}`);
    });
    reply.code(204);
  });

  // ---------------------------------------------------------------- uso y auditoría
  app.get("/v1/organizations/:org/usage", async (req) => {
    const t = req.tenant!;
    requireAdmin(t);
    return tx(pool, t, async (db) => {
      const month = await db.query(
        `SELECT kind, sum(quantity)::float8 AS quantity FROM usage_events
          WHERE created_at >= date_trunc('month', now()) GROUP BY kind`,
      );
      const totals = await db.query("SELECT documents, storage_bytes::float8 AS storage_bytes FROM app.tenant_corpus_stats()");
      const runs = await db.query(
        `SELECT count(*)::int AS n, coalesce(avg(latency_ms), 0)::int AS avg_latency_ms,
                coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms), 0)::int AS p95_latency_ms,
                coalesce(avg(abstained::int), 0)::float8 AS abstention_rate, coalesce(sum(cost_estimate_usd), 0)::float8 AS cost_usd
           FROM query_runs WHERE created_at >= date_trunc('month', now())`,
      );
      return {
        period: "current_month",
        usage: Object.fromEntries(month.rows.map((r) => [r.kind, r.quantity])),
        corpus: totals.rows[0],
        my_queries: runs.rows[0],
        limits: t.plan,
      };
    });
  });

  app.get("/v1/organizations/:org/audit", async (req) => {
    const t = req.tenant!;
    requireAdmin(t);
    const rows = await tx(pool, t, async (db) =>
      (
        await db.query(
          "SELECT id, actor_id, action, resource, decision, metadata, created_at, hash FROM audit_events ORDER BY id DESC LIMIT 200",
        )
      ).rows,
    );
    return { events: rows };
  });
}
