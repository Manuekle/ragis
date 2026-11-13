-- ADR-035: company teams and requests between teams.
--
-- A team (Legal, Treasury, HR…) is a department of the company. Each team owns exactly one workspace, so its
-- documents, Ask answers and agents stay inside the team through the ACL that already exists (principal
-- `workspace:<id>`): nothing new is needed for "Legal does not see Treasury's files".
-- Team membership IS the workspace membership (one source of truth, nothing to keep in sync). A member can be a team
-- lead: leads triage the requests that arrive at their team.
--
-- Requests cross the team boundary on purpose: someone in Legal asks Treasury for something. A request is visible
-- only to the people involved: the requester, the assignee and the members of the sending and receiving teams.
-- Org admins do NOT see other teams' requests (same rule as documents and conversations); they manage teams, not
-- their work.

CREATE TABLE teams (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id    uuid NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
  name            text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  description     text NOT NULL DEFAULT '' CHECK (length(description) <= 280),
  color           text NOT NULL DEFAULT 'blue'
                  CHECK (color IN ('blue', 'green', 'amber', 'red', 'violet', 'teal', 'pink', 'slate')),
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  archived_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX teams_name_idx ON teams (organization_id, lower(btrim(name)));

-- Team leads live on the workspace membership: removing someone from the team removes the lead flag with it.
ALTER TABLE workspace_members ADD COLUMN team_lead boolean NOT NULL DEFAULT false;

-- Human-friendly request numbers per organization (#1, #2…). A counter row instead of max(number)+1 because RLS
-- hides most requests from any single user, so max() would hand out duplicates.
CREATE TABLE team_request_counters (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  last_number     integer NOT NULL DEFAULT 0
);

CREATE TABLE team_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  number          integer NOT NULL,
  -- NULL when the requester belongs to no team (e.g. the owner asking a department directly).
  from_team_id    uuid REFERENCES teams(id) ON DELETE SET NULL,
  to_team_id      uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  requested_by    uuid NOT NULL REFERENCES users(id),
  assignee_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  title           text NOT NULL CHECK (length(btrim(title)) BETWEEN 3 AND 160),
  body            text NOT NULL DEFAULT '' CHECK (length(body) <= 8000),
  priority        text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  -- open = new, not started · in_progress · waiting = waiting on the requester · done / declined / cancelled = closed
  status          text NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'in_progress', 'waiting', 'done', 'declined', 'cancelled')),
  due_on          date,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz,
  UNIQUE (organization_id, number),
  CHECK ((status IN ('done', 'declined', 'cancelled')) = (closed_at IS NOT NULL))
);
CREATE INDEX team_requests_to_idx ON team_requests (organization_id, to_team_id, status);
CREATE INDEX team_requests_from_idx ON team_requests (organization_id, from_team_id);
CREATE INDEX team_requests_requester_idx ON team_requests (organization_id, requested_by);
CREATE INDEX team_requests_assignee_idx ON team_requests (organization_id, assignee_id) WHERE assignee_id IS NOT NULL;

-- Timeline of a request: creation, comments, status changes, assignment. Append-only.
CREATE TABLE team_request_events (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id      uuid NOT NULL REFERENCES team_requests(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  kind            text NOT NULL CHECK (kind IN ('created', 'comment', 'status', 'assigned', 'priority', 'due')),
  body            text NOT NULL DEFAULT '' CHECK (length(body) <= 4000),
  data            jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX team_request_events_req_idx ON team_request_events (request_id, id);

-- ---------------------------------------------------------------------------
-- Integrity: teams, requests and people belong to the same organization.
-- SECURITY INVOKER: it runs under the caller's RLS, so it can only "see" its own tenant anyway.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.team_check() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
BEGIN
  NEW.name := btrim(NEW.name);
  IF NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = NEW.workspace_id AND w.organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'team/workspace tenant mismatch' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.workspace_id <> OLD.workspace_id OR NEW.organization_id <> OLD.organization_id) THEN
    RAISE EXCEPTION 'a team cannot change workspace' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER teams_check BEFORE INSERT OR UPDATE ON teams FOR EACH ROW EXECUTE FUNCTION app.team_check();

CREATE OR REPLACE FUNCTION app.team_request_check() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.organization_id <> OLD.organization_id OR NEW.number <> OLD.number
      OR NEW.requested_by <> OLD.requested_by OR NEW.to_team_id <> OLD.to_team_id
      OR NEW.from_team_id IS DISTINCT FROM OLD.from_team_id) THEN
    RAISE EXCEPTION 'who asked whom cannot change' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM teams t WHERE t.id = NEW.to_team_id AND t.organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'request/team tenant mismatch' USING ERRCODE = '23514';
  END IF;
  IF NEW.from_team_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM teams t WHERE t.id = NEW.from_team_id AND t.organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'request/team tenant mismatch' USING ERRCODE = '23514';
  END IF;
  -- The assignee must be in the receiving team (checked on change only: someone who later leaves the team keeps
  -- the history; the API unassigns their open requests when they are removed).
  IF NEW.assignee_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.assignee_id IS DISTINCT FROM OLD.assignee_id)
     AND NOT EXISTS (SELECT 1 FROM teams t JOIN workspace_members wm ON wm.workspace_id = t.workspace_id
                      WHERE t.id = NEW.to_team_id AND wm.user_id = NEW.assignee_id) THEN
    RAISE EXCEPTION 'assignee is not in the receiving team' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER team_requests_check BEFORE INSERT OR UPDATE ON team_requests FOR EACH ROW EXECUTE FUNCTION app.team_request_check();

