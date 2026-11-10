-- ragsis · esquema inicial (control plane + data plane en pool controlado)
-- Frontera de tenant: organization_id + Row Level Security (RLS) FORZADA.
-- Roles de aplicación (sin BYPASSRLS):
--   ragsis_app    -> API / rag-engine: visibilidad por tenant + ACL de documento.
--   ragsis_worker -> ingest-worker: visibilidad por tenant (sin ACL de usuario).
-- El contexto de seguridad se fija por transacción con:
--   SET LOCAL app.org_id, app.user_id, app.principals ('user:<id>,workspace:<id>,group:<id>')

CREATE EXTENSION IF NOT EXISTS vector;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ragsis_app') THEN
    CREATE ROLE ragsis_app NOLOGIN NOBYPASSRLS NOSUPERUSER;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ragsis_worker') THEN
    CREATE ROLE ragsis_worker NOLOGIN NOBYPASSRLS NOSUPERUSER;
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS app;

CREATE OR REPLACE FUNCTION app.org_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.org_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION app.user_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION app.principals() RETURNS text[]
  LANGUAGE sql STABLE AS $$
    SELECT COALESCE(string_to_array(NULLIF(current_setting('app.principals', true), ''), ','), '{}'::text[])
  $$;

-- ---------------------------------------------------------------------------
-- Catálogo de planes (global, sin datos de cliente)
-- ---------------------------------------------------------------------------
CREATE TABLE plans (
  id                    text PRIMARY KEY,
  display_name          text NOT NULL,
  max_documents         integer NOT NULL,
  max_storage_bytes     bigint  NOT NULL,
  max_upload_bytes      bigint  NOT NULL,
  max_pages_per_doc     integer NOT NULL,
  max_queries_month     integer NOT NULL,
  max_context_tokens    integer NOT NULL,
  rerank_enabled        boolean NOT NULL DEFAULT false,
  queries_per_minute    integer NOT NULL
);

INSERT INTO plans VALUES
  ('team',     'Team Cloud',      2000,   5368709120,  52428800,  500,   3000,  6000, false, 30),
  ('business', 'Business Cloud', 20000,  53687091200, 104857600, 2000,  20000, 12000, true, 120),
  ('private',  'Private Cloud', 200000, 536870912000, 524288000, 5000, 200000, 24000, true, 600);

-- ---------------------------------------------------------------------------
-- Identidad y tenancy
-- ---------------------------------------------------------------------------
CREATE TABLE organizations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  slug          text NOT NULL UNIQUE,
  plan_id       text NOT NULL DEFAULT 'team' REFERENCES plans(id),
  data_class    text NOT NULL DEFAULT 'internal'
                CHECK (data_class IN ('public', 'internal', 'confidential', 'restricted')),
  region_policy text NOT NULL DEFAULT 'us-east-1',
  model_allowlist text[] NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_provider text NOT NULL,
  external_subject  text NOT NULL,
  email             text NOT NULL,
  display_name      text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (identity_provider, external_subject)
);

