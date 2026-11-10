-- ragsis · Firma electrónica y distribución controlada (ADR-023)
-- Hito F de la "Especificación Onboarding inteligente y Agent Studio" v1.0: P2-01 adapter de firma, P2-02 compartición.
--
-- Reglas: la IA nunca firma; SIGNED solo por evento verificado del proveedor; webhooks idempotentes por event_id;
-- compartir solo a dominios permitidos, con caducidad y revocación; el token de un enlace nunca se guarda en claro.

-- ---------------------------------------------------------------------------
-- Política externa del tenant
-- ---------------------------------------------------------------------------
CREATE TABLE external_policies (
  organization_id           uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  allowed_domains           text[] NOT NULL DEFAULT '{}',
  share_max_days            integer NOT NULL DEFAULT 7 CHECK (share_max_days BETWEEN 1 AND 30),
  approval_max_age_hours    integer NOT NULL DEFAULT 24 CHECK (approval_max_age_hours BETWEEN 1 AND 168),
  require_mfa_for_signature boolean NOT NULL DEFAULT false,
  updated_by                uuid REFERENCES users(id),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Ciclo de vida de negocio por versión de documento
-- DRAFT / UNDER_REVIEW / APPROVED / SIGNATURE_PENDING / SIGNED / DISTRIBUTED / ARCHIVED
-- ---------------------------------------------------------------------------
CREATE TABLE document_lifecycle (
  version_id      uuid PRIMARY KEY REFERENCES document_versions(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  document_id     uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  state           text NOT NULL CHECK (state IN ('DRAFT', 'UNDER_REVIEW', 'APPROVED', 'SIGNATURE_PENDING', 'SIGNED', 'DISTRIBUTED', 'ARCHIVED')),
  approval_id     uuid REFERENCES approvals(id) ON DELETE SET NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Sobres de firma (estado fuente: proveedor verificado, nunca declaración de un agente)
-- ---------------------------------------------------------------------------
CREATE TABLE signature_envelopes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id          uuid REFERENCES workflow_runs(id) ON DELETE SET NULL,
  provider        text NOT NULL CHECK (provider IN ('local', 'docusign')),
  external_id     text,
  state           text NOT NULL DEFAULT 'DRAFT' CHECK (state IN ('DRAFT', 'SENT', 'DELIVERED', 'COMPLETED', 'DECLINED', 'VOIDED')),
  documents       jsonb NOT NULL,          -- [{document_id, version_id, title, filename, sha256, s3_key}]
  signers         jsonb NOT NULL,          -- [{name, email}]
  idempotency_key text NOT NULL,
  created_by      uuid NOT NULL REFERENCES users(id),
  sent_by         uuid REFERENCES users(id),
  sent_at         timestamptz,
  completed_at    timestamptz,
  voided_reason   text,
  evidence        jsonb NOT NULL DEFAULT '{}',  -- {signed_key, certificate_key, signed_sha256, certificate_sha256}
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, idempotency_key),
  UNIQUE (provider, external_id)
);
CREATE INDEX signature_envelopes_org_idx ON signature_envelopes (organization_id, created_at DESC);

-- Ceremonia del proveedor de desarrollo: registro de quién firmó, con qué consentimiento y desde dónde.
CREATE TABLE local_signatures (
  envelope_id     uuid NOT NULL REFERENCES signature_envelopes(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  signer_email    text NOT NULL,
  signed_by       uuid NOT NULL REFERENCES users(id),
  decision        text NOT NULL CHECK (decision IN ('signed', 'declined')),
  typed_name      text NOT NULL,
  consent_text    text NOT NULL,
  ip              text,
  user_agent      text,
  signed_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (envelope_id, signer_email)
);

-- Inbox de webhooks: un evento se procesa una sola vez (replay ⇒ duplicado sin efectos).
CREATE TABLE webhook_inbox (
  provider        text NOT NULL,
  event_id        text NOT NULL,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  envelope_id     uuid REFERENCES signature_envelopes(id) ON DELETE SET NULL,
  status          text NOT NULL,
  payload_hash    text NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);

-- ---------------------------------------------------------------------------
-- Compartición controlada
-- ---------------------------------------------------------------------------
CREATE TABLE shares (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id          uuid REFERENCES workflow_runs(id) ON DELETE SET NULL,
  step_id         uuid REFERENCES run_steps(id) ON DELETE SET NULL,
  artifact        text NOT NULL CHECK (artifact IN ('document', 'signed')),
  document_id     uuid REFERENCES documents(id) ON DELETE CASCADE,
  version_id      uuid REFERENCES document_versions(id) ON DELETE CASCADE,
  envelope_id     uuid REFERENCES signature_envelopes(id) ON DELETE CASCADE,
  title           text NOT NULL,
  filename        text NOT NULL,
  s3_key          text NOT NULL,
  token_hash      text NOT NULL UNIQUE,
  recipients      text[] NOT NULL,
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  created_by      uuid NOT NULL REFERENCES users(id),
  approved_by     uuid REFERENCES users(id),
  access_count    integer NOT NULL DEFAULT 0,
  last_access_at  timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shares_org_idx ON shares (organization_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
ALTER TABLE external_policies   ENABLE ROW LEVEL SECURITY;  ALTER TABLE external_policies   FORCE ROW LEVEL SECURITY;
ALTER TABLE document_lifecycle  ENABLE ROW LEVEL SECURITY;  ALTER TABLE document_lifecycle  FORCE ROW LEVEL SECURITY;
ALTER TABLE signature_envelopes ENABLE ROW LEVEL SECURITY;  ALTER TABLE signature_envelopes FORCE ROW LEVEL SECURITY;
ALTER TABLE local_signatures    ENABLE ROW LEVEL SECURITY;  ALTER TABLE local_signatures    FORCE ROW LEVEL SECURITY;
ALTER TABLE webhook_inbox       ENABLE ROW LEVEL SECURITY;  ALTER TABLE webhook_inbox       FORCE ROW LEVEL SECURITY;
ALTER TABLE shares              ENABLE ROW LEVEL SECURITY;  ALTER TABLE shares              FORCE ROW LEVEL SECURITY;

CREATE POLICY extpol_tenant ON external_policies FOR ALL TO ragsis_app
  USING (organization_id = app.org_id()) WITH CHECK (organization_id = app.org_id());
CREATE POLICY lifecycle_tenant ON document_lifecycle FOR ALL TO ragsis_app
  USING (organization_id = app.org_id()) WITH CHECK (organization_id = app.org_id());
CREATE POLICY envelopes_tenant ON signature_envelopes FOR ALL TO ragsis_app
  USING (organization_id = app.org_id()) WITH CHECK (organization_id = app.org_id());
CREATE POLICY localsig_tenant ON local_signatures FOR ALL TO ragsis_app
  USING (organization_id = app.org_id()) WITH CHECK (organization_id = app.org_id());
CREATE POLICY webhook_tenant ON webhook_inbox FOR ALL TO ragsis_app
  USING (organization_id = app.org_id()) WITH CHECK (organization_id = app.org_id());
CREATE POLICY shares_tenant ON shares FOR ALL TO ragsis_app
  USING (organization_id = app.org_id()) WITH CHECK (organization_id = app.org_id());

-- ---------------------------------------------------------------------------
-- Funciones sin contexto de tenant (webhooks y enlaces públicos). Devuelven lo mínimo.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.envelope_by_external(p_provider text, p_external_id text)
  RETURNS TABLE (organization_id uuid, envelope_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT e.organization_id, e.id FROM signature_envelopes e WHERE e.provider = p_provider AND e.external_id = p_external_id
  $$;

-- Acceso público a un enlace: valida token (hash), caducidad y revocación; registra el intento en auditoría.
CREATE OR REPLACE FUNCTION app.open_share(p_token_hash text, p_ip text)
  RETURNS TABLE (status text, s3_key text, filename text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  s shares%ROWTYPE;
  st text;
BEGIN
  SELECT * INTO s FROM shares WHERE token_hash = p_token_hash;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text;
    RETURN;
  END IF;
  st := CASE WHEN s.revoked_at IS NOT NULL THEN 'revoked' WHEN s.expires_at < now() THEN 'expired' ELSE 'ok' END;
  IF st = 'ok' THEN
    UPDATE shares SET access_count = access_count + 1, last_access_at = now() WHERE id = s.id;
  END IF;
  INSERT INTO audit_events (organization_id, actor_id, action, resource, decision, metadata)
  VALUES (s.organization_id, NULL, 'share.accessed', 'share:' || s.id, CASE WHEN st = 'ok' THEN 'allow' ELSE 'deny' END,
          jsonb_build_object('status', st, 'ip', p_ip));
  RETURN QUERY SELECT st, CASE WHEN st = 'ok' THEN s.s3_key END, CASE WHEN st = 'ok' THEN s.filename END;
END $$;

REVOKE EXECUTE ON FUNCTION app.envelope_by_external(text, text), app.open_share(text, text) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Privilegios
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON external_policies, document_lifecycle, signature_envelopes, shares TO ragsis_app;
GRANT SELECT, INSERT ON local_signatures, webhook_inbox TO ragsis_app;
GRANT EXECUTE ON FUNCTION app.envelope_by_external(text, text), app.open_share(text, text) TO ragsis_app;
