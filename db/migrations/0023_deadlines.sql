-- ADR-038: procedural deadlines ("términos") for law firms.
--
-- A deadline is a term a court or a law gives the firm to act (answer a claim, appeal, file evidence). It has the date
-- of the event it runs from (notification, ejecutoria, filing), how it is counted (business days, calendar days,
-- months, years, or a fixed date), how long it is, the rule that sets it, who is responsible and its state. The due
-- date is computed by the API from the country's public holidays and the firm's court-vacancy periods, and stored with
-- the breakdown of the computation so a lawyer can check every skipped day.
--
-- Nothing becomes a deadline on its own: the ingest worker proposes candidates (literal sentence + page of the source
-- document) and a person confirms each one. Every deadline records who confirmed it (confirmed_by = the caller).
--
-- Visibility follows documents and teams: a deadline belongs to a workspace and is visible to the members of that
-- workspace and to the person responsible for it. Org admins do not see other workspaces' deadlines.

-- ---------------------------------------------------------------------------
-- Public holidays: global reference data (no customer data, like plans). One row per holiday; two holidays may share a
-- day (2025-06-30). Adding a country is adding rows (scripts/holidays/).
-- ---------------------------------------------------------------------------
CREATE TABLE public_holidays (
  country text NOT NULL CHECK (country ~ '^[a-z]{2}$'),
  day     date NOT NULL,
  name    text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  basis   text NOT NULL DEFAULT '' CHECK (length(basis) <= 200),
  PRIMARY KEY (country, day, name)
);

