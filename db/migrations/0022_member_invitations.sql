-- Member invitations by email: an admin adds someone who has never signed in, and the membership appears the
-- first time that person signs in with the invited address.
--
-- Before this, "Add member" only worked for people who had already signed in once, so a partner could not bring an
-- associate into the firm. The invitation never grants anything by itself: the membership is created only when an
-- identity with that email (verified by the identity provider) signs in, with the role the admin chose. Invitations
-- expire after 14 days, can be revoked, and accepting one is recorded in the organization's audit log.

CREATE TABLE member_invitations (
  id               uuid PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email            text NOT NULL CHECK (email = lower(email) AND position('@' IN email) > 1),
  role             text NOT NULL CHECK (role IN ('admin', 'member', 'viewer')),
  invited_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL DEFAULT now() + interval '14 days',
  accepted_at      timestamptz,
  accepted_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  revoked_at       timestamptz,
  CHECK (accepted_at IS NULL OR revoked_at IS NULL)
);
-- One open invitation per address and organization (inviting again updates it).
CREATE UNIQUE INDEX member_invitations_open_idx ON member_invitations (organization_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
-- Looked up on every sign-in by address.
CREATE INDEX member_invitations_email_idx ON member_invitations (email) WHERE accepted_at IS NULL AND revoked_at IS NULL;

ALTER TABLE member_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY member_invitations_tenant ON member_invitations FOR ALL TO ragsis_app
  USING (organization_id = app.org_id()) WITH CHECK (organization_id = app.org_id());
GRANT SELECT, INSERT, UPDATE ON member_invitations TO ragsis_app;

-- Turns the open invitations for a signed-in user's address into memberships. Runs with no tenant context (at
-- sign-in, before the organization is resolved), so it is SECURITY DEFINER and only ever acts on the caller's own
-- address. The API calls it only when the identity provider verified the email. An existing membership is never
-- changed (a suspended person stays suspended; a role is not lowered or raised by an old invitation).
CREATE OR REPLACE FUNCTION app.accept_member_invitations(p_user uuid)
  RETURNS TABLE (org_id uuid, member_role text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  addr text;
  inv record;
  added boolean;
BEGIN
  SELECT u.email INTO addr FROM users u WHERE u.id = p_user;
  IF addr IS NULL THEN
    RETURN;
  END IF;
  FOR inv IN
    SELECT i.id, i.organization_id, i.role FROM member_invitations i
     WHERE i.email = addr AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
     FOR UPDATE SKIP LOCKED
  LOOP
    INSERT INTO memberships (organization_id, user_id, role) VALUES (inv.organization_id, p_user, inv.role)
      ON CONFLICT (organization_id, user_id) DO NOTHING;
    added := FOUND;
    UPDATE member_invitations SET accepted_at = now(), accepted_user_id = p_user WHERE id = inv.id;
    INSERT INTO audit_events (organization_id, actor_id, action, resource, decision, metadata)
    VALUES (inv.organization_id, p_user, 'member.invitation_accepted', 'user:' || p_user::text, 'allow',
            jsonb_build_object('invitation_id', inv.id, 'role', inv.role, 'membership_created', added));
    org_id := inv.organization_id;
    member_role := inv.role;
    RETURN NEXT;
  END LOOP;
END $$;

REVOKE EXECUTE ON FUNCTION app.accept_member_invitations(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.accept_member_invitations(uuid) TO ragsis_app;