CREATE TABLE memberships (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invited', 'disabled')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships (user_id);

CREATE TABLE workspaces (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

CREATE TABLE workspace_members (
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            text NOT NULL DEFAULT 'reader' CHECK (role IN ('editor', 'reader')),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE groups (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  UNIQUE (organization_id, name)
);

CREATE TABLE group_members (
  group_id        uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, user_id)
);

-- ---------------------------------------------------------------------------
-- Documentos, versiones, ACL
-- ---------------------------------------------------------------------------
CREATE TABLE documents (
  id                 uuid PRIMARY KEY,
  organization_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id       uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_id          text,
  title              text NOT NULL,
  classification     text NOT NULL DEFAULT 'internal'
                     CHECK (classification IN ('public', 'internal', 'confidential', 'restricted')),
  owner_id           uuid REFERENCES users(id),
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleting', 'deleted')),
  current_version_id uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, workspace_id, source_id)
);
CREATE INDEX documents_org_ws_idx ON documents (organization_id, workspace_id, status);

-- principal: 'workspace:<uuid>' | 'group:<uuid>' | 'user:<uuid>'
CREATE TABLE document_acl (
  document_id     uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  principal       text NOT NULL CHECK (principal ~ '^(workspace|group|user):[0-9a-f-]{36}$'),
  permission      text NOT NULL DEFAULT 'read' CHECK (permission IN ('read')),
  PRIMARY KEY (document_id, principal)
);
CREATE INDEX document_acl_principal_idx ON document_acl (organization_id, principal);

CREATE TABLE document_versions (
  id               uuid PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  document_id      uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_no       integer NOT NULL,
  filename         text NOT NULL,
  content_type     text NOT NULL,
  declared_size    bigint NOT NULL,
  size_bytes       bigint,
  checksum_sha256  text,
  s3_key           text NOT NULL,
  status           text NOT NULL DEFAULT 'pending_upload'
                   CHECK (status IN ('pending_upload', 'uploaded', 'quarantined', 'validated', 'parsing',
                                     'enriched', 'embedding', 'indexed', 'superseded', 'failed', 'rejected')),
  error_code       text,
  error_detail     text,
  parser           text,
  parser_version   text,
  pipeline_version text,
  embedding_model  text,
  page_count       integer,
  chunk_count      integer,
  effective_from   date,
  effective_to     date,
  is_current       boolean NOT NULL DEFAULT false,
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  indexed_at       timestamptz,
  UNIQUE (document_id, version_no)
);
CREATE INDEX document_versions_doc_idx ON document_versions (document_id, is_current);

ALTER TABLE documents
  ADD CONSTRAINT documents_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES document_versions(id) DEFERRABLE INITIALLY DEFERRED;

-- ---------------------------------------------------------------------------
-- Chunks + embeddings (derivados y reconstruibles)
-- ---------------------------------------------------------------------------
CREATE TABLE chunks (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_id     uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_id      uuid NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  ordinal         integer NOT NULL,
  section_path    text NOT NULL DEFAULT '',
  page_start      integer,
  page_end        integer,
  char_start      integer,
  char_end        integer,
  kind            text NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'table', 'figure')),
  text            text NOT NULL,
  token_count     integer NOT NULL,
  pii_flags       text[] NOT NULL DEFAULT '{}',
  index_state     text NOT NULL DEFAULT 'building'
                  CHECK (index_state IN ('building', 'active', 'superseded', 'deleted')),
  tsv             tsvector GENERATED ALWAYS AS (
                    setweight(to_tsvector('spanish', coalesce(section_path, '')), 'B') ||
                    setweight(to_tsvector('spanish', text), 'A') ||
                    to_tsvector('simple', text)
                  ) STORED,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (version_id, ordinal)
);
CREATE INDEX chunks_scope_idx ON chunks (organization_id, workspace_id, index_state);
CREATE INDEX chunks_doc_idx ON chunks (document_id, version_id);
CREATE INDEX chunks_tsv_idx ON chunks USING gin (tsv);

-- Todos los modelos de embeddings admitidos producen 1024 dimensiones
-- (Titan v2 / Cohere multilingual / BGE-M3 / e5-large / hash local).
-- model_version separa espacios vectoriales incompatibles: nunca se mezclan.
CREATE TABLE chunk_embeddings (
  chunk_id        uuid NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  document_id     uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  model_version   text NOT NULL,
  embedding       vector(1024) NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chunk_id, model_version)
);
CREATE INDEX chunk_embeddings_hnsw_idx ON chunk_embeddings USING hnsw (embedding vector_cosine_ops);
CREATE INDEX chunk_embeddings_scope_idx ON chunk_embeddings (organization_id, model_version);

