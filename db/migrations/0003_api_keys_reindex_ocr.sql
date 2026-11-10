-- API-01: claves de servicio por tenant con scopes, alcance por workspace, expiración y revocación.
-- RAG-03: parámetros de jobs de reindexado. F3: contabilidad de páginas OCR.

CREATE TABLE service_api_keys (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  service_user_id uuid NOT NULL REFERENCES users(id),
  name            text NOT NULL,
  prefix          text NOT NULL UNIQUE,            -- identificador público (rsk_<prefix>_...)
  key_hash        text NOT NULL,                   -- sha256 hex del secreto; el secreto nunca se guarda
  scopes          text[] NOT NULL CHECK (scopes <@ ARRAY['query', 'documents:read', 'documents:write']::text[]
                                         AND cardinality(scopes) > 0),
  workspace_ids   uuid[] NOT NULL CHECK (cardinality(workspace_ids) > 0),
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz,
  last_used_at    timestamptz,
  revoked_at      timestamptz
);
CREATE INDEX service_api_keys_org_idx ON service_api_keys (organization_id);

ALTER TABLE service_api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_api_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY api_keys_tenant ON service_api_keys FOR ALL TO ragsis_app
  USING (organization_id = app.org_id()) WITH CHECK (organization_id = app.org_id());
GRANT SELECT, INSERT, UPDATE ON service_api_keys TO ragsis_app;

-- Resolución de una clave ANTES de conocer el tenant. Comparación por hash; devuelve una fila solo
-- si la clave está vigente, y registra el último uso (con granularidad de 1 minuto).
CREATE OR REPLACE FUNCTION app.resolve_api_key(p_prefix text, p_hash text)
  RETURNS TABLE (key_id uuid, organization_id uuid, service_user_id uuid, scopes text[], workspace_ids uuid[])
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RETURN QUERY
    WITH hit AS (
      UPDATE service_api_keys k
         SET last_used_at = CASE WHEN k.last_used_at IS NULL OR k.last_used_at < now() - interval '1 minute'
                                 THEN now() ELSE k.last_used_at END
       WHERE k.prefix = p_prefix
         AND k.key_hash = p_hash
         AND k.revoked_at IS NULL
         AND (k.expires_at IS NULL OR k.expires_at > now())
         AND EXISTS (SELECT 1 FROM organizations o WHERE o.id = k.organization_id AND o.status = 'active')
      RETURNING k.id, k.organization_id, k.service_user_id, k.scopes, k.workspace_ids
    )
    SELECT h.id, h.organization_id, h.service_user_id, h.scopes, h.workspace_ids FROM hit h;
END $$;
REVOKE EXECUTE ON FUNCTION app.resolve_api_key(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_api_key(text, text) TO ragsis_app;

-- Usuario de servicio que respalda cada clave (autoría en query_runs/auditoría). Solo admins del tenant.
CREATE OR REPLACE FUNCTION app.create_service_user(p_key_id uuid) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  uid uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM memberships m
     WHERE m.organization_id = app.org_id() AND m.user_id = app.user_id()
       AND m.role IN ('owner', 'admin') AND m.status = 'active'
  ) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  INSERT INTO users (identity_provider, external_subject, email, display_name)
  VALUES ('ragsis-apikey', p_key_id::text, 'key-' || p_key_id::text || '@service.ragsis.invalid', 'API key')
  RETURNING id INTO uid;
  RETURN uid;
END $$;
REVOKE EXECUTE ON FUNCTION app.create_service_user(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_service_user(uuid) TO ragsis_app;

-- Parámetros de job (p. ej. reindex mode/target model).
ALTER TABLE ingestion_jobs ADD COLUMN params jsonb NOT NULL DEFAULT '{}';

-- Páginas procesadas por OCR (costo dominante de la ruta multimodal).
ALTER TABLE usage_events DROP CONSTRAINT usage_events_kind_check;
ALTER TABLE usage_events ADD CONSTRAINT usage_events_kind_check CHECK (kind IN (
  'query', 'ingest_pages', 'ingest_documents', 'embedding_tokens', 'llm_input_tokens', 'llm_output_tokens',
  'rerank_calls', 'storage_bytes', 'ocr_pages'));

ALTER TABLE document_versions ADD COLUMN ocr_provider text, ADD COLUMN ocr_mean_confidence real;
