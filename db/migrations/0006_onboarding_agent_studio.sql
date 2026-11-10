-- ragsis · Onboarding sectorial + Agent Studio (ADR-020)
-- Hitos A (datos/políticas), B (onboarding) y D (Agent Studio) de la
-- "Especificación Onboarding inteligente y Agent Studio" v1.0.
--
-- Frontera de tenant: organization_id + RLS forzada, igual que el resto del esquema.
-- La autorización fina (quién edita/publica un agente) vive en el Policy Engine de la API
-- (apps/api/src/lib/policy.ts); la BD garantiza aislamiento e inmutabilidad de versiones.

-- ---------------------------------------------------------------------------
-- Perfil de organización (salida de los pasos 1–5 del onboarding)
-- ---------------------------------------------------------------------------
CREATE TABLE organization_profiles (
  organization_id       uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  country               text,
  timezone              text,
  legal_id              text,
  sector_primary        text CHECK (sector_primary IN ('legal', 'consulting', 'industry', 'accounting', 'insurance',
                                                       'construction', 'education', 'other')),
  sector_secondary      text[] NOT NULL DEFAULT '{}',
  activity_description  text,
  initial_area          text,
  team_size             text CHECK (team_size IN ('1-10', '11-50', '51-200', '201-1000', '1000+')),
  language              text NOT NULL DEFAULT 'es',
  goals                 text[] NOT NULL DEFAULT '{}',
  doc_types             text[] NOT NULL DEFAULT '{}',
  volume_estimate       text CHECK (volume_estimate IN ('lt_1k', '1k_10k', '10k_100k', 'gt_100k')),
  data_classification   text CHECK (data_classification IN ('public', 'internal', 'confidential', 'restricted')),
  deployment_preference text CHECK (deployment_preference IN ('cloud', 'private_cloud', 'on_prem')),
  llm_policy            text CHECK (llm_policy IN ('cloud_allowed', 'local_only', 'ask')),
  region                text,
  profile_version       integer NOT NULL DEFAULT 1,
  updated_by            uuid REFERENCES users(id),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Sesión de onboarding (máquina de estados, reanudable)
-- ---------------------------------------------------------------------------
CREATE TABLE onboarding_sessions (
  organization_id  uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  status           text NOT NULL DEFAULT 'NOT_STARTED'
                   CHECK (status IN ('NOT_STARTED', 'PROFILE_STARTED', 'DATA_SOURCES', 'SECURITY', 'WORKSPACE_READY',
                                     'PILOT_TESTED', 'COMPLETED', 'PAUSED', 'NEEDS_REVIEW')),
  current_step     smallint NOT NULL DEFAULT 1 CHECK (current_step BETWEEN 1 AND 9),
  completed_steps  smallint[] NOT NULL DEFAULT '{}',
  skipped_steps    smallint[] NOT NULL DEFAULT '{}',
  template_version text,
  recommendation   jsonb,
  -- Lo que el onboarding aprovisionó (ids de espacios y agentes); nunca se sobrescribe lo existente.
  provisioned      jsonb NOT NULL DEFAULT '{"spaces": [], "agents": []}',
  started_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  completed_by     uuid REFERENCES users(id)
);

-- ---------------------------------------------------------------------------
-- Agent Studio: agente (draft mutable) + versiones publicadas inmutables
-- ---------------------------------------------------------------------------
CREATE TABLE agents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  slug              text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,60}$'),
  name              text NOT NULL,
  template_code     text,
  owner_id          uuid NOT NULL REFERENCES users(id),
  status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'paused', 'archived')),
  draft_config      jsonb NOT NULL,
  draft_hash        text NOT NULL,
  active_version_id uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, slug)
);
CREATE INDEX agents_org_idx ON agents (organization_id, status);

