import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../app.js";
import type { Db } from "../db/pool.js";
import { runCase, type SandboxCase } from "../lib/agent-sandbox.js";
import { ApiError, badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import {
  AUTONOMY,
  AgentConfig,
  AgentSlug,
  MODEL_PROFILES,
  OUTPUT_SCHEMAS,
  POLICY_VERSION,
  TENANT_LIMITS,
  TOOL_CATALOG,
  bumpVersion,
  canPublish,
  configHash,
  diffConfigs,
  riskOf,
  validateAgent,
  type PolicySubject,
} from "../lib/policy.js";
import { AGENT_TEMPLATES, blankConfig, configFromTemplate } from "../lib/presets.js";
import { assertUuid, audit, isAdmin, tx, type TenantContext } from "../lib/tenant.js";

const CreateAgent = z
  .object({
    template: z.string().min(1).max(64).optional(),
    slug: AgentSlug.optional(),
    name: z.string().trim().min(2).max(80).optional(),
    space_ids: z.array(z.string().uuid()).max(20).optional(),
  })
  .strict();
const SaveDraft = z.object({ config: AgentConfig }).strict();
const TestBody = z.object({ input: z.string().trim().min(2).max(2000).optional() }).strict();
const PublishBody = z.object({ bump: z.enum(["major", "minor", "patch"]).default("minor"), changelog: z.string().trim().min(3).max(1000) }).strict();
const RollbackBody = z.object({ version_id: z.string().uuid() }).strict();
const StatusBody = z.object({ status: z.enum(["published", "paused", "archived"]) }).strict();

interface AgentRow {
  id: string;
  slug: string;
  name: string;
  template_code: string | null;
  owner_id: string;
  status: string;
  draft_config: AgentConfig;
  draft_hash: string;
  active_version_id: string | null;
  created_at: string;
  updated_at: string;
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "agent";

async function subjectFor(db: Db, t: TenantContext): Promise<PolicySubject> {
  const p = await db.query("SELECT llm_policy FROM organization_profiles WHERE organization_id=$1", [t.organizationId]);
  return { role: t.role, dataClass: t.dataClass, workspaces: t.workspaces, llmPolicy: p.rows[0]?.llm_policy ?? null };
}

const canEdit = (t: TenantContext, a: Pick<AgentRow, "owner_id">) => t.role !== "viewer" && (isAdmin(t) || a.owner_id === t.userId);

async function loadAgent(db: Db, t: TenantContext, id: string): Promise<AgentRow> {
  assertUuid(id, "agent");
  const r = await db.query("SELECT * FROM agents WHERE id=$1", [id]);
  const a = r.rows[0] as AgentRow | undefined;
  // Drafts sin versión publicada solo los ve su owner o un admin (no se revela su existencia).
  if (!a || (!a.active_version_id && !isAdmin(t) && a.owner_id !== t.userId)) throw notFound("agent");
  return a;
}

async function activeVersion(db: Db, a: AgentRow) {
  if (!a.active_version_id) return null;
  return (await db.query("SELECT id, version, config, config_hash, risk_level, published_at FROM agent_versions WHERE id=$1", [a.active_version_id])).rows[0] ?? null;
}

export async function agentRoutes(app: FastifyInstance, deps: Deps) {
  const { pool } = deps;
  const base = "/v1/organizations/:org/agents";

  app.get(`${base}/catalog`, async () => ({
    policy_version: POLICY_VERSION,
    tools: TOOL_CATALOG,
    templates: Object.values(AGENT_TEMPLATES),
    autonomy: AUTONOMY,
    model_profiles: MODEL_PROFILES,
    output_schemas: OUTPUT_SCHEMAS,
    tenant_limits: TENANT_LIMITS,
  }));

  app.get(base, async (req) => {
    const t = req.tenant!;
    const rows = await tx(pool, t, async (db) =>
      (
        await db.query(
          `SELECT a.id, a.slug, a.name, a.template_code, a.owner_id, a.status, a.draft_config, a.draft_hash, a.updated_at,
                  u.email AS owner_email, v.version AS active_version, v.config_hash AS active_hash, v.risk_level AS active_risk,
                  (SELECT r.status FROM agent_test_runs r WHERE r.agent_id = a.id AND r.config_hash = a.draft_hash
                    ORDER BY r.created_at DESC LIMIT 1) AS draft_test_status
             FROM agents a
             LEFT JOIN users u ON u.id = a.owner_id
             LEFT JOIN agent_versions v ON v.id = a.active_version_id
            WHERE a.status <> 'archived' AND (a.active_version_id IS NOT NULL OR a.owner_id = $1 OR $2)
            ORDER BY a.updated_at DESC`,
          [t.userId, isAdmin(t)],
        )
      ).rows,
    );
    return {
      agents: rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        purpose: (r.draft_config as AgentConfig).purpose,
        icon: (r.draft_config as AgentConfig).icon,
        category: (r.draft_config as AgentConfig).category,
        template_code: r.template_code,
        status: r.status,
        owner_email: r.owner_email,
        active_version: r.active_version,
        risk: r.active_risk ?? riskOf(r.draft_config as AgentConfig),
        autonomy: (r.draft_config as AgentConfig).autonomy,
        tools: (r.draft_config as AgentConfig).tools,
        unpublished_changes: r.active_hash ? r.active_hash !== r.draft_hash : true,
        draft_test_status: r.draft_test_status,
        updated_at: r.updated_at,
        can_edit: canEdit(t, r),
      })),
    };
  });

  app.post(base, async (req, reply) => {
    const t = req.tenant!;
    if (t.role === "viewer") throw forbidden("viewers cannot create agents");
    const body = CreateAgent.parse(req.body ?? {});
    const tpl = body.template ? AGENT_TEMPLATES[body.template] : undefined;
    if (body.template && !tpl) throw badRequest("unknown template");
    if (tpl?.blocked) throw badRequest(`template unavailable: ${tpl.blocked}`);
    return tx(pool, t, async (db) => {
      const subject = await subjectFor(db, t);
      const spaces = body.space_ids ?? [...t.workspaces.keys()].slice(0, 1);
      const localOnly = subject.dataClass === "restricted" || subject.llmPolicy === "local_only";
      const cfg = tpl ? configFromTemplate(tpl, spaces, localOnly) : blankConfig(spaces, localOnly);
      if (body.name) cfg.name = body.name;
      let slug = body.slug ?? (tpl ? tpl.slug : slugify(cfg.name));
      if (!body.slug) {
        const taken = new Set((await db.query("SELECT slug FROM agents WHERE slug LIKE $1", [`${slug}%`])).rows.map((r) => r.slug));
        for (let i = 2; taken.has(slug); i++) slug = `${slug.replace(/-\d+$/, "")}-${i}`;
      }
      const id = randomUUID();
      try {
        await db.query(
          `INSERT INTO agents (id, organization_id, slug, name, template_code, owner_id, draft_config, draft_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
          [id, t.organizationId, slug, cfg.name, tpl?.code ?? null, t.userId, JSON.stringify(cfg), configHash(cfg)],
        );
      } catch (err: unknown) {
        if ((err as { code?: string }).code === "23505") throw conflict("an agent with this slug already exists");
        throw err;
      }
      await audit(db, t, "agent.draft_created", `agent:${id}`, "allow", { template: tpl?.code ?? null });
      reply.code(201);
      return { id, slug, validation: validateAgent(cfg, subject) };
    });
  });

  app.get(`${base}/:id`, async (req) => {
    const t = req.tenant!;
    return tx(pool, t, async (db) => {
      const a = await loadAgent(db, t, (req.params as { id: string }).id);
      const subject = await subjectFor(db, t);
      const active = await activeVersion(db, a);
      const versions = (
        await db.query(
          `SELECT v.id, v.version, v.risk_level, v.changelog, v.published_at, u.email AS published_by
             FROM agent_versions v LEFT JOIN users u ON u.id = v.published_by WHERE v.agent_id=$1 ORDER BY v.published_at DESC`,
          [a.id],
        )
      ).rows;
      const lastTest = (
        await db.query(
          "SELECT id, status, config_hash, checks, latency_ms, created_at FROM agent_test_runs WHERE agent_id=$1 ORDER BY created_at DESC LIMIT 1",
          [a.id],
        )
      ).rows[0] ?? null;
      const validation = validateAgent(a.draft_config, subject);
      const editable = canEdit(t, a);
      const publish = canPublish(a.draft_config, t, a.owner_id === t.userId);
      const testedDraft = lastTest?.config_hash === a.draft_hash && lastTest?.status === "passed";
      return {
        id: a.id,
        slug: a.slug,
        name: a.name,
        status: a.status,
        template_code: a.template_code,
        owner_id: a.owner_id,
        draft: a.draft_config,
        draft_hash: a.draft_hash,
        active_version: active ? { id: active.id, version: active.version, risk_level: active.risk_level, published_at: active.published_at, config_hash: active.config_hash } : null,
        unpublished_changes: active ? active.config_hash !== a.draft_hash : true,
        diff: diffConfigs(active?.config ?? null, a.draft_config),
        validation,
        versions,
        last_test: lastTest,
        can_edit: editable,
        publish: {
          allowed: editable && publish.ok && validation.ok && testedDraft && (!active || active.config_hash !== a.draft_hash),
          reasons: [
            ...(!editable ? ["you can't edit this agent"] : []),
            ...(!publish.ok && publish.reason ? [publish.reason] : []),
            ...(!validation.ok ? ["fix the items in the checklist"] : []),
            ...(!testedDraft ? ["run a successful test with the latest changes"] : []),
            ...(active && active.config_hash === a.draft_hash ? ["nothing has changed since the live version"] : []),
          ],
          next_version: { major: bumpVersion(active?.version ?? null, "major"), minor: bumpVersion(active?.version ?? null, "minor"), patch: bumpVersion(active?.version ?? null, "patch") },
        },
      };
    });
  });

  app.put(`${base}/:id/draft`, async (req) => {
    const t = req.tenant!;
    const { config } = SaveDraft.parse(req.body);
    return tx(pool, t, async (db) => {
      const a = await loadAgent(db, t, (req.params as { id: string }).id);
      if (!canEdit(t, a)) throw forbidden("only the agent owner or an admin can edit");
      if (a.status === "archived") throw conflict("archived agents are read-only");
      const subject = await subjectFor(db, t);
      const hash = configHash(config);
      await db.query("UPDATE agents SET draft_config=$2::jsonb, draft_hash=$3, name=$4, updated_at=now() WHERE id=$1", [a.id, JSON.stringify(config), hash, config.name]);
      const validation = validateAgent(config, subject);
      const active = await activeVersion(db, a);
      await audit(db, t, "agent.draft_saved", `agent:${a.id}`, "allow", { draft_hash: hash, policy_errors: validation.errors.length });
      return { draft_hash: hash, validation, diff: diffConfigs(active?.config ?? null, config) };
    });
  });

  app.post(`${base}/:id/test`, async (req, reply) => {
    const t = req.tenant!;
    const body = TestBody.parse(req.body ?? {});
    const id = (req.params as { id: string }).id;
    const { agent, subject } = await tx(pool, t, async (db) => {
      const a = await loadAgent(db, t, id);
      if (!canEdit(t, a)) throw forbidden("only the agent owner or an admin can test");
      return { agent: a, subject: await subjectFor(db, t) };
    });
    const config = agent.draft_config;
    const cases = body.input
      ? [{ name: "Playground", input: body.input, expect_citations: config.knowledge.require_citations }]
      : config.tests.slice(0, 5);
    if (!cases.length) throw badRequest("provide an input or add test cases to the definition");

    const started = Date.now();
    // Las llamadas al RAG abren sus propias transacciones (no se mantiene una TX durante el retrieval).
    const results: SandboxCase[] = [];
    for (const c of cases) results.push(await runCase(deps, t, subject, config, c));
    const status = results.every((r) => r.status === "passed") ? "passed" : "failed";
    const latency = Date.now() - started;
    const inputHash = createHash("sha256").update(cases.map((c) => c.input).join("\u0000")).digest("hex");

    const runId = await tx(pool, t, async (db) => {
      const r = await db.query(
        `INSERT INTO agent_test_runs (organization_id, agent_id, config_hash, actor_id, status, input_sha256, steps, checks, latency_ms, policy_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10) RETURNING id`,
        [
          t.organizationId,
          agent.id,
          agent.draft_hash,
          t.userId,
          status,
          inputHash,
          // Traza sin texto de la respuesta ni fragmentos: solo decisiones, conteos y tiempos.
          JSON.stringify(results.map((r) => ({ name: r.name, status: r.status, steps: r.steps.map(({ detail: _d, ...s }) => s) }))),
          JSON.stringify(results.flatMap((r) => r.checks.map((c) => ({ case: r.name, ...c })))),
          latency,
          POLICY_VERSION,
        ],
      );
      await audit(db, t, "agent.tested", `agent:${agent.id}`, "allow", { status, config_hash: agent.draft_hash, cases: cases.length, sandbox: true });
      return r.rows[0].id as string;
    });
    reply.code(201);
    return { id: runId, status, config_hash: agent.draft_hash, latency_ms: latency, sandbox: true, cases: results };
  });

  app.get(`${base}/:id/test-runs`, async (req) => {
    const t = req.tenant!;
    return tx(pool, t, async (db) => {
      const a = await loadAgent(db, t, (req.params as { id: string }).id);
      const rows = (
        await db.query(
          `SELECT r.id, r.status, r.config_hash, r.checks, r.latency_ms, r.created_at, u.email AS actor
             FROM agent_test_runs r LEFT JOIN users u ON u.id = r.actor_id
            WHERE r.agent_id=$1 AND (r.actor_id=$2 OR $3) ORDER BY r.created_at DESC LIMIT 20`,
          [a.id, t.userId, isAdmin(t)],
        )
      ).rows;
      return { test_runs: rows };
    });
  });

  app.post(`${base}/:id/publish`, async (req, reply) => {
    const t = req.tenant!;
    const body = PublishBody.parse(req.body);
    type Denied = { denied: { status: number; reason: string; details?: unknown } };
    const out = await tx(pool, t, async (db): Promise<Denied | Record<string, unknown>> => {
      const a = await loadAgent(db, t, (req.params as { id: string }).id);
      await db.query("SELECT pg_advisory_xact_lock(hashtext('agent:' || $1))", [a.id]);
      const subject = await subjectFor(db, t);
      // La denegación se audita y la TX hace commit; el error se lanza fuera para no revertir la auditoría.
      const deny = async (status: number, reason: string, details?: unknown): Promise<Denied> => {
        await audit(db, t, "agent.publish", `agent:${a.id}`, "deny", { reason });
        return { denied: { status, reason, details } };
      };
      if (!canEdit(t, a)) return deny(403, "only the agent owner or an admin can publish");
      if (a.status === "archived") return deny(409, "archived agents cannot be published");
      const who = canPublish(a.draft_config, t, a.owner_id === t.userId);
      if (!who.ok) return deny(403, who.reason!);
      const v = validateAgent(a.draft_config, subject);
      if (!v.ok) return deny(400, "definition has policy errors", { errors: v.errors });
      const test = (
        await db.query(
          "SELECT id FROM agent_test_runs WHERE agent_id=$1 AND config_hash=$2 AND status='passed' ORDER BY created_at DESC LIMIT 1",
          [a.id, a.draft_hash],
        )
      ).rows[0];
      if (!test) return deny(400, "no passing sandbox test for the current draft");
      const active = await activeVersion(db, a);
      if (active && active.config_hash === a.draft_hash) return deny(409, "no changes since the active version");
      const latest = (await db.query("SELECT version FROM agent_versions WHERE agent_id=$1 ORDER BY published_at DESC LIMIT 1", [a.id])).rows[0];
      const version = bumpVersion(latest?.version ?? null, body.bump);
      const diff = diffConfigs(active?.config ?? null, a.draft_config);
      const vid = randomUUID();
      await db.query(
        `INSERT INTO agent_versions (id, organization_id, agent_id, version, config, config_hash, risk_level, policy_version, changelog, test_run_id, published_by)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11)`,
        [vid, t.organizationId, a.id, version, JSON.stringify(a.draft_config), a.draft_hash, v.risk, POLICY_VERSION, body.changelog, test.id, t.userId],
      );
      await db.query("UPDATE agents SET active_version_id=$2, status='published', updated_at=now() WHERE id=$1", [a.id, vid]);
      await audit(db, t, "agent.published", `agent:${a.id}`, "allow", {
        version,
        config_hash: a.draft_hash,
        risk: v.risk,
        test_run_id: test.id,
        tools_added: diff.tools_added,
        spaces_added: diff.spaces_added,
        permissions_expanded: diff.permissions_expanded,
      });
      return { id: vid, version, risk_level: v.risk, diff };
    });
    if ("denied" in out) {
      const d = (out as Denied).denied;
      throw new ApiError(d.status, "publish_denied", d.reason, d.details);
    }
    reply.code(201);
    return out;
  });

  app.post(`${base}/:id/rollback`, async (req) => {
    const t = req.tenant!;
    const body = RollbackBody.parse(req.body);
    return tx(pool, t, async (db) => {
      const a = await loadAgent(db, t, (req.params as { id: string }).id);
      if (!canEdit(t, a)) throw forbidden("only the agent owner or an admin can roll back");
      const v = (await db.query("SELECT id, version, config FROM agent_versions WHERE id=$1 AND agent_id=$2", [body.version_id, a.id])).rows[0];
      if (!v) throw notFound("version");
      // Re-valida contra la política vigente: una versión antigua no puede reactivar permisos ya no permitidos.
      const check = validateAgent(v.config, await subjectFor(db, t));
      if (!check.ok) throw badRequest("that version violates the current policy", { errors: check.errors });
      await db.query("UPDATE agents SET active_version_id=$2, status='published', updated_at=now() WHERE id=$1", [a.id, v.id]);
      await audit(db, t, "agent.rolled_back", `agent:${a.id}`, "allow", { to_version: v.version });
      return { active_version: v.version };
    });
  });

  app.post(`${base}/:id/status`, async (req) => {
    const t = req.tenant!;
    const body = StatusBody.parse(req.body);
    return tx(pool, t, async (db) => {
      const a = await loadAgent(db, t, (req.params as { id: string }).id);
      if (!canEdit(t, a)) throw forbidden("only the agent owner or an admin can change status");
      if (body.status === "published" && !a.active_version_id) throw badRequest("publish a version first");
      if (a.status === "archived") throw conflict("archived agents are read-only");
      // Pausar o archivar nunca borra versiones ni pruebas anteriores.
      await db.query("UPDATE agents SET status=$2, updated_at=now() WHERE id=$1", [a.id, body.status]);
      await audit(db, t, `agent.${body.status === "published" ? "resumed" : body.status}`, `agent:${a.id}`);
      return { status: body.status };
    });
  });

  app.get(`${base}/:id/versions/:vid`, async (req) => {
    const t = req.tenant!;
    const { id, vid } = req.params as { id: string; vid: string };
    return tx(pool, t, async (db) => {
      const a = await loadAgent(db, t, id);
      assertUuid(vid, "version");
      const v = (
        await db.query("SELECT id, version, config, config_hash, risk_level, policy_version, changelog, test_run_id, published_at FROM agent_versions WHERE id=$1 AND agent_id=$2", [vid, a.id])
      ).rows[0];
      if (!v) throw notFound("version");
      return v;
    });
  });
}