-- ---------------------------------------------------------------------------
-- Jobs, consultas, uso y auditoría
-- ---------------------------------------------------------------------------
CREATE TABLE ingestion_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('ingest', 'delete', 'reindex')),
  document_id     uuid NOT NULL,
  version_id      uuid,
  idempotency_key text NOT NULL,
  state           text NOT NULL DEFAULT 'queued'
                  CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'dead')),
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, idempotency_key)
);

CREATE TABLE query_runs (
  id                 text PRIMARY KEY,               -- trace_id: qry_<...>
  organization_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id       uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES users(id),
  question_sha256    text NOT NULL,                  -- no se guarda el prompt completo por defecto
  question_class     text NOT NULL,
  strategy           text NOT NULL,
  generation_model   text,
  embedding_model    text,
  abstained          boolean NOT NULL,
  abstain_reason     text,
  latency_ms         integer NOT NULL,
  timings            jsonb NOT NULL DEFAULT '{}',
  prompt_tokens      integer NOT NULL DEFAULT 0,
  completion_tokens  integer NOT NULL DEFAULT 0,
  cost_estimate_usd  numeric(12, 6) NOT NULL DEFAULT 0,
  retrieved_refs     jsonb NOT NULL DEFAULT '[]',
  feedback           smallint CHECK (feedback IN (-1, 1)),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX query_runs_org_created_idx ON query_runs (organization_id, created_at DESC);

CREATE TABLE citations (
  query_run_id    text NOT NULL REFERENCES query_runs(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ordinal         integer NOT NULL,
  chunk_id        uuid NOT NULL,
  document_id     uuid NOT NULL,
  version_id      uuid NOT NULL,
  page            integer,
  PRIMARY KEY (query_run_id, ordinal)
);

CREATE TABLE usage_events (
  id              bigserial PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('query', 'ingest_pages', 'ingest_documents', 'embedding_tokens',
                                                'llm_input_tokens', 'llm_output_tokens', 'rerank_calls',
                                                'storage_bytes')),
  quantity        numeric NOT NULL,
  ref             text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_events_org_kind_idx ON usage_events (organization_id, kind, created_at);

CREATE TABLE audit_events (
  id              bigserial PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_id        uuid,
  action          text NOT NULL,
  resource        text NOT NULL,
  decision        text NOT NULL CHECK (decision IN ('allow', 'deny')),
  metadata        jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  prev_hash       text,
  hash            text NOT NULL
);
CREATE INDEX audit_events_org_idx ON audit_events (organization_id, id);

-- Cadena de hashes por tenant: evidencia de manipulación del registro de auditoría.
CREATE OR REPLACE FUNCTION app.audit_chain() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  prev text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('audit:' || NEW.organization_id::text));
  SELECT a.hash INTO prev FROM audit_events a
   WHERE a.organization_id = NEW.organization_id ORDER BY a.id DESC LIMIT 1;
  NEW.prev_hash := prev;
  NEW.hash := encode(sha256(convert_to(
      coalesce(prev, '') || '|' || NEW.organization_id::text || '|' || coalesce(NEW.actor_id::text, '') || '|' ||
      NEW.action || '|' || NEW.resource || '|' || NEW.decision || '|' || NEW.metadata::text || '|' ||
      to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), 'UTF8')), 'hex');
  RETURN NEW;
END $$;

CREATE TRIGGER audit_events_chain BEFORE INSERT ON audit_events
  FOR EACH ROW EXECUTE FUNCTION app.audit_chain();

-- Alta/actualización de identidad federada sin exponer la tabla users completa.
CREATE OR REPLACE FUNCTION app.upsert_user(p_idp text, p_subject text, p_email text, p_name text)
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  uid uuid;
BEGIN
  INSERT INTO users (identity_provider, external_subject, email, display_name)
  VALUES (p_idp, p_subject, lower(p_email), p_name)
  ON CONFLICT (identity_provider, external_subject)
    DO UPDATE SET email = EXCLUDED.email, display_name = COALESCE(EXCLUDED.display_name, users.display_name)
  RETURNING id INTO uid;
  RETURN uid;
