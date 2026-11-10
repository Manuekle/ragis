import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../app.js";
import type { Db } from "../db/pool.js";
import { badRequest } from "../lib/errors.js";
import { TEAM_SIZES, VOLUMES, scoreLead } from "../lib/lead-fit.js";
import { configHash } from "../lib/policy.js";
import { AGENT_TEMPLATES, DOC_TYPES, GOALS, SECTOR_TEMPLATES, SECTORS, configFromTemplate, recommend, type Recommendation } from "../lib/presets.js";
import { audit, requireAdmin, tx, type TenantContext } from "../lib/tenant.js";

/** Pasos del wizard (sección 02 de la especificación). */
export const STEPS = [
  { n: 1, key: "organization", title: "Organization", skippable: true },
  { n: 2, key: "sector", title: "Sector & activity", skippable: false },
  { n: 3, key: "goals", title: "Goals", skippable: false },
  { n: 4, key: "documents", title: "Documents & sources", skippable: true },
  { n: 5, key: "privacy", title: "Privacy & residency", skippable: false },
  { n: 6, key: "spaces", title: "Spaces & roles", skippable: true },
  { n: 7, key: "agents", title: "Suggested agents", skippable: true },
  { n: 8, key: "pilot", title: "Controlled test", skippable: true },
  { n: 9, key: "activate", title: "Activate", skippable: false },
] as const;

const REQUIRED_TO_COMPLETE = [2, 3, 5];
const CLASS_ORDER = ["public", "internal", "confidential", "restricted"];

/** Estado de la máquina tras completar/omitir el paso n. */
function statusAfter(n: number, prev: string): string {
  if (n === 9) return "COMPLETED";
  if (prev === "NEEDS_REVIEW") return "NEEDS_REVIEW";
  if (n <= 3) return "PROFILE_STARTED";
  if (n === 4) return "DATA_SOURCES";
  if (n === 5) return "SECURITY";
  if (n <= 7) return "WORKSPACE_READY";
  return "PILOT_TESTED";
}

const Step1 = z
  .object({
    country: z.string().trim().min(2).max(56).optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
    legal_id: z.string().trim().max(40).optional(),
  })
  .strict();
const Step2 = z
  .object({
    sector_primary: z.enum(SECTORS),
    sector_secondary: z.array(z.enum(SECTORS)).max(3).default([]),
    team_size: z.enum(TEAM_SIZES),
    language: z.string().trim().min(2).max(10).default("es"),
    initial_area: z.string().trim().max(120).optional(),
    activity_description: z.string().trim().max(500).optional(),
  })
  .strict()
  .refine((v) => !v.sector_secondary.includes(v.sector_primary), { message: "secondary sectors must differ from the primary", path: ["sector_secondary"] });
const Step3 = z.object({ goals: z.array(z.enum(GOALS)).min(1).max(3) }).strict();
const Step4 = z
  .object({
    doc_types: z.array(z.enum(DOC_TYPES)).max(10).default([]),
    volume_estimate: z.enum(VOLUMES).optional(),
  })
  .strict();
const Step5 = z
  .object({
    data_classification: z.enum(["public", "internal", "confidential", "restricted"]),
    deployment_preference: z.enum(["cloud", "private_cloud", "on_prem"]),
    llm_policy: z.enum(["cloud_allowed", "local_only", "ask"]),
    region: z.string().trim().max(32).optional(),
  })
  .strict()
  .refine((v) => !(v.data_classification === "restricted" && v.llm_policy === "cloud_allowed"), {
    message: "restricted data cannot allow cloud models — choose local only or ask",
    path: ["llm_policy"],
  });
const Step6 = z.object({ spaces: z.array(z.string().trim().min(1).max(120)).max(10).default([]) }).strict();
const Step7 = z.object({ agents: z.array(z.string().min(1).max(64)).max(12).default([]) }).strict();
const Empty = z.object({}).strict();

const STEP_SCHEMAS: Record<number, z.ZodType> = { 1: Step1, 2: Step2, 3: Step3, 4: Step4, 5: Step5, 6: Step6, 7: Step7, 8: Empty, 9: Empty };

const StepBody = z.object({ action: z.enum(["complete", "skip"]), data: z.record(z.string(), z.unknown()).default({}) }).strict();