-- Colombia 2024-2032 (python3 scripts/holidays/co.py 2024 2032).
INSERT INTO public_holidays (country, day, name, basis) VALUES
  ('co', '2024-01-01', 'Año Nuevo', 'Ley 51 de 1983'),
  ('co', '2024-01-08', 'Reyes Magos', 'Ley 51 de 1983'),
  ('co', '2024-03-25', 'San José', 'Ley 51 de 1983'),
  ('co', '2024-03-28', 'Jueves Santo', 'Ley 51 de 1983'),
  ('co', '2024-03-29', 'Viernes Santo', 'Ley 51 de 1983'),
  ('co', '2024-05-01', 'Día del Trabajo', 'Ley 51 de 1983'),
  ('co', '2024-05-13', 'Ascensión del Señor', 'Ley 51 de 1983'),
  ('co', '2024-06-03', 'Corpus Christi', 'Ley 51 de 1983'),
  ('co', '2024-06-10', 'Sagrado Corazón de Jesús', 'Ley 51 de 1983'),
  ('co', '2024-07-01', 'San Pedro y San Pablo', 'Ley 51 de 1983'),
  ('co', '2024-07-20', 'Día de la Independencia', 'Ley 51 de 1983'),
  ('co', '2024-08-07', 'Batalla de Boyacá', 'Ley 51 de 1983'),
  ('co', '2024-08-19', 'Asunción de la Virgen', 'Ley 51 de 1983'),
  ('co', '2024-10-14', 'Día de la Diversidad Étnica y Cultural', 'Ley 51 de 1983'),
  ('co', '2024-11-04', 'Todos los Santos', 'Ley 51 de 1983'),
  ('co', '2024-11-11', 'Independencia de Cartagena', 'Ley 51 de 1983'),
  ('co', '2024-12-08', 'Inmaculada Concepción', 'Ley 51 de 1983'),
  ('co', '2024-12-25', 'Navidad', 'Ley 51 de 1983'),
  ('co', '2025-01-01', 'Año Nuevo', 'Ley 51 de 1983'),
  ('co', '2025-01-06', 'Reyes Magos', 'Ley 51 de 1983'),
  ('co', '2025-03-24', 'San José', 'Ley 51 de 1983'),
  ('co', '2025-04-17', 'Jueves Santo', 'Ley 51 de 1983'),
  ('co', '2025-04-18', 'Viernes Santo', 'Ley 51 de 1983'),
  ('co', '2025-05-01', 'Día del Trabajo', 'Ley 51 de 1983'),
  ('co', '2025-06-02', 'Ascensión del Señor', 'Ley 51 de 1983'),
  ('co', '2025-06-23', 'Corpus Christi', 'Ley 51 de 1983'),
  ('co', '2025-06-30', 'Sagrado Corazón de Jesús', 'Ley 51 de 1983'),
  ('co', '2025-06-30', 'San Pedro y San Pablo', 'Ley 51 de 1983'),
  ('co', '2025-07-20', 'Día de la Independencia', 'Ley 51 de 1983'),
  ('co', '2025-08-07', 'Batalla de Boyacá', 'Ley 51 de 1983'),
  ('co', '2025-08-18', 'Asunción de la Virgen', 'Ley 51 de 1983'),
  ('co', '2025-10-13', 'Día de la Diversidad Étnica y Cultural', 'Ley 51 de 1983'),
  ('co', '2025-11-03', 'Todos los Santos', 'Ley 51 de 1983'),
  ('co', '2025-11-17', 'Independencia de Cartagena', 'Ley 51 de 1983'),
  ('co', '2025-12-08', 'Inmaculada Concepción', 'Ley 51 de 1983'),
  ('co', '2025-12-25', 'Navidad', 'Ley 51 de 1983'),
  ('co', '2026-01-01', 'Año Nuevo', 'Ley 51 de 1983'),
  ('co', '2026-01-12', 'Reyes Magos', 'Ley 51 de 1983'),
  ('co', '2026-03-23', 'San José', 'Ley 51 de 1983'),
  ('co', '2026-04-02', 'Jueves Santo', 'Ley 51 de 1983'),
  ('co', '2026-04-03', 'Viernes Santo', 'Ley 51 de 1983'),
  ('co', '2026-05-01', 'Día del Trabajo', 'Ley 51 de 1983'),
  ('co', '2026-05-18', 'Ascensión del Señor', 'Ley 51 de 1983'),
  ('co', '2026-06-08', 'Corpus Christi', 'Ley 51 de 1983'),
  ('co', '2026-06-15', 'Sagrado Corazón de Jesús', 'Ley 51 de 1983'),
  ('co', '2026-06-29', 'San Pedro y San Pablo', 'Ley 51 de 1983'),
  ('co', '2026-07-20', 'Día de la Independencia', 'Ley 51 de 1983'),
  ('co', '2026-08-07', 'Batalla de Boyacá', 'Ley 51 de 1983'),
  ('co', '2026-08-17', 'Asunción de la Virgen', 'Ley 51 de 1983'),
  ('co', '2026-10-12', 'Día de la Diversidad Étnica y Cultural', 'Ley 51 de 1983'),
  ('co', '2026-11-02', 'Todos los Santos', 'Ley 51 de 1983'),
  ('co', '2026-11-16', 'Independencia de Cartagena', 'Ley 51 de 1983'),
  ('co', '2026-12-08', 'Inmaculada Concepción', 'Ley 51 de 1983'),
  ('co', '2026-12-25', 'Navidad', 'Ley 51 de 1983'),
  ('co', '2027-01-01', 'Año Nuevo', 'Ley 51 de 1983'),
  ('co', '2027-01-11', 'Reyes Magos', 'Ley 51 de 1983'),
  ('co', '2027-03-22', 'San José', 'Ley 51 de 1983'),
  ('co', '2027-03-25', 'Jueves Santo', 'Ley 51 de 1983'),
  ('co', '2027-03-26', 'Viernes Santo', 'Ley 51 de 1983'),
  ('co', '2027-05-01', 'Día del Trabajo', 'Ley 51 de 1983'),
  ('co', '2027-05-10', 'Ascensión del Señor', 'Ley 51 de 1983'),
  ('co', '2027-05-31', 'Corpus Christi', 'Ley 51 de 1983'),
  ('co', '2027-06-07', 'Sagrado Corazón de Jesús', 'Ley 51 de 1983'),
  ('co', '2027-07-05', 'San Pedro y San Pablo', 'Ley 51 de 1983'),
  ('co', '2027-07-20', 'Día de la Independencia', 'Ley 51 de 1983'),
  ('co', '2027-08-07', 'Batalla de Boyacá', 'Ley 51 de 1983'),
  ('co', '2027-08-16', 'Asunción de la Virgen', 'Ley 51 de 1983'),
  ('co', '2027-10-18', 'Día de la Diversidad Étnica y Cultural', 'Ley 51 de 1983'),
  ('co', '2027-11-01', 'Todos los Santos', 'Ley 51 de 1983'),
  ('co', '2027-11-15', 'Independencia de Cartagena', 'Ley 51 de 1983'),
  ('co', '2027-12-08', 'Inmaculada Concepción', 'Ley 51 de 1983'),
  ('co', '2027-12-25', 'Navidad', 'Ley 51 de 1983'),
  ('co', '2028-01-01', 'Año Nuevo', 'Ley 51 de 1983'),
  ('co', '2028-01-10', 'Reyes Magos', 'Ley 51 de 1983'),
  ('co', '2028-03-20', 'San José', 'Ley 51 de 1983'),
  ('co', '2028-04-13', 'Jueves Santo', 'Ley 51 de 1983'),
  ('co', '2028-04-14', 'Viernes Santo', 'Ley 51 de 1983'),
  ('co', '2028-05-01', 'Día del Trabajo', 'Ley 51 de 1983'),
  ('co', '2028-05-29', 'Ascensión del Señor', 'Ley 51 de 1983'),
  ('co', '2028-06-19', 'Corpus Christi', 'Ley 51 de 1983'),
  ('co', '2028-06-26', 'Sagrado Corazón de Jesús', 'Ley 51 de 1983'),
  ('co', '2028-07-03', 'San Pedro y San Pablo', 'Ley 51 de 1983'),
  ('co', '2028-07-20', 'Día de la Independencia', 'Ley 51 de 1983'),
  ('co', '2028-08-07', 'Batalla de Boyacá', 'Ley 51 de 1983'),
  ('co', '2028-08-21', 'Asunción de la Virgen', 'Ley 51 de 1983'),
  ('co', '2028-10-16', 'Día de la Diversidad Étnica y Cultural', 'Ley 51 de 1983'),
  ('co', '2028-11-06', 'Todos los Santos', 'Ley 51 de 1983'),
  ('co', '2028-11-13', 'Independencia de Cartagena', 'Ley 51 de 1983'),
  ('co', '2028-12-08', 'Inmaculada Concepción', 'Ley 51 de 1983'),
  ('co', '2028-12-25', 'Navidad', 'Ley 51 de 1983'),
  ('co', '2029-01-01', 'Año Nuevo', 'Ley 51 de 1983'),
  ('co', '2029-01-08', 'Reyes Magos', 'Ley 51 de 1983'),
  ('co', '2029-03-19', 'San José', 'Ley 51 de 1983'),
  ('co', '2029-03-29', 'Jueves Santo', 'Ley 51 de 1983'),
  ('co', '2029-03-30', 'Viernes Santo', 'Ley 51 de 1983'),
  ('co', '2029-05-01', 'Día del Trabajo', 'Ley 51 de 1983'),
  ('co', '2029-05-14', 'Ascensión del Señor', 'Ley 51 de 1983'),
  ('co', '2029-06-04', 'Corpus Christi', 'Ley 51 de 1983'),
  ('co', '2029-06-11', 'Sagrado Corazón de Jesús', 'Ley 51 de 1983'),
  ('co', '2029-07-02', 'San Pedro y San Pablo', 'Ley 51 de 1983'),
  ('co', '2029-07-20', 'Día de la Independencia', 'Ley 51 de 1983'),
  ('co', '2029-08-07', 'Batalla de Boyacá', 'Ley 51 de 1983'),
  ('co', '2029-08-20', 'Asunción de la Virgen', 'Ley 51 de 1983'),
  ('co', '2029-10-15', 'Día de la Diversidad Étnica y Cultural', 'Ley 51 de 1983'),
  ('co', '2029-11-05', 'Todos los Santos', 'Ley 51 de 1983'),
  ('co', '2029-11-12', 'Independencia de Cartagena', 'Ley 51 de 1983'),
  ('co', '2029-12-08', 'Inmaculada Concepción', 'Ley 51 de 1983'),
  ('co', '2029-12-25', 'Navidad', 'Ley 51 de 1983'),
  ('co', '2030-01-01', 'Año Nuevo', 'Ley 51 de 1983'),
  ('co', '2030-01-07', 'Reyes Magos', 'Ley 51 de 1983'),
  ('co', '2030-03-25', 'San José', 'Ley 51 de 1983'),
  ('co', '2030-04-18', 'Jueves Santo', 'Ley 51 de 1983'),
  ('co', '2030-04-19', 'Viernes Santo', 'Ley 51 de 1983'),
  ('co', '2030-05-01', 'Día del Trabajo', 'Ley 51 de 1983'),
  ('co', '2030-06-03', 'Ascensión del Señor', 'Ley 51 de 1983'),
  ('co', '2030-06-24', 'Corpus Christi', 'Ley 51 de 1983'),
  ('co', '2030-07-01', 'Sagrado Corazón de Jesús', 'Ley 51 de 1983'),
  ('co', '2030-07-01', 'San Pedro y San Pablo', 'Ley 51 de 1983'),
  ('co', '2030-07-20', 'Día de la Independencia', 'Ley 51 de 1983'),
  ('co', '2030-08-07', 'Batalla de Boyacá', 'Ley 51 de 1983'),
  ('co', '2030-08-19', 'Asunción de la Virgen', 'Ley 51 de 1983'),
  ('co', '2030-10-14', 'Día de la Diversidad Étnica y Cultural', 'Ley 51 de 1983'),
  ('co', '2030-11-04', 'Todos los Santos', 'Ley 51 de 1983'),
  ('co', '2030-11-11', 'Independencia de Cartagena', 'Ley 51 de 1983'),
  ('co', '2030-12-08', 'Inmaculada Concepción', 'Ley 51 de 1983'),
  ('co', '2030-12-25', 'Navidad', 'Ley 51 de 1983'),
  ('co', '2031-01-01', 'Año Nuevo', 'Ley 51 de 1983'),
  ('co', '2031-01-06', 'Reyes Magos', 'Ley 51 de 1983'),
  ('co', '2031-03-24', 'San José', 'Ley 51 de 1983'),
  ('co', '2031-04-10', 'Jueves Santo', 'Ley 51 de 1983'),
  ('co', '2031-04-11', 'Viernes Santo', 'Ley 51 de 1983'),
  ('co', '2031-05-01', 'Día del Trabajo', 'Ley 51 de 1983'),
  ('co', '2031-05-26', 'Ascensión del Señor', 'Ley 51 de 1983'),
  ('co', '2031-06-16', 'Corpus Christi', 'Ley 51 de 1983'),
  ('co', '2031-06-23', 'Sagrado Corazón de Jesús', 'Ley 51 de 1983'),
  ('co', '2031-06-30', 'San Pedro y San Pablo', 'Ley 51 de 1983'),
  ('co', '2031-07-20', 'Día de la Independencia', 'Ley 51 de 1983'),
  ('co', '2031-08-07', 'Batalla de Boyacá', 'Ley 51 de 1983'),
  ('co', '2031-08-18', 'Asunción de la Virgen', 'Ley 51 de 1983'),
  ('co', '2031-10-13', 'Día de la Diversidad Étnica y Cultural', 'Ley 51 de 1983'),
  ('co', '2031-11-03', 'Todos los Santos', 'Ley 51 de 1983'),
  ('co', '2031-11-17', 'Independencia de Cartagena', 'Ley 51 de 1983'),
  ('co', '2031-12-08', 'Inmaculada Concepción', 'Ley 51 de 1983'),
  ('co', '2031-12-25', 'Navidad', 'Ley 51 de 1983'),
  ('co', '2032-01-01', 'Año Nuevo', 'Ley 51 de 1983'),
  ('co', '2032-01-12', 'Reyes Magos', 'Ley 51 de 1983'),
  ('co', '2032-03-22', 'San José', 'Ley 51 de 1983'),
  ('co', '2032-03-25', 'Jueves Santo', 'Ley 51 de 1983'),
  ('co', '2032-03-26', 'Viernes Santo', 'Ley 51 de 1983'),
  ('co', '2032-05-01', 'Día del Trabajo', 'Ley 51 de 1983'),
  ('co', '2032-05-10', 'Ascensión del Señor', 'Ley 51 de 1983'),
  ('co', '2032-05-31', 'Corpus Christi', 'Ley 51 de 1983'),
  ('co', '2032-06-07', 'Sagrado Corazón de Jesús', 'Ley 51 de 1983'),
  ('co', '2032-07-05', 'San Pedro y San Pablo', 'Ley 51 de 1983'),
  ('co', '2032-07-20', 'Día de la Independencia', 'Ley 51 de 1983'),
  ('co', '2032-08-07', 'Batalla de Boyacá', 'Ley 51 de 1983'),
  ('co', '2032-08-16', 'Asunción de la Virgen', 'Ley 51 de 1983'),
  ('co', '2032-10-18', 'Día de la Diversidad Étnica y Cultural', 'Ley 51 de 1983'),
  ('co', '2032-11-01', 'Todos los Santos', 'Ley 51 de 1983'),
  ('co', '2032-11-15', 'Independencia de Cartagena', 'Ley 51 de 1983'),
  ('co', '2032-12-08', 'Inmaculada Concepción', 'Ley 51 de 1983'),
  ('co', '2032-12-25', 'Navidad', 'Ley 51 de 1983');