END $$;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
ALTER TABLE organizations      ENABLE ROW LEVEL SECURITY;  ALTER TABLE organizations      FORCE ROW LEVEL SECURITY;
ALTER TABLE users              ENABLE ROW LEVEL SECURITY;  ALTER TABLE users              FORCE ROW LEVEL SECURITY;
ALTER TABLE memberships        ENABLE ROW LEVEL SECURITY;  ALTER TABLE memberships        FORCE ROW LEVEL SECURITY;
ALTER TABLE workspaces         ENABLE ROW LEVEL SECURITY;  ALTER TABLE workspaces         FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_members  ENABLE ROW LEVEL SECURITY;  ALTER TABLE workspace_members  FORCE ROW LEVEL SECURITY;
ALTER TABLE groups             ENABLE ROW LEVEL SECURITY;  ALTER TABLE groups             FORCE ROW LEVEL SECURITY;
ALTER TABLE group_members      ENABLE ROW LEVEL SECURITY;  ALTER TABLE group_members      FORCE ROW LEVEL SECURITY;
ALTER TABLE documents          ENABLE ROW LEVEL SECURITY;  ALTER TABLE documents          FORCE ROW LEVEL SECURITY;
ALTER TABLE document_acl       ENABLE ROW LEVEL SECURITY;  ALTER TABLE document_acl       FORCE ROW LEVEL SECURITY;
ALTER TABLE document_versions  ENABLE ROW LEVEL SECURITY;  ALTER TABLE document_versions  FORCE ROW LEVEL SECURITY;
ALTER TABLE chunks             ENABLE ROW LEVEL SECURITY;  ALTER TABLE chunks             FORCE ROW LEVEL SECURITY;
ALTER TABLE chunk_embeddings   ENABLE ROW LEVEL SECURITY;  ALTER TABLE chunk_embeddings   FORCE ROW LEVEL SECURITY;
ALTER TABLE ingestion_jobs     ENABLE ROW LEVEL SECURITY;  ALTER TABLE ingestion_jobs     FORCE ROW LEVEL SECURITY;
ALTER TABLE query_runs         ENABLE ROW LEVEL SECURITY;  ALTER TABLE query_runs         FORCE ROW LEVEL SECURITY;
ALTER TABLE citations          ENABLE ROW LEVEL SECURITY;  ALTER TABLE citations          FORCE ROW LEVEL SECURITY;
ALTER TABLE usage_events       ENABLE ROW LEVEL SECURITY;  ALTER TABLE usage_events       FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_events       ENABLE ROW LEVEL SECURITY;  ALTER TABLE audit_events       FORCE ROW LEVEL SECURITY;

-- organizations: el usuario ve el tenant activo y aquellos donde tiene membresía.
CREATE POLICY org_select ON organizations FOR SELECT TO ragsis_app USING (
  id = app.org_id()
  OR EXISTS (SELECT 1 FROM memberships m WHERE m.organization_id = organizations.id AND m.user_id = app.user_id())
);
CREATE POLICY org_insert ON organizations FOR INSERT TO ragsis_app WITH CHECK (id = app.org_id());
CREATE POLICY org_update ON organizations FOR UPDATE TO ragsis_app USING (id = app.org_id()) WITH CHECK (id = app.org_id());
CREATE POLICY org_worker ON organizations FOR SELECT TO ragsis_worker USING (id = app.org_id());

-- users: uno mismo y los miembros del tenant activo.
CREATE POLICY users_select ON users FOR SELECT TO ragsis_app USING (
  id = app.user_id()
  OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = users.id AND m.organization_id = app.org_id())
);