const ProfilePatch = z
  .object({
    country: z.string().trim().min(2).max(56).optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
    legal_id: z.string().trim().max(40).optional(),
    sector_primary: z.enum(SECTORS).optional(),
    sector_secondary: z.array(z.enum(SECTORS)).max(3).optional(),
    team_size: z.enum(TEAM_SIZES).optional(),
    language: z.string().trim().min(2).max(10).optional(),
    initial_area: z.string().trim().max(120).optional(),
    activity_description: z.string().trim().max(500).optional(),
    goals: z.array(z.enum(GOALS)).min(1).max(3).optional(),
    doc_types: z.array(z.enum(DOC_TYPES)).max(10).optional(),
    volume_estimate: z.enum(VOLUMES).optional(),
    data_classification: z.enum(["public", "internal", "confidential", "restricted"]).optional(),
    deployment_preference: z.enum(["cloud", "private_cloud", "on_prem"]).optional(),
    llm_policy: z.enum(["cloud_allowed", "local_only", "ask"]).optional(),
    region: z.string().trim().max(32).optional(),
  })
  .strict();

const PROFILE_COLUMNS = Object.keys(ProfilePatch.shape) as (keyof z.infer<typeof ProfilePatch>)[];

interface Session {
  status: string;
  current_step: number;
  completed_steps: number[];
  skipped_steps: number[];
  template_version: string | null;
  recommendation: Recommendation | null;
  provisioned: { spaces: string[]; agents: string[] };
  started_at: string | null;
  completed_at: string | null;
}

type Profile = Record<string, unknown> & {
  sector_primary: string | null;
  sector_secondary: string[];
  goals: string[];
  doc_types: string[];
  data_classification: string | null;
  llm_policy: string | null;
  deployment_preference: string | null;
  profile_version: number;
};

const DEFAULT_SESSION: Session = {
  status: "NOT_STARTED",
  current_step: 1,
  completed_steps: [],
  skipped_steps: [],
  template_version: null,
  recommendation: null,
  provisioned: { spaces: [], agents: [] },
  started_at: null,
  completed_at: null,
};

async function load(db: Db, orgId: string): Promise<{ session: Session; profile: Profile }> {
  await db.query("INSERT INTO organization_profiles (organization_id) VALUES ($1) ON CONFLICT DO NOTHING", [orgId]);
  const s = await db.query(
    "SELECT status, current_step, completed_steps, skipped_steps, template_version, recommendation, provisioned, started_at, completed_at FROM onboarding_sessions WHERE organization_id=$1",
    [orgId],
  );
  const p = await db.query("SELECT * FROM organization_profiles WHERE organization_id=$1", [orgId]);
  return { session: s.rows[0] ?? { ...DEFAULT_SESSION }, profile: p.rows[0] };
}

async function saveSession(db: Db, orgId: string, s: Session, actor: string): Promise<void> {
  await db.query(
    `INSERT INTO onboarding_sessions (organization_id, status, current_step, completed_steps, skipped_steps, template_version, recommendation,
       provisioned, completed_at, completed_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb, CASE WHEN $2='COMPLETED' THEN now() END, CASE WHEN $2='COMPLETED' THEN $9::uuid END)
     ON CONFLICT (organization_id) DO UPDATE SET status=EXCLUDED.status, current_step=EXCLUDED.current_step,
       completed_steps=EXCLUDED.completed_steps, skipped_steps=EXCLUDED.skipped_steps, template_version=EXCLUDED.template_version,
       recommendation=EXCLUDED.recommendation, provisioned=EXCLUDED.provisioned, updated_at=now(),
       completed_at=COALESCE(EXCLUDED.completed_at, CASE WHEN EXCLUDED.status='COMPLETED' THEN onboarding_sessions.completed_at END),
       completed_by=COALESCE(EXCLUDED.completed_by, CASE WHEN EXCLUDED.status='COMPLETED' THEN onboarding_sessions.completed_by END)`,
    [orgId, s.status, s.current_step, s.completed_steps, s.skipped_steps, s.template_version, JSON.stringify(s.recommendation), JSON.stringify(s.provisioned), actor],
  );
}

async function patchProfile(db: Db, t: TenantContext, patch: Record<string, unknown>): Promise<void> {
  const cols = PROFILE_COLUMNS.filter((c) => patch[c] !== undefined);
  if (!cols.length) return;
  const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(", ");
  await db.query(
    `UPDATE organization_profiles SET ${sets}, profile_version = profile_version + 1, updated_by = $${cols.length + 2}, updated_at = now() WHERE organization_id = $1`,
    [t.organizationId, ...cols.map((c) => patch[c]), t.userId],
  );
  await refreshLead(db, t.organizationId);
}