-- Which country's holidays a firm counts with.
ALTER TABLE organizations
  ADD COLUMN holiday_country text NOT NULL DEFAULT 'co' CHECK (holiday_country ~ '^[a-z]{2}$');

-- ---------------------------------------------------------------------------
-- Court closures (vacancia judicial, cierres extraordinarios) configured per firm. Days inside a closure do not count
-- in terms of days, and a term that ends inside one moves to the next working day (art. 118 CGP).
-- ---------------------------------------------------------------------------
CREATE TABLE court_closures (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  starts_on       date NOT NULL,
  ends_on         date NOT NULL,
  label           text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 120),
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on >= starts_on AND ends_on - starts_on <= 366)
);
CREATE INDEX court_closures_org_idx ON court_closures (organization_id, starts_on);

-- ---------------------------------------------------------------------------
-- Deadlines
-- ---------------------------------------------------------------------------
CREATE TABLE deadlines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title           text NOT NULL CHECK (length(btrim(title)) BETWEEN 3 AND 200),
  -- The event the term runs from. Counting starts the next day (art. 118 CGP).
  trigger_kind    text NOT NULL DEFAULT 'notification'
                  CHECK (trigger_kind IN ('notification', 'ejecutoria', 'filing', 'hearing', 'other')),
  trigger_date    date NOT NULL,
  -- Personal notification by email (art. 8 Ley 2213 de 2022): it is deemed made two business days after sending.
  notice_by_email boolean NOT NULL DEFAULT false,
  unit            text NOT NULL CHECK (unit IN ('business_days', 'calendar_days', 'months', 'years', 'fixed')),
  amount          integer CHECK (amount BETWEEN 1 AND 3650),
  due_on          date NOT NULL,
  -- How due_on was computed: start of counting, skipped holidays and closures, moved-to-next-working-day.
  computation     jsonb NOT NULL DEFAULT '{}',
  legal_basis     text NOT NULL DEFAULT '' CHECK (length(legal_basis) <= 300),
  responsible_id  uuid NOT NULL REFERENCES users(id),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'cancelled')),
  notes           text NOT NULL DEFAULT '' CHECK (length(notes) <= 4000),
  -- Citation: the document, version, page and literal sentence the deadline comes from (NULL for one entered by hand).
  document_id     uuid REFERENCES documents(id) ON DELETE SET NULL,
  version_id      uuid REFERENCES document_versions(id) ON DELETE SET NULL,
  page            integer CHECK (page > 0),
  quote           text CHECK (length(quote) <= 1000),
  confirmed_by    uuid NOT NULL REFERENCES users(id),
  confirmed_at    timestamptz NOT NULL DEFAULT now(),
  closed_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  closed_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((unit = 'fixed') = (amount IS NULL)),
  CHECK ((status IN ('done', 'cancelled')) = (closed_at IS NOT NULL))
);
CREATE INDEX deadlines_due_idx ON deadlines (organization_id, status, due_on);
CREATE INDEX deadlines_ws_idx ON deadlines (organization_id, workspace_id, status);
CREATE INDEX deadlines_responsible_idx ON deadlines (organization_id, responsible_id, status);
CREATE INDEX deadlines_document_idx ON deadlines (document_id) WHERE document_id IS NOT NULL;