-- memberships: las propias (para resolver tenants) y las del tenant activo.
CREATE POLICY memberships_select ON memberships FOR SELECT TO ragsis_app USING (
  user_id = app.user_id() OR organization_id = app.org_id()
);
CREATE POLICY memberships_write ON memberships FOR INSERT TO ragsis_app WITH CHECK (organization_id = app.org_id());
CREATE POLICY memberships_update ON memberships FOR UPDATE TO ragsis_app
  USING (organization_id = app.org_id()) WITH CHECK (organization_id = app.org_id());
CREATE POLICY memberships_delete ON memberships FOR DELETE TO ragsis_app USING (organization_id = app.org_id());

-- Tablas de tenant con frontera simple (todas las operaciones, ambos roles).
CREATE POLICY ws_tenant ON workspaces FOR ALL TO ragsis_app, ragsis_worker
  USING (organization_id = app.org_id()) WITH CHECK (organization_id = app.org_id());
CREATE POLICY wsm_tenant ON workspace_members FOR ALL TO ragsis_app, ragsis_worker
  USING (organization_id = app.org_id()) WITH CHECK (organization_id = app.org_id());
CREATE POLICY groups_tenant ON groups FOR ALL TO ragsis_app, ragsis_worker
  USING (organization_id = app.org_id()) WITH CHECK (organization_id = app.org_id());
CREATE POLICY gm_tenant ON group_members FOR ALL TO ragsis_app, ragsis_worker
  USING (organization_id = app.org_id()) WITH CHECK (organization_id = app.org_id());
CREATE POLICY acl_tenant ON document_acl FOR ALL TO ragsis_app, ragsis_worker
  USING (organization_id = app.org_id()) WITH CHECK (organization_id = app.org_id());
CREATE POLICY jobs_tenant ON ingestion_jobs FOR ALL TO ragsis_app, ragsis_worker
  USING (organization_id = app.org_id()) WITH CHECK (organization_id = app.org_id());
CREATE POLICY usage_tenant ON usage_events FOR ALL TO ragsis_app, ragsis_worker
  USING (organization_id = app.org_id()) WITH CHECK (organization_id = app.org_id());
CREATE POLICY audit_select ON audit_events FOR SELECT TO ragsis_app, ragsis_worker USING (organization_id = app.org_id());
CREATE POLICY audit_insert ON audit_events FOR INSERT TO ragsis_app, ragsis_worker WITH CHECK (organization_id = app.org_id());

-- Documentos y derivados: ragsis_app exige tenant + ACL efectiva (pre-retrieval, en la BD).
CREATE POLICY docs_app_select ON documents FOR SELECT TO ragsis_app USING (
  organization_id = app.org_id()
  AND EXISTS (SELECT 1 FROM document_acl a WHERE a.document_id = documents.id AND a.principal = ANY (app.principals()))
);
CREATE POLICY docs_app_insert ON documents FOR INSERT TO ragsis_app WITH CHECK (organization_id = app.org_id());
CREATE POLICY docs_app_update ON documents FOR UPDATE TO ragsis_app USING (
  organization_id = app.org_id()
  AND EXISTS (SELECT 1 FROM document_acl a WHERE a.document_id = documents.id AND a.principal = ANY (app.principals()))
) WITH CHECK (organization_id = app.org_id());
CREATE POLICY docs_worker ON documents FOR ALL TO ragsis_worker
  USING (organization_id = app.org_id()) WITH CHECK (organization_id = app.org_id());

CREATE POLICY versions_app_select ON document_versions FOR SELECT TO ragsis_app USING (
  organization_id = app.org_id()
  AND EXISTS (SELECT 1 FROM document_acl a WHERE a.document_id = document_versions.document_id AND a.principal = ANY (app.principals()))
);
CREATE POLICY versions_app_insert ON document_versions FOR INSERT TO ragsis_app WITH CHECK (organization_id = app.org_id());
CREATE POLICY versions_app_update ON document_versions FOR UPDATE TO ragsis_app USING (
  organization_id = app.org_id()
  AND EXISTS (SELECT 1 FROM document_acl a WHERE a.document_id = document_versions.document_id AND a.principal = ANY (app.principals()))
) WITH CHECK (organization_id = app.org_id());
CREATE POLICY versions_worker ON document_versions FOR ALL TO ragsis_worker
  USING (organization_id = app.org_id()) WITH CHECK (organization_id = app.org_id());

