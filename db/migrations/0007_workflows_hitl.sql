-- ragsis · Workflows durables + human-in-the-loop (ADR-022)
-- Hito E de la "Especificación Onboarding inteligente y Agent Studio" v1.0:
-- P1-02 runner + Approval Inbox, P1-03 delegación limitada, P1-04 auditoría/trazas de run.
--
-- Estado durable en Postgres (cada transición se persiste antes de ejecutar la siguiente).
-- Eventos de dominio en outbox transaccional; el despacho a EventBridge/SQS es un adaptador posterior.

-- ---------------------------------------------------------------------------
-- Roles funcionales (además del rol de organización): separación de funciones.
-- ---------------------------------------------------------------------------
CREATE TABLE functional_roles (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('reviewer', 'approver', 'signatory', 'auditor', 'agent_designer', 'knowledge_manager')),
  granted_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id, role)
);

-- ---------------------------------------------------------------------------
-- Workflows: grafo draft mutable + versiones publicadas inmutables (agentes fijados por versión)
-- ---------------------------------------------------------------------------
CREATE TABLE workflows (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  slug              text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,60}$'),
  name              text NOT NULL,
  description       text NOT NULL DEFAULT '',
  template_code     text,
  owner_id          uuid NOT NULL REFERENCES users(id),
  status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'paused', 'archived')),
  draft_graph       jsonb NOT NULL,
  draft_hash        text NOT NULL,
  active_version_id uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, slug)
);

CREATE TABLE workflow_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workflow_id     uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  version         text NOT NULL CHECK (version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  graph           jsonb NOT NULL,          -- con agent_version_id resueltos al publicar
  graph_hash      text NOT NULL,
  policy_version  text NOT NULL,
  changelog       text NOT NULL DEFAULT '',
  published_by    uuid NOT NULL REFERENCES users(id),
  published_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, version)
);

ALTER TABLE workflows
  ADD CONSTRAINT workflows_active_version_fk
  FOREIGN KEY (active_version_id) REFERENCES workflow_versions(id) DEFERRABLE INITIALLY DEFERRED;

-- ---------------------------------------------------------------------------
-- Ejecuciones
-- ---------------------------------------------------------------------------
CREATE TABLE workflow_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workflow_id         uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  workflow_version_id uuid NOT NULL REFERENCES workflow_versions(id),
  initiated_by        uuid NOT NULL REFERENCES users(id),
  state               text NOT NULL DEFAULT 'QUEUED'
                      CHECK (state IN ('QUEUED', 'RUNNING', 'WAITING_HUMAN', 'WAITING_EXTERNAL', 'COMPLETED', 'FAILED', 'CANCELLED')),
  idempotency_key     text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  input               jsonb NOT NULL,
  usage               jsonb NOT NULL DEFAULT '{"agent_calls": 0, "retrieval_calls": 0}',
  error_code          text,
  error_detail        text,
  policy_version      text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz,
  UNIQUE (organization_id, idempotency_key)
);
CREATE INDEX workflow_runs_org_idx ON workflow_runs (organization_id, created_at DESC);
CREATE INDEX workflow_runs_state_idx ON workflow_runs (state) WHERE state IN ('QUEUED', 'RUNNING');

CREATE TABLE run_steps (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id           uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  seq              integer NOT NULL,
  node_id          text NOT NULL,
  node_type        text NOT NULL,
  state            text NOT NULL CHECK (state IN ('RUNNING', 'WAITING', 'SUCCEEDED', 'FAILED', 'REJECTED', 'SKIPPED')),
  attempt          integer NOT NULL DEFAULT 1,
  hop              integer NOT NULL DEFAULT 0,
  agent_version_id uuid,
  output           jsonb NOT NULL DEFAULT '{}',
  error            text,
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  UNIQUE (run_id, node_id),
  UNIQUE (run_id, seq)
);

-- Aprobación vinculada a hash: documento(s) + versión + acción + propósito + vigencia. Si algo cambia, se invalida.
CREATE TABLE approvals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id          uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_id         uuid NOT NULL REFERENCES run_steps(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('review', 'approval')),
  title           text NOT NULL,
  assigned_role   text NOT NULL CHECK (assigned_role IN ('reviewer', 'approver', 'signatory')),
  binding         jsonb NOT NULL,
  action_hash     text NOT NULL,
  status          text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'REVOKED')),
  expires_at      timestamptz NOT NULL,
  decided_by      uuid REFERENCES users(id),
  decided_at      timestamptz,
  comment         text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX approvals_pending_idx ON approvals (organization_id, status, assigned_role);