-- History of a deadline: confirmation, edits, completion, recomputation after a closure changed (reminders sent are
-- in deadline_reminders).
CREATE TABLE deadline_events (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  deadline_id     uuid NOT NULL REFERENCES deadlines(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  kind            text NOT NULL CHECK (kind IN ('confirmed', 'updated', 'done', 'reopened', 'cancelled', 'recomputed')),
  data            jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX deadline_events_idx ON deadline_events (deadline_id, id);

-- ---------------------------------------------------------------------------
-- Candidates proposed by the ingest worker. The quote is a literal sentence of the document version; page is the page
-- of the block that holds it (NULL for formats without pages, e.g. DOCX).
-- ---------------------------------------------------------------------------
CREATE TABLE deadline_candidates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_id     uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_id      uuid NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  chunk_id        uuid REFERENCES chunks(id) ON DELETE SET NULL,
  page            integer CHECK (page > 0),
  quote           text NOT NULL CHECK (length(quote) BETWEEN 1 AND 1000),
  amount          integer CHECK (amount BETWEEN 1 AND 3650),
  unit            text NOT NULL CHECK (unit IN ('business_days', 'calendar_days', 'months', 'years', 'fixed')),
  -- "días" with no qualifier: business days by default (art. 62 Ley 4 de 1913); the web says so.
  unit_assumed    boolean NOT NULL DEFAULT false,
  trigger_hint    text NOT NULL DEFAULT 'other'
                  CHECK (trigger_hint IN ('notification', 'ejecutoria', 'filing', 'hearing', 'other')),
  trigger_date    date,
  legal_basis     text NOT NULL DEFAULT '' CHECK (length(legal_basis) <= 300),
  title           text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  fingerprint     text NOT NULL,
  status          text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'confirmed', 'dismissed', 'superseded')),
  deadline_id     uuid REFERENCES deadlines(id) ON DELETE SET NULL,
  decided_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (version_id, fingerprint),
  CHECK ((unit = 'fixed') = (amount IS NULL)),
  CHECK ((status IN ('confirmed', 'dismissed')) = (decided_at IS NOT NULL))
);
CREATE INDEX deadline_candidates_open_idx ON deadline_candidates (organization_id, status, created_at DESC);
CREATE INDEX deadline_candidates_doc_idx ON deadline_candidates (document_id, status);