CREATE TABLE agent_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id        uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  version         text NOT NULL CHECK (version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  config          jsonb NOT NULL,
  config_hash     text NOT NULL,
  risk_level      text NOT NULL CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  policy_version  text NOT NULL,
  changelog       text NOT NULL DEFAULT '',
  test_run_id     uuid NOT NULL,
  published_by    uuid NOT NULL REFERENCES users(id),
  published_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, version)
);
CREATE INDEX agent_versions_agent_idx ON agent_versions (agent_id, published_at DESC);

ALTER TABLE agents
  ADD CONSTRAINT agents_active_version_fk
  FOREIGN KEY (active_version_id) REFERENCES agent_versions(id) DEFERRABLE INITIALLY DEFERRED;

-- Ejecuciones de prueba en sandbox (herramientas de escritura simuladas). La pregunta se guarda solo como hash.
CREATE TABLE agent_test_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id        uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  config_hash     text NOT NULL,
  actor_id        uuid NOT NULL REFERENCES users(id),
  status          text NOT NULL CHECK (status IN ('passed', 'failed')),
  input_sha256    text NOT NULL,
  steps           jsonb NOT NULL DEFAULT '[]',
  checks          jsonb NOT NULL DEFAULT '[]',
  latency_ms      integer NOT NULL DEFAULT 0,
  policy_version  text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_test_runs_agent_idx ON agent_test_runs (agent_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
ALTER TABLE organization_profiles ENABLE ROW LEVEL SECURITY;  ALTER TABLE organization_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE onboarding_sessions   ENABLE ROW LEVEL SECURITY;  ALTER TABLE onboarding_sessions   FORCE ROW LEVEL SECURITY;
ALTER TABLE agents                ENABLE ROW LEVEL SECURITY;  ALTER TABLE agents                FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_versions        ENABLE ROW LEVEL SECURITY;  ALTER TABLE agent_versions        FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_test_runs       ENABLE ROW LEVEL SECURITY;  ALTER TABLE agent_test_runs       FORCE ROW LEVEL SECURITY;

CREATE POLICY profiles_tenant ON organization_profiles FOR ALL TO ragsis_app
  USING (organization_id = app.org_id()) WITH CHECK (organization_id = app.org_id());
CREATE POLICY onboarding_tenant ON onboarding_sessions FOR ALL TO ragsis_app
  USING (organization_id = app.org_id()) WITH CHECK (organization_id = app.org_id());
CREATE POLICY agents_tenant ON agents FOR ALL TO ragsis_app
  USING (organization_id = app.org_id()) WITH CHECK (organization_id = app.org_id());
CREATE POLICY agent_versions_tenant ON agent_versions FOR ALL TO ragsis_app
  USING (organization_id = app.org_id()) WITH CHECK (organization_id = app.org_id());
CREATE POLICY agent_test_runs_tenant ON agent_test_runs FOR ALL TO ragsis_app
  USING (organization_id = app.org_id()) WITH CHECK (organization_id = app.org_id());

-- Procedencia coherente: una versión/prueba solo puede apuntar a un agente del mismo tenant.
-- SECURITY INVOKER a propósito: corre con la RLS del llamador (solo ve agentes de su tenant).
CREATE OR REPLACE FUNCTION app.agent_same_tenant() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM agents a WHERE a.id = NEW.agent_id AND a.organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'agent/tenant mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_versions_same_tenant BEFORE INSERT ON agent_versions
  FOR EACH ROW EXECUTE FUNCTION app.agent_same_tenant();
CREATE TRIGGER agent_test_runs_same_tenant BEFORE INSERT ON agent_test_runs
  FOR EACH ROW EXECUTE FUNCTION app.agent_same_tenant();

-- ---------------------------------------------------------------------------
-- Privilegios: versiones y pruebas son append-only para la aplicación (inmutables).
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON organization_profiles, onboarding_sessions, agents TO ragsis_app;
GRANT SELECT, INSERT ON agent_versions, agent_test_runs TO ragsis_app;
GRANT EXECUTE ON FUNCTION app.agent_same_tenant() TO ragsis_app;