/** Recalcula la calificación comercial (derivada, interna) tras cualquier cambio de perfil. */
async function refreshLead(db: Db, orgId: string): Promise<void> {
  const row = (await db.query("SELECT * FROM organization_profiles WHERE organization_id=$1", [orgId])).rows[0];
  const fit = row ? scoreLead(row) : null;
  await db.query("UPDATE organization_profiles SET lead_score=$2, lead_tier=$3 WHERE organization_id=$1", [orgId, fit?.score ?? null, fit?.tier ?? null]);
}

/** Endurece (nunca relaja) la clasificación del tenant que usa la política de modelos del rag-engine. */
async function tightenDataClass(db: Db, t: TenantContext, next: string): Promise<boolean> {
  if (CLASS_ORDER.indexOf(next) <= CLASS_ORDER.indexOf(t.dataClass)) return false;
  await db.query("UPDATE organizations SET data_class=$2 WHERE id=$1", [t.organizationId, next]);
  await audit(db, t, "organization.data_class_tightened", `organization:${t.organizationId}`, "allow", { from: t.dataClass, to: next });
  return true;
}

function recompute(t: TenantContext, profile: Profile): Recommendation {
  return recommend(
    {
      sector_primary: (profile.sector_primary as never) ?? null,
      sector_secondary: profile.sector_secondary ?? [],
      goals: profile.goals ?? [],
      data_classification: profile.data_classification,
      llm_policy: profile.llm_policy,
      doc_types: profile.doc_types ?? [],
      deployment_preference: profile.deployment_preference,
    },
    { plan: t.plan.id, orgDataClass: t.dataClass },
  );
}

async function provisionSpaces(db: Db, t: TenantContext, names: string[]) {
  const existing = (await db.query("SELECT id, name FROM workspaces")).rows as { id: string; name: string }[];
  const created: { id: string; name: string }[] = [];
  const kept: { id: string; name: string }[] = [];
  for (const raw of [...new Set(names.map((n) => n.trim()))]) {
    const hit = existing.find((w) => w.name.toLowerCase() === raw.toLowerCase());
    if (hit) {
      kept.push(hit);
      continue;
    }
    const id = randomUUID();
    await db.query("INSERT INTO workspaces (id, organization_id, name) VALUES ($1,$2,$3)", [id, t.organizationId, raw]);
    await db.query("INSERT INTO workspace_members (workspace_id, organization_id, user_id, role) VALUES ($1,$2,$3,'editor')", [id, t.organizationId, t.userId]);
    await audit(db, t, "workspace.created", `workspace:${id}`, "allow", { source: "onboarding" });
    created.push({ id, name: raw });
  }
  return { created, kept };
}

