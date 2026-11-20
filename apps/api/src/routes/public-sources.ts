import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../app.js";
import { issueInternalToken } from "../lib/auth.js";
import { COUNTRY_CODES, PUBLIC_COUNTRIES, effectiveCountry, loadPublicSettings, type PublicSettings } from "../lib/public-sources.js";
import { forbidden } from "../lib/errors.js";
import { audit, isAdmin, requireAdmin, tx, type TenantContext } from "../lib/tenant.js";
import type { RagClient } from "./query.js";

const Update = z
  .object({
    enabled: z.boolean().optional(),
    /** null = use the country from the organization profile. */
    country: z.enum(COUNTRY_CODES).nullable().optional(),
    web: z.boolean().optional(),
    monthly_limit: z.number().int().min(0).max(100_000).optional(),
  })
  .strict();

export interface PublicStatus {
  available: boolean;
  demo: boolean;
}

const STATUS_TTL_MS = 60_000;
const statusCache = new WeakMap<RagClient, { at: number; value: PublicStatus }>();

/** Whether the platform has Croma set up (key or demo mode). Asked to the rag-engine, which holds the key. */
export async function publicSourcesStatus(deps: Deps, t: TenantContext): Promise<PublicStatus> {
  const hit = statusCache.get(deps.rag);
  if (hit && Date.now() - hit.at < STATUS_TTL_MS) return hit.value;
  if (!deps.rag.publicSourcesStatus) return { available: false, demo: false };
  const token = await issueInternalToken(deps.cfg.INTERNAL_SERVICE_SECRET, {
    userId: t.userId,
    organizationId: t.organizationId,
    // The status call touches no data; any of the person's workspaces (or the nil UUID) satisfies the token shape.
    workspaceId: [...t.workspaces.keys()][0] ?? "00000000-0000-0000-0000-000000000000",
    principals: t.principals,
    plan: t.plan.id,
    dataClass: t.dataClass,
    allowlist: t.modelAllowlist,
    maxContextTokens: t.plan.max_context_tokens,
    rerank: t.plan.rerank_enabled,
    graph: t.graphEnabled,
  });
  try {
    const value = await deps.rag.publicSourcesStatus(token);
    statusCache.set(deps.rag, { at: Date.now(), value });
    return value;
  } catch {
    return { available: false, demo: false }; // not cached: the rag-engine may just be restarting
  }
}

function view(s: PublicSettings, status: PublicStatus, t: TenantContext) {
  const restricted = t.dataClass === "restricted";
  return {
    available: status.available,
    demo: status.demo,
    /** `restricted` data never goes to external APIs, so public records cannot be turned on. */
    restricted,
    enabled: s.enabled && !restricted,
    country: effectiveCountry(s),
    country_setting: s.country,
    country_from_profile: s.countryFromProfile,
    web: s.web,
    monthly_limit: s.monthlyLimit,
    used_this_month: s.usedThisMonth,
    remaining: Math.max(0, s.monthlyLimit - s.usedThisMonth),
    can_manage: isAdmin(t),
    countries: PUBLIC_COUNTRIES,
  };
}

export async function publicSourceRoutes(app: FastifyInstance, deps: Deps) {
  const { pool } = deps;

  // Any member reads it (Ask shows the "Public records" switch only when it is on and set up).
  app.get("/v1/organizations/:org/public-sources", async (req) => {
    const t = req.tenant!;
    const [settings, status] = await Promise.all([tx(pool, t, (db) => loadPublicSettings(db, t.organizationId)), publicSourcesStatus(deps, t)]);
    return view(settings, status, t);
  });

  app.put("/v1/organizations/:org/public-sources", async (req) => {
    const t = req.tenant!;
    requireAdmin(t);
    const body = Update.parse(req.body);
    if (body.enabled && t.dataClass === "restricted") throw forbidden("public records are not available for restricted data");
    const settings = await tx(pool, t, async (db) => {
      const before = await loadPublicSettings(db, t.organizationId);
      const sets: string[] = [];
      const args: unknown[] = [t.organizationId];
      const col = { enabled: "public_sources_enabled", country: "public_sources_country", web: "public_sources_web", monthly_limit: "public_sources_monthly_limit" } as const;
      for (const [key, column] of Object.entries(col) as [keyof typeof col, string][]) {
        if (body[key] === undefined) continue;
        args.push(body[key]);
        sets.push(`${column}=$${args.length}`);
      }
      if (sets.length) {
        await db.query(`UPDATE organizations SET ${sets.join(", ")} WHERE id=$1`, args);
        await audit(db, t, "organization.public_sources_updated", `organization:${t.organizationId}`, "allow", {
          from: { enabled: before.enabled, country: before.country, web: before.web, monthly_limit: before.monthlyLimit },
          to: body,
        });
      }
      return loadPublicSettings(db, t.organizationId);
    });
    return view(settings, await publicSourcesStatus(deps, t), t);
  });
}