-- Reminder emails, one row per (deadline, kind, due date): a due date that moves gets its reminders again. Claimed
-- before sending (attempts, last_attempt_at) so two API replicas never send the same reminder twice.
CREATE TABLE deadline_reminders (
  deadline_id     uuid NOT NULL REFERENCES deadlines(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('week', 'two_days', 'due', 'overdue')),
  due_on          date NOT NULL,
  recipient       text NOT NULL CHECK (length(recipient) <= 320),
  attempts        integer NOT NULL DEFAULT 1,
  last_attempt_at timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  PRIMARY KEY (deadline_id, kind, due_on)
);

-- ---------------------------------------------------------------------------
-- Integrity (SECURITY INVOKER: runs under the caller's RLS, so it only sees its own tenant)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.deadline_check() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
BEGIN
  NEW.title := btrim(NEW.title);
  IF TG_OP = 'UPDATE' AND (NEW.organization_id <> OLD.organization_id OR NEW.workspace_id <> OLD.workspace_id
      OR NEW.confirmed_by <> OLD.confirmed_by OR NEW.confirmed_at <> OLD.confirmed_at
      OR NEW.document_id IS DISTINCT FROM OLD.document_id AND OLD.document_id IS NOT NULL AND NEW.document_id IS NOT NULL
      OR NEW.quote IS DISTINCT FROM OLD.quote OR NEW.page IS DISTINCT FROM OLD.page) THEN
    RAISE EXCEPTION 'who confirmed a deadline and what it cites cannot change' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = NEW.workspace_id AND w.organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'deadline/workspace tenant mismatch' USING ERRCODE = '23514';
  END IF;
  IF (TG_OP = 'INSERT' OR NEW.responsible_id <> OLD.responsible_id) AND NOT EXISTS (
      SELECT 1 FROM memberships m WHERE m.organization_id = NEW.organization_id AND m.user_id = NEW.responsible_id
         AND m.status = 'active') THEN
    RAISE EXCEPTION 'the responsible person is not an active member' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.document_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM documents d WHERE d.id = NEW.document_id AND d.organization_id = NEW.organization_id
         AND d.workspace_id = NEW.workspace_id) THEN
    RAISE EXCEPTION 'deadline/document mismatch' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER deadlines_check BEFORE INSERT OR UPDATE ON deadlines FOR EACH ROW EXECUTE FUNCTION app.deadline_check();

