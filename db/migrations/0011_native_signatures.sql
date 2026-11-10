-- La evidencia histórica conserva el proveedor que la produjo.
ALTER TABLE signature_envelopes DROP CONSTRAINT signature_envelopes_provider_check;
ALTER TABLE signature_envelopes ADD CHECK (provider IN ('native', 'local', 'docusign'));
ALTER TABLE signature_envelopes ADD COLUMN subject text;

ALTER TABLE local_signatures RENAME TO signature_responses;
ALTER TABLE signature_responses ALTER COLUMN signed_by DROP NOT NULL;
ALTER TABLE signature_responses ADD COLUMN identity_method text NOT NULL DEFAULT 'legacy'
  CHECK (identity_method IN ('legacy', 'account', 'email_link'));

CREATE TABLE signature_invitations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  envelope_id      uuid NOT NULL REFERENCES signature_envelopes(id) ON DELETE CASCADE,
  signer_email     text NOT NULL,
  token_hash       text NOT NULL UNIQUE,
  expires_at       timestamptz NOT NULL,
  opened_at        timestamptz,
  sent_at          timestamptz,
  last_attempt_at  timestamptz,
  attempts         integer NOT NULL DEFAULT 0,
  delivery_kind    text NOT NULL DEFAULT 'invitation' CHECK (delivery_kind IN ('invitation','completed')),
  UNIQUE (envelope_id, signer_email)
);
CREATE INDEX signature_invites_pending ON signature_invitations (expires_at)
  WHERE sent_at IS NULL AND attempts < 5;

ALTER TABLE signature_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE signature_invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY signature_invites_tenant ON signature_invitations FOR ALL TO ragsis_app
  USING (organization_id = app.org_id()) WITH CHECK (organization_id = app.org_id());
GRANT SELECT, INSERT, UPDATE ON signature_invitations TO ragsis_app;

CREATE FUNCTION app.signature_invite_by_hash(p_hash text) RETURNS TABLE (organization_id uuid, envelope_id uuid, id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT i.organization_id, i.envelope_id, i.id FROM signature_invitations i
    JOIN organizations o ON o.id = i.organization_id AND o.status = 'active'
    WHERE i.token_hash = p_hash
  $$;

CREATE FUNCTION app.pending_signature_invites() RETURNS TABLE (organization_id uuid, envelope_id uuid, id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT i.organization_id, i.envelope_id, i.id FROM signature_invitations i
    JOIN signature_envelopes e ON e.id = i.envelope_id
    JOIN organizations o ON o.id = i.organization_id AND o.status = 'active'
    WHERE i.sent_at IS NULL AND i.attempts < 5 AND i.expires_at > now()
      AND ((e.state IN ('SENT','DELIVERED') AND i.delivery_kind='invitation')
        OR (e.state='COMPLETED' AND i.delivery_kind='completed'))
      AND (i.last_attempt_at IS NULL OR i.last_attempt_at < now() - interval '2 minutes')
    ORDER BY i.last_attempt_at NULLS FIRST, i.id LIMIT 25
  $$;

REVOKE ALL ON FUNCTION app.signature_invite_by_hash(text), app.pending_signature_invites() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.signature_invite_by_hash(text), app.pending_signature_invites() TO ragsis_app;

CREATE FUNCTION app.signature_document_status(p_docs uuid[]) RETURNS TABLE (id uuid, current_version_id uuid, classification text, status text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT d.id, d.current_version_id, d.classification, d.status FROM documents d
    WHERE d.organization_id = app.org_id() AND d.id = ANY(p_docs)
  $$;
REVOKE ALL ON FUNCTION app.signature_document_status(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.signature_document_status(uuid[]) TO ragsis_app;

CREATE FUNCTION app.native_signature_proof(p_envelope uuid)
  RETURNS TABLE (signed_sha256 text, certificate_sha256 text, key_id text, completed_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT e.evidence->>'signed_sha256', e.evidence->>'certificate_sha256', e.evidence->>'key_id', e.completed_at
    FROM signature_envelopes e WHERE e.id=p_envelope AND e.provider='native' AND e.state='COMPLETED'
  $$;
REVOKE ALL ON FUNCTION app.native_signature_proof(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.native_signature_proof(uuid) TO ragsis_app;

CREATE OR REPLACE FUNCTION app.pending_workflow_runs() RETURNS TABLE (organization_id uuid, run_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT r.organization_id, r.id FROM workflow_runs r
    WHERE r.state IN ('QUEUED','RUNNING') OR (r.state='WAITING_EXTERNAL' AND EXISTS (
      SELECT 1 FROM run_steps s JOIN signature_envelopes e ON e.run_id=r.id AND e.id::text=s.output->>'envelope_id'
      WHERE s.run_id=r.id AND s.node_type='WAIT_EVENT' AND s.state='WAITING' AND e.state IN ('COMPLETED','DECLINED','VOIDED')
    ))
    ORDER BY r.created_at LIMIT 500
  $$;