async function provisionAgents(db: Db, t: TenantContext, codes: string[], spaceIds: string[], localOnly: boolean) {
  const created: { id: string; slug: string; template: string }[] = [];
  const skipped: { template: string; reason: string }[] = [];
  for (const code of [...new Set(codes)]) {
    const tpl = AGENT_TEMPLATES[code];
    if (!tpl) {
      skipped.push({ template: code, reason: "unknown template" });
      continue;
    }
    if (tpl.blocked) {
      skipped.push({ template: code, reason: tpl.blocked });
      continue;
    }
    const exists = await db.query("SELECT 1 FROM agents WHERE slug=$1", [tpl.slug]);
    if (exists.rowCount) {
      // Nunca se sobrescriben agentes existentes (cambio de sector, reanudación).
      skipped.push({ template: code, reason: "already exists" });
      continue;
    }
    const cfg = configFromTemplate(tpl, spaceIds, localOnly);
    const id = randomUUID();
    await db.query(
      `INSERT INTO agents (id, organization_id, slug, name, template_code, owner_id, draft_config, draft_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
      [id, t.organizationId, tpl.slug, cfg.name, code, t.userId, JSON.stringify(cfg), configHash(cfg)],
    );
    await audit(db, t, "agent.draft_created", `agent:${id}`, "allow", { template: code, source: "onboarding" });
    created.push({ id, slug: tpl.slug, template: code });
  }
  return { created, skipped };
}

export async function onboardingRoutes(app: FastifyInstance, deps: Deps) {
  const { pool } = deps;
  const base = "/v1/organizations/:org/onboarding";

  const view = async (db: Db, t: TenantContext) => {
    const { session, profile: full } = await load(db, t.organizationId);
    // La calificación comercial es interna: no se devuelve al cliente.
    const { lead_score: _score, lead_tier: _tier, ...profile } = full as Record<string, unknown>;
    const pilot = (
      await db.query(
        `SELECT (SELECT count(*)::int FROM document_versions WHERE is_current AND status='indexed') AS documents_indexed,
                (SELECT count(*)::int FROM agents WHERE status <> 'archived') AS agents,
                (SELECT count(*)::int FROM agent_test_runs WHERE status='passed') AS passed_tests`,
      )
    ).rows[0];
    return {
      ...session,
      can_edit: t.role === "owner" || t.role === "admin",
      profile,
      steps: STEPS,
      pilot,
      catalog: {
        sectors: SECTORS.map((s) => ({ code: s, label: SECTOR_TEMPLATES[s].label, docs_question: SECTOR_TEMPLATES[s].docs_question, spaces: SECTOR_TEMPLATES[s].spaces, guardrail: SECTOR_TEMPLATES[s].guardrail, approach: SECTOR_TEMPLATES[s].approach, deployment: SECTOR_TEMPLATES[s].deployment })),
        goals: GOALS,
        doc_types: DOC_TYPES,
        agent_templates: Object.values(AGENT_TEMPLATES).map((a) => ({ code: a.code, name: a.name, purpose: a.purpose, tools: a.tools, autonomy: a.autonomy, blocked: a.blocked ?? null })),
      },
    };
  };

  app.get(base, async (req) => {
    const t = req.tenant!;
    return tx(pool, t, (db) => view(db, t));
  });

  const applyStep = (t: TenantContext, n: number, body: z.infer<typeof StepBody>) => {
    const meta = STEPS.find((s) => s.n === n);
    if (!meta) throw badRequest("unknown step");
    return tx(pool, t, async (db) => {
      const { session, profile } = await load(db, t.organizationId);
      const result: Record<string, unknown> = {};
      const wasCompleted = session.status === "COMPLETED";

      if (body.action === "skip") {
        if (!meta.skippable) throw badRequest(`step ${n} (${meta.title}) cannot be skipped`);
        session.skipped_steps = [...new Set([...session.skipped_steps, n])].sort((a, b) => a - b);
        session.completed_steps = session.completed_steps.filter((s) => s !== n);
      } else {
        const data = STEP_SCHEMAS[n]!.parse(body.data) as Record<string, unknown>;
        if (n === 9) {
          const missing = REQUIRED_TO_COMPLETE.filter((s) => !session.completed_steps.includes(s));
          if (missing.length) throw badRequest(`complete steps ${missing.join(", ")} before activating`, { missing });
        }
        if (n >= 1 && n <= 5) await patchProfile(db, t, data);
        if (n === 5) result.data_class_tightened = await tightenDataClass(db, t, data.data_classification as string);
        if (n === 6) {
          const r = await provisionSpaces(db, t, data.spaces as string[]);
          session.provisioned.spaces = [...new Set([...session.provisioned.spaces, ...r.created.map((w) => w.id), ...r.kept.map((w) => w.id)])];
          result.spaces = r;
        }
        if (n === 7) {
          // Espacios del agente = espacios del onboarding ∩ espacios que el usuario puede leer (nunca ampliación).
          let spaceIds = session.provisioned.spaces.filter((id) => t.workspaces.has(id));
          if (!spaceIds.length) spaceIds = [...t.workspaces.keys()].slice(0, 5);
          const localOnly = t.dataClass === "restricted" || profile.llm_policy === "local_only" || profile.data_classification === "restricted";
          const r = await provisionAgents(db, t, data.agents as string[], spaceIds, localOnly);
          session.provisioned.agents = [...new Set([...session.provisioned.agents, ...r.created.map((a) => a.id)])];
          result.agents = r;
        }
        session.completed_steps = [...new Set([...session.completed_steps, n])].sort((a, b) => a - b);
        session.skipped_steps = session.skipped_steps.filter((s) => s !== n);
      }

      session.status = statusAfter(n, session.status === "PAUSED" ? "PROFILE_STARTED" : session.status);
      // Siguiente paso pendiente: los que ya vienen resueltos desde el alta (sector, tamaño) no se vuelven a pedir.
      let next = n + 1;
      if (!wasCompleted) while (next < 9 && session.completed_steps.includes(next)) next++;
      session.current_step = Math.min(9, next);
      if (n >= 2 && n <= 5) {
        const fresh = (await db.query("SELECT * FROM organization_profiles WHERE organization_id=$1", [t.organizationId])).rows[0] as Profile;
        session.recommendation = recompute(t, fresh);
        session.template_version = session.recommendation.template_version;
      }
      await saveSession(db, t.organizationId, session, t.userId);
      await audit(db, t, n === 9 ? "onboarding.completed" : `onboarding.step_${body.action}`, `organization:${t.organizationId}`, "allow", {
        step: n,
        status: session.status,
        // Activar el onboarding nunca publica agentes ni habilita herramientas críticas.
        ...(n === 9 ? { critical_tools_enabled: false, agents_published: 0 } : {}),
      });
      return { ...(await view(db, t)), result };
    });
  };

  app.put(`${base}/steps/:step`, async (req) => {
    const t = req.tenant!;
    requireAdmin(t);
    return applyStep(t, Number((req.params as { step: string }).step), StepBody.parse(req.body));
  });

  app.post(`${base}/complete`, async (req) => {
    const t = req.tenant!;
    requireAdmin(t);
    return applyStep(t, 9, { action: "complete", data: {} });
  });

  app.post(`${base}/pause`, async (req) => {
    const t = req.tenant!;
    requireAdmin(t);
    return tx(pool, t, async (db) => {
      const { session } = await load(db, t.organizationId);
      if (session.status === "COMPLETED") throw badRequest("onboarding already completed");
      session.status = "PAUSED";
      await saveSession(db, t.organizationId, session, t.userId);
      await audit(db, t, "onboarding.paused", `organization:${t.organizationId}`);
      return view(db, t);
    });
  });

  app.post(`${base}/recommendations`, async (req) => {
    const t = req.tenant!;
    requireAdmin(t);
    return tx(pool, t, async (db) => {
      const { session, profile } = await load(db, t.organizationId);
      session.recommendation = recompute(t, profile);
      session.template_version = session.recommendation.template_version;
      await saveSession(db, t.organizationId, session, t.userId);
      return session.recommendation;
    });
  });

  // Edición posterior desde Configuración. Un cambio de sector/objetivos tras completar propone (no aplica)
  // nuevas sugerencias: estado NEEDS_REVIEW, sin tocar espacios ni agentes existentes.
  app.put(`${base}/profile`, async (req) => {
    const t = req.tenant!;
    requireAdmin(t);
    const patch = ProfilePatch.parse(req.body);
    if (patch.data_classification === "restricted" && patch.llm_policy === "cloud_allowed") {
      throw badRequest("restricted data cannot allow cloud models");
    }
    return tx(pool, t, async (db) => {
      const { session, profile } = await load(db, t.organizationId);
      const nextClass = patch.data_classification ?? profile.data_classification;
      const nextLlm = patch.llm_policy ?? profile.llm_policy;
      if (nextClass === "restricted" && nextLlm === "cloud_allowed") throw badRequest("restricted data cannot allow cloud models");
      await patchProfile(db, t, patch);
      if (patch.data_classification) await tightenDataClass(db, t, patch.data_classification);
      const fresh = (await db.query("SELECT * FROM organization_profiles WHERE organization_id=$1", [t.organizationId])).rows[0] as Profile;
      const sectorChanged = patch.sector_primary !== undefined && patch.sector_primary !== profile.sector_primary;
      const goalsChanged = patch.goals !== undefined && [...patch.goals].sort().join() !== [...(profile.goals ?? [])].sort().join();
      session.recommendation = recompute(t, fresh);
      session.template_version = session.recommendation.template_version;
      if (session.status === "COMPLETED" && (sectorChanged || goalsChanged)) {
        session.status = "NEEDS_REVIEW";
        session.current_step = 6;
      }
      await saveSession(db, t.organizationId, session, t.userId);
      await audit(db, t, "onboarding.profile_updated", `organization:${t.organizationId}`, "allow", {
        fields: Object.keys(patch),
        sector_changed: sectorChanged,
        profile_version: fresh.profile_version,
      });
      return view(db, t);
    });
  });
}