-- Can the current user see this deadline? Member of its workspace, or responsible for it.
CREATE OR REPLACE FUNCTION app.sees_deadline(p_workspace uuid, p_responsible uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
    SELECT ('workspace:' || p_workspace::text) = ANY (app.principals()) OR p_responsible = app.user_id()
  $$;

-- ---------------------------------------------------------------------------
-- Tenant-wide jobs (SECURITY DEFINER, narrow): recomputing pending due dates when a closure changes, and the reminder
-- sweep. Neither returns anything a caller could not act on.
-- ---------------------------------------------------------------------------

-- Pending deadlines of the active tenant with what is needed to recompute them (no titles, no people).
CREATE OR REPLACE FUNCTION app.pending_deadline_terms() RETURNS TABLE (
  id uuid, trigger_date date, notice_by_email boolean, unit text, amount integer, due_on date)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT d.id, d.trigger_date, d.notice_by_email, d.unit, d.amount, d.due_on FROM deadlines d
     WHERE d.organization_id = app.org_id() AND d.status = 'pending' AND d.unit <> 'fixed'
  $$;

-- Moves a pending deadline of the active tenant to a recomputed due date and records why. The caller passes the new
-- date and breakdown computed from the same holidays and closures every caller uses.
CREATE OR REPLACE FUNCTION app.recompute_deadline(p_id uuid, p_due date, p_computation jsonb, p_reason text)
  RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  old_due date;
BEGIN
  SELECT due_on INTO old_due FROM deadlines
   WHERE id = p_id AND organization_id = app.org_id() AND status = 'pending' AND unit <> 'fixed' FOR UPDATE;
  IF old_due IS NULL OR old_due = p_due THEN
    RETURN false;
  END IF;
  UPDATE deadlines SET due_on = p_due, computation = p_computation, updated_at = now() WHERE id = p_id;
  INSERT INTO deadline_events (deadline_id, organization_id, actor_id, kind, data)
  VALUES (p_id, app.org_id(), app.user_id(), 'recomputed',
          jsonb_build_object('from', old_due, 'to', p_due, 'reason', left(p_reason, 200)));
  RETURN true;
END $$;

-- Reminder sweep: pending deadlines of active organizations due between p_from and p_to, with the responsible
-- person's address. Read by the API's reminder loop, which then claims each reminder inside the tenant.
CREATE OR REPLACE FUNCTION app.deadline_reminder_window(p_from date, p_to date) RETURNS TABLE (
  organization_id uuid, organization_name text, holiday_country text, deadline_id uuid, title text, due_on date,
  legal_basis text, document_title text, page integer, responsible_email text, responsible_name text, sent text[])
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT d.organization_id, o.name, o.holiday_country, d.id, d.title, d.due_on, d.legal_basis, doc.title, d.page,
           u.email, u.display_name,
           COALESCE((SELECT array_agg(r.kind) FROM deadline_reminders r
                      WHERE r.deadline_id = d.id AND r.due_on = d.due_on AND r.sent_at IS NOT NULL), '{}')
      FROM deadlines d
      JOIN organizations o ON o.id = d.organization_id AND o.status = 'active'
      JOIN users u ON u.id = d.responsible_id
      JOIN memberships m ON m.organization_id = d.organization_id AND m.user_id = d.responsible_id AND m.status = 'active'
      LEFT JOIN documents doc ON doc.id = d.document_id
     WHERE d.status = 'pending' AND d.due_on BETWEEN p_from AND p_to
     ORDER BY d.due_on, d.id LIMIT 500
  $$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
ALTER TABLE court_closures      ENABLE ROW LEVEL SECURITY; ALTER TABLE court_closures      FORCE ROW LEVEL SECURITY;
ALTER TABLE deadlines           ENABLE ROW LEVEL SECURITY; ALTER TABLE deadlines           FORCE ROW LEVEL SECURITY;
ALTER TABLE deadline_events     ENABLE ROW LEVEL SECURITY; ALTER TABLE deadline_events     FORCE ROW LEVEL SECURITY;
ALTER TABLE deadline_candidates ENABLE ROW LEVEL SECURITY; ALTER TABLE deadline_candidates FORCE ROW LEVEL SECURITY;
ALTER TABLE deadline_reminders  ENABLE ROW LEVEL SECURITY; ALTER TABLE deadline_reminders  FORCE ROW LEVEL SECURITY;

-- The firm's calendar is visible to every member (everyone counts with it); the API lets only admins change it.
CREATE POLICY court_closures_tenant ON court_closures FOR ALL TO ragsis_app
  USING (organization_id = app.org_id()) WITH CHECK (organization_id = app.org_id());

CREATE POLICY deadlines_select ON deadlines FOR SELECT TO ragsis_app
  USING (organization_id = app.org_id() AND app.sees_deadline(workspace_id, responsible_id));
-- A person confirms a deadline in their own name, in a workspace they belong to.
CREATE POLICY deadlines_insert ON deadlines FOR INSERT TO ragsis_app WITH CHECK (
  organization_id = app.org_id() AND confirmed_by = app.user_id()
  AND ('workspace:' || workspace_id::text) = ANY (app.principals())
);
CREATE POLICY deadlines_update ON deadlines FOR UPDATE TO ragsis_app
  USING (organization_id = app.org_id() AND app.sees_deadline(workspace_id, responsible_id))
  WITH CHECK (organization_id = app.org_id());

CREATE POLICY deadline_events_select ON deadline_events FOR SELECT TO ragsis_app USING (
  organization_id = app.org_id() AND EXISTS (SELECT 1 FROM deadlines d WHERE d.id = deadline_events.deadline_id)
);
CREATE POLICY deadline_events_insert ON deadline_events FOR INSERT TO ragsis_app WITH CHECK (
  organization_id = app.org_id() AND actor_id = app.user_id()
  AND EXISTS (SELECT 1 FROM deadlines d WHERE d.id = deadline_events.deadline_id)
);

-- Candidates follow their document: whoever can read the document can review what it proposes.
CREATE POLICY deadline_candidates_select ON deadline_candidates FOR SELECT TO ragsis_app USING (
  organization_id = app.org_id() AND EXISTS (SELECT 1 FROM documents d WHERE d.id = deadline_candidates.document_id)
);
CREATE POLICY deadline_candidates_update ON deadline_candidates FOR UPDATE TO ragsis_app USING (
  organization_id = app.org_id() AND EXISTS (SELECT 1 FROM documents d WHERE d.id = deadline_candidates.document_id)
) WITH CHECK (organization_id = app.org_id());
CREATE POLICY deadline_candidates_worker ON deadline_candidates FOR ALL TO ragsis_worker
  USING (organization_id = app.org_id()) WITH CHECK (organization_id = app.org_id());

-- Reminder bookkeeping: claimed by the API's sweep inside the tenant (no user), read next to a visible deadline.
CREATE POLICY deadline_reminders_tenant ON deadline_reminders FOR ALL TO ragsis_app
  USING (organization_id = app.org_id()) WITH CHECK (organization_id = app.org_id());

GRANT SELECT ON public_holidays TO ragsis_app, ragsis_worker;
GRANT SELECT, INSERT, DELETE ON court_closures TO ragsis_app;
GRANT SELECT, INSERT, UPDATE ON deadlines, deadline_reminders TO ragsis_app;
GRANT SELECT, INSERT ON deadline_events TO ragsis_app;
GRANT SELECT, UPDATE ON deadline_candidates TO ragsis_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON deadline_candidates TO ragsis_worker;
GRANT SELECT ON deadlines TO ragsis_worker;
GRANT EXECUTE ON FUNCTION app.deadline_check(), app.sees_deadline(uuid, uuid) TO ragsis_app;
REVOKE ALL ON FUNCTION app.pending_deadline_terms(), app.recompute_deadline(uuid, date, jsonb, text),
  app.deadline_reminder_window(date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.pending_deadline_terms(), app.recompute_deadline(uuid, date, jsonb, text),
  app.deadline_reminder_window(date, date) TO ragsis_app;