CREATE POLICY chunks_app_select ON chunks FOR SELECT TO ragsis_app USING (
  organization_id = app.org_id()
  AND EXISTS (SELECT 1 FROM document_acl a WHERE a.document_id = chunks.document_id AND a.principal = ANY (app.principals()))
);
CREATE POLICY chunks_worker ON chunks FOR ALL TO ragsis_worker
  USING (organization_id = app.org_id()) WITH CHECK (organization_id = app.org_id());

CREATE POLICY emb_app_select ON chunk_embeddings FOR SELECT TO ragsis_app USING (
  organization_id = app.org_id()
  AND EXISTS (SELECT 1 FROM document_acl a WHERE a.document_id = chunk_embeddings.document_id AND a.principal = ANY (app.principals()))
);
CREATE POLICY emb_worker ON chunk_embeddings FOR ALL TO ragsis_worker
  USING (organization_id = app.org_id()) WITH CHECK (organization_id = app.org_id());

-- Consultas: cada usuario ve sus propias ejecuciones dentro del tenant.
CREATE POLICY qr_select ON query_runs FOR SELECT TO ragsis_app
  USING (organization_id = app.org_id() AND user_id = app.user_id());
CREATE POLICY qr_insert ON query_runs FOR INSERT TO ragsis_app
  WITH CHECK (organization_id = app.org_id() AND user_id = app.user_id());
CREATE POLICY qr_update ON query_runs FOR UPDATE TO ragsis_app
  USING (organization_id = app.org_id() AND user_id = app.user_id())
  WITH CHECK (organization_id = app.org_id() AND user_id = app.user_id());
CREATE POLICY cit_select ON citations FOR SELECT TO ragsis_app USING (
  organization_id = app.org_id()
  AND EXISTS (SELECT 1 FROM query_runs q WHERE q.id = citations.query_run_id AND q.user_id = app.user_id())
);
CREATE POLICY cit_insert ON citations FOR INSERT TO ragsis_app WITH CHECK (organization_id = app.org_id());

-- ---------------------------------------------------------------------------
-- Privilegios mínimos
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public, app TO ragsis_app, ragsis_worker;
GRANT EXECUTE ON FUNCTION app.org_id(), app.user_id(), app.principals() TO ragsis_app, ragsis_worker;
GRANT EXECUTE ON FUNCTION app.upsert_user(text, text, text, text) TO ragsis_app;
REVOKE EXECUTE ON FUNCTION app.upsert_user(text, text, text, text) FROM PUBLIC;

GRANT SELECT ON plans TO ragsis_app, ragsis_worker;
GRANT SELECT, INSERT, UPDATE ON organizations TO ragsis_app;
GRANT SELECT ON organizations TO ragsis_worker;
GRANT SELECT ON users TO ragsis_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON memberships, workspaces, workspace_members, groups, group_members, document_acl
  TO ragsis_app;
GRANT SELECT, INSERT, UPDATE ON documents, document_versions TO ragsis_app;
GRANT SELECT ON chunks, chunk_embeddings TO ragsis_app;
GRANT SELECT, INSERT, UPDATE ON ingestion_jobs, query_runs TO ragsis_app;
GRANT SELECT, INSERT ON citations, usage_events, audit_events TO ragsis_app;
GRANT USAGE ON SEQUENCE usage_events_id_seq, audit_events_id_seq TO ragsis_app, ragsis_worker;

GRANT SELECT ON workspaces, workspace_members, groups, group_members TO ragsis_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON documents, document_versions, document_acl, chunks, chunk_embeddings,
  ingestion_jobs TO ragsis_worker;
GRANT SELECT, INSERT ON usage_events, audit_events TO ragsis_worker;
