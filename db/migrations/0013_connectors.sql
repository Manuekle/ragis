-- CON-01 · Conectores con sincronización incremental (ADR-025): Gmail (personal), Slack y ClickUp (organización).
--
-- Cada elemento sincronizado es un documento normal (documents/document_versions) con source_id
-- 'con:<connector_id>:<item>' y pasa por el mismo pipeline de ingesta. La ACL la fija el tipo de conector:
--   personal     → user:<owner>           (solo su dueño lo ve; ni los admins)
--   organization → workspace:<workspace>  (todos los miembros del workspace destino)
-- Los tokens OAuth se guardan cifrados (AES-256-GCM, AAD = conector) en connector_credentials y nunca salen por la API.

ALTER TABLE organizations
  ADD COLUMN allowed_connectors text[] NOT NULL DEFAULT '{gmail,slack,clickup}'
  CHECK (allowed_connectors <@ ARRAY['gmail', 'slack', 'clickup']::text[]);

CREATE TABLE connectors (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider             text NOT NULL CHECK (provider IN ('gmail', 'slack', 'clickup')),
  scope                text NOT NULL CHECK (scope IN ('personal', 'organization')),
  owner_id             uuid NOT NULL REFERENCES users(id),
  workspace_id         uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  external_account_id  text NOT NULL,
  account_label        text NOT NULL DEFAULT '',
  settings             jsonb NOT NULL DEFAULT '{}',
  status               text NOT NULL DEFAULT 'active'
                       CHECK (status IN ('needs_setup', 'active', 'paused', 'error')),
  cursor               jsonb NOT NULL DEFAULT '{}',
  next_sync_at         timestamptz,
  lease_until          timestamptz,
  last_sync_at         timestamptz,
  last_success_at      timestamptz,
  last_error_code      text,
  last_error_detail    text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK ((provider = 'gmail') = (scope = 'personal'))
);
-- Un Gmail por persona y organización; una cuenta externa (equipo Slack / workspace ClickUp) por organización.
CREATE UNIQUE INDEX connectors_personal_uq ON connectors (organization_id, provider, owner_id) WHERE scope = 'personal';
CREATE UNIQUE INDEX connectors_org_uq ON connectors (organization_id, provider, external_account_id) WHERE scope = 'organization';
CREATE INDEX connectors_due_idx ON connectors (next_sync_at) WHERE status = 'active';

CREATE TABLE connector_credentials (
  connector_id    uuid PRIMARY KEY REFERENCES connectors(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ciphertext      text NOT NULL,
  expires_at      timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Estado de cada elemento del origen: delta (hash/fecha), retirada por selección (container) y barrido (last_seen_at).
CREATE TABLE connector_items (
  connector_id      uuid NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_id         text NOT NULL,
  document_id       uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  container         text NOT NULL DEFAULT '',
  content_sha256    text,
  source_updated_at text,
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connector_id, source_id)
);
CREATE INDEX connector_items_container_idx ON connector_items (connector_id, container);

-- PKCE + state de un solo uso, ligado a la persona que inició la conexión (10 minutos).
CREATE TABLE connector_oauth_states (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider        text NOT NULL CHECK (provider IN ('gmail', 'slack', 'clickup')),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  state_hash      text NOT NULL UNIQUE,
  code_verifier   text NOT NULL,
  expires_at      timestamptz NOT NULL,
  consumed_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE connectors             ENABLE ROW LEVEL SECURITY; ALTER TABLE connectors             FORCE ROW LEVEL SECURITY;
ALTER TABLE connector_credentials  ENABLE ROW LEVEL SECURITY; ALTER TABLE connector_credentials  FORCE ROW LEVEL SECURITY;
ALTER TABLE connector_items        ENABLE ROW LEVEL SECURITY; ALTER TABLE connector_items        FORCE ROW LEVEL SECURITY;
ALTER TABLE connector_oauth_states ENABLE ROW LEVEL SECURITY; ALTER TABLE connector_oauth_states FORCE ROW LEVEL SECURITY;

-- Conectores de organización: visibles para el tenant. Personales: solo para su dueño.
CREATE POLICY connectors_tenant ON connectors FOR ALL TO ragsis_app
  USING (organization_id = app.org_id() AND (scope = 'organization' OR owner_id = app.user_id()))
  WITH CHECK (organization_id = app.org_id() AND (scope = 'organization' OR owner_id = app.user_id()));
CREATE POLICY connector_credentials_tenant ON connector_credentials FOR ALL TO ragsis_app
  USING (organization_id = app.org_id() AND EXISTS (SELECT 1 FROM connectors c WHERE c.id = connector_credentials.connector_id))
  WITH CHECK (organization_id = app.org_id() AND EXISTS (SELECT 1 FROM connectors c WHERE c.id = connector_credentials.connector_id));
CREATE POLICY connector_items_tenant ON connector_items FOR ALL TO ragsis_app
  USING (organization_id = app.org_id() AND EXISTS (SELECT 1 FROM connectors c WHERE c.id = connector_items.connector_id))
  WITH CHECK (organization_id = app.org_id() AND EXISTS (SELECT 1 FROM connectors c WHERE c.id = connector_items.connector_id));
CREATE POLICY connector_oauth_states_owner ON connector_oauth_states FOR ALL TO ragsis_app
  USING (organization_id = app.org_id() AND user_id = app.user_id())
  WITH CHECK (organization_id = app.org_id() AND user_id = app.user_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON connectors, connector_credentials, connector_items, connector_oauth_states TO ragsis_app;

-- Planificador: conectores listos para sincronizar en todos los tenants (solo IDs; el trabajo corre con RLS del dueño).
CREATE FUNCTION app.due_connectors(p_limit integer)
  RETURNS TABLE (organization_id uuid, connector_id uuid, owner_id uuid, workspace_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT c.organization_id, c.id, c.owner_id, c.workspace_id
      FROM connectors c
      JOIN organizations o ON o.id = c.organization_id AND o.status = 'active'
     WHERE c.status = 'active'
       AND c.next_sync_at <= now()
       AND (c.lease_until IS NULL OR c.lease_until < now())
       AND c.provider = ANY (o.allowed_connectors)
     ORDER BY c.next_sync_at
     LIMIT least(greatest(p_limit, 1), 50)
  $$;
REVOKE ALL ON FUNCTION app.due_connectors(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.due_connectors(integer) TO ragsis_app;