-- Is the current user a member of this team? (SECURITY INVOKER: reads teams/workspace_members under the caller's RLS)
CREATE OR REPLACE FUNCTION app.in_team(p_team uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
    SELECT p_team IS NOT NULL AND EXISTS (
      SELECT 1 FROM teams t JOIN workspace_members wm ON wm.workspace_id = t.workspace_id
       WHERE t.id = p_team AND wm.user_id = app.user_id()
    )
  $$;

-- When someone leaves a team, their open requests in that team go back to the team's queue. SECURITY DEFINER because
-- the admin removing them may not belong to the team (and so cannot see its requests). It only touches the active
-- tenant, records who released them, and returns how many requests were released (no content).
CREATE OR REPLACE FUNCTION app.release_team_assignments(p_team uuid, p_user uuid) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  n integer;
BEGIN
  WITH released AS (
    UPDATE team_requests SET assignee_id = NULL
     WHERE organization_id = app.org_id() AND to_team_id = p_team AND assignee_id = p_user AND closed_at IS NULL
    RETURNING id, organization_id
  ), ev AS (
    INSERT INTO team_request_events (request_id, organization_id, actor_id, kind, data)
    SELECT id, organization_id, app.user_id(), 'assigned', jsonb_build_object('from', p_user, 'to', NULL, 'reason', 'left_team')
      FROM released
    RETURNING 1
  )
  SELECT count(*) INTO n FROM ev;
  RETURN n;
END $$;
REVOKE EXECUTE ON FUNCTION app.release_team_assignments(uuid, uuid) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
ALTER TABLE teams                 ENABLE ROW LEVEL SECURITY; ALTER TABLE teams                 FORCE ROW LEVEL SECURITY;
ALTER TABLE team_request_counters ENABLE ROW LEVEL SECURITY; ALTER TABLE team_request_counters FORCE ROW LEVEL SECURITY;
ALTER TABLE team_requests         ENABLE ROW LEVEL SECURITY; ALTER TABLE team_requests         FORCE ROW LEVEL SECURITY;
ALTER TABLE team_request_events   ENABLE ROW LEVEL SECURITY; ALTER TABLE team_request_events   FORCE ROW LEVEL SECURITY;

-- The team directory (names, who is in which team) is visible to the whole organization: people need it to know
-- whom to ask. What a team works on (documents, requests) is not.
CREATE POLICY teams_tenant ON teams FOR ALL TO ragsis_app
  USING (organization_id = app.org_id()) WITH CHECK (organization_id = app.org_id());
CREATE POLICY teams_worker ON teams FOR SELECT TO ragsis_worker USING (organization_id = app.org_id());
CREATE POLICY team_counters_tenant ON team_request_counters FOR ALL TO ragsis_app
  USING (organization_id = app.org_id()) WITH CHECK (organization_id = app.org_id());

CREATE POLICY team_requests_select ON team_requests FOR SELECT TO ragsis_app USING (
  organization_id = app.org_id()
  AND (requested_by = app.user_id() OR assignee_id = app.user_id() OR app.in_team(to_team_id) OR app.in_team(from_team_id))
);
-- Anyone files a request in their own name.
CREATE POLICY team_requests_insert ON team_requests FOR INSERT TO ragsis_app
  WITH CHECK (organization_id = app.org_id() AND requested_by = app.user_id());
-- Only people involved can change it; the API decides which change each of them may make.
CREATE POLICY team_requests_update ON team_requests FOR UPDATE TO ragsis_app USING (
  organization_id = app.org_id()
  AND (requested_by = app.user_id() OR assignee_id = app.user_id() OR app.in_team(to_team_id) OR app.in_team(from_team_id))
) WITH CHECK (organization_id = app.org_id());

-- Events follow their request: if you can see the request you can see its timeline.
CREATE POLICY team_request_events_select ON team_request_events FOR SELECT TO ragsis_app USING (
  organization_id = app.org_id() AND EXISTS (SELECT 1 FROM team_requests r WHERE r.id = team_request_events.request_id)
);
CREATE POLICY team_request_events_insert ON team_request_events FOR INSERT TO ragsis_app WITH CHECK (
  organization_id = app.org_id() AND actor_id = app.user_id()
  AND EXISTS (SELECT 1 FROM team_requests r WHERE r.id = team_request_events.request_id)
);

GRANT SELECT, INSERT, UPDATE ON teams, team_requests TO ragsis_app;
GRANT SELECT, INSERT, UPDATE ON team_request_counters TO ragsis_app;
GRANT SELECT, INSERT ON team_request_events TO ragsis_app;
GRANT SELECT ON teams TO ragsis_worker;
GRANT EXECUTE ON FUNCTION app.team_check(), app.team_request_check(), app.in_team(uuid),
  app.release_team_assignments(uuid, uuid) TO ragsis_app;