-- Outbox transaccional de eventos de dominio (schema sección 14 de la especificación).
CREATE TABLE outbox_events (
  event_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type            text NOT NULL,
  schema_version  integer NOT NULL DEFAULT 1,
  correlation_id  text NOT NULL,
  aggregate_id    text NOT NULL,
  payload         jsonb NOT NULL,
  payload_hash    text NOT NULL,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  dispatched_at   timestamptz
);
CREATE INDEX outbox_pending_idx ON outbox_events (occurred_at) WHERE dispatched_at IS NULL;
CREATE INDEX outbox_correlation_idx ON outbox_events (organization_id, correlation_id, occurred_at);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
ALTER TABLE functional_roles  ENABLE ROW LEVEL SECURITY;  ALTER TABLE functional_roles  FORCE ROW LEVEL SECURITY;
ALTER TABLE workflows         ENABLE ROW LEVEL SECURITY;  ALTER TABLE workflows         FORCE ROW LEVEL SECURITY;
ALTER TABLE workflow_versions ENABLE ROW LEVEL SECURITY;  ALTER TABLE workflow_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE workflow_runs     ENABLE ROW LEVEL SECURITY;  ALTER TABLE workflow_runs     FORCE ROW LEVEL SECURITY;
ALTER TABLE run_steps         ENABLE ROW LEVEL SECURITY;  ALTER TABLE run_steps         FORCE ROW LEVEL SECURITY;
ALTER TABLE approvals         ENABLE ROW LEVEL SECURITY;  ALTER TABLE approvals         FORCE ROW LEVEL SECURITY;
ALTER TABLE outbox_events     ENABLE ROW LEVEL SECURITY;  ALTER TABLE outbox_events     FORCE ROW LEVEL SECURITY;

CREATE POLICY froles_tenant ON functional_roles FOR ALL TO ragsis_app
  USING (organization_id = app.org_id()) WITH CHECK (organization_id = app.org_id());
CREATE POLICY wf_tenant ON workflows FOR ALL TO ragsis_app
  USING (organization_id = app.org_id()) WITH CHECK (organization_id = app.org_id());
CREATE POLICY wfv_tenant ON workflow_versions FOR ALL TO ragsis_app
  USING (organization_id = app.org_id()) WITH CHECK (organization_id = app.org_id());
CREATE POLICY runs_tenant ON workflow_runs FOR ALL TO ragsis_app
  USING (organization_id = app.org_id()) WITH CHECK (organization_id = app.org_id());
CREATE POLICY steps_tenant ON run_steps FOR ALL TO ragsis_app
  USING (organization_id = app.org_id()) WITH CHECK (organization_id = app.org_id());
CREATE POLICY approvals_tenant ON approvals FOR ALL TO ragsis_app
  USING (organization_id = app.org_id()) WITH CHECK (organization_id = app.org_id());
CREATE POLICY outbox_tenant ON outbox_events FOR ALL TO ragsis_app
  USING (organization_id = app.org_id()) WITH CHECK (organization_id = app.org_id());

-- Procedencia coherente (SECURITY INVOKER: corre con la RLS del llamador).
CREATE OR REPLACE FUNCTION app.workflow_same_tenant() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME = 'workflow_versions' OR TG_TABLE_NAME = 'workflow_runs' THEN
    IF NOT EXISTS (SELECT 1 FROM workflows w WHERE w.id = NEW.workflow_id AND w.organization_id = NEW.organization_id) THEN
      RAISE EXCEPTION 'workflow/tenant mismatch' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM workflow_runs r WHERE r.id = NEW.run_id AND r.organization_id = NEW.organization_id) THEN
      RAISE EXCEPTION 'run/tenant mismatch' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER wfv_same_tenant BEFORE INSERT ON workflow_versions FOR EACH ROW EXECUTE FUNCTION app.workflow_same_tenant();
CREATE TRIGGER runs_same_tenant BEFORE INSERT ON workflow_runs FOR EACH ROW EXECUTE FUNCTION app.workflow_same_tenant();
CREATE TRIGGER steps_same_tenant BEFORE INSERT ON run_steps FOR EACH ROW EXECUTE FUNCTION app.workflow_same_tenant();
CREATE TRIGGER approvals_same_tenant BEFORE INSERT ON approvals FOR EACH ROW EXECUTE FUNCTION app.workflow_same_tenant();

-- Reanudación tras reinicio: el runner necesita saber qué runs quedaron a medias en cualquier tenant.
-- Solo devuelve identificadores (sin datos de cliente).
CREATE OR REPLACE FUNCTION app.pending_workflow_runs() RETURNS TABLE (organization_id uuid, run_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT r.organization_id, r.id FROM workflow_runs r WHERE r.state IN ('QUEUED', 'RUNNING') ORDER BY r.created_at LIMIT 500
  $$;
REVOKE EXECUTE ON FUNCTION app.pending_workflow_runs() FROM PUBLIC;

-- Binding de aprobaciones: ¿siguen vigentes las versiones aprobadas? Solo ids/estado del tenant activo, sin
-- contenido; permite invalidar una aprobación aunque el aprobador no pueda leer el documento (caso E2E 5).
CREATE OR REPLACE FUNCTION app.current_versions(p_ids uuid[]) RETURNS TABLE (document_id uuid, current_version_id uuid, status text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT d.id, d.current_version_id, d.status FROM documents d
     WHERE d.organization_id = app.org_id() AND d.id = ANY (p_ids)
  $$;
REVOKE EXECUTE ON FUNCTION app.current_versions(uuid[]) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Privilegios: versiones y eventos append-only.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, DELETE ON functional_roles TO ragsis_app;
GRANT SELECT, INSERT, UPDATE ON workflows, workflow_runs, run_steps, approvals TO ragsis_app;
GRANT SELECT, INSERT ON workflow_versions, outbox_events TO ragsis_app;
GRANT EXECUTE ON FUNCTION app.workflow_same_tenant(), app.pending_workflow_runs(), app.current_versions(uuid[]) TO ragsis_app;
