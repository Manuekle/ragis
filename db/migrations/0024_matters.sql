-- ADR-037: expedientes (matters). Una firma trabaja por cliente y caso, no por espacio.
--
-- Un expediente es un registro de la organización: lo ve todo miembro (como la lista de clientes con la que una firma
-- revisa conflictos de interés). Vincular un documento NO toca document_acl: quien no podía leer el documento sigue
-- sin poder leerlo, y los conteos y listados de documentos se calculan bajo la RLS de `documents`.
--
-- Cada documento está en un expediente o en ninguno (`documents.matter_id`). Borrar un expediente nunca borra
-- documentos: quedan sin expediente. Las carpetas existentes no se convierten aquí; se convierten cuando alguien lo pide
-- desde la biblioteca (POST …/matters/from-folder).

CREATE TABLE matters (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title           text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 160),
  client_name     text NOT NULL CHECK (length(btrim(client_name)) BETWEEN 1 AND 160),
  counterparty    text CHECK (counterparty IS NULL OR length(counterparty) <= 160),
  -- Número de radicado (en Colombia, 23 dígitos en la Rama Judicial; en la Corte Constitucional, p. ej. «D-16.857»).
  case_number     text CHECK (case_number IS NULL OR length(case_number) BETWEEN 1 AND 60),
  -- Despacho o juzgado.
  court           text CHECK (court IS NULL OR length(court) <= 160),
  -- Etapa procesal: texto libre (la interfaz sugiere las habituales).
  stage           text CHECK (stage IS NULL OR length(stage) <= 80),
  owner_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'on_hold', 'closed', 'archived')),
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX matters_org_idx ON matters (organization_id, status, lower(client_name));
-- Un radicado identifica un proceso: dos expedientes con el mismo radicado en la firma son casi siempre un duplicado.
CREATE UNIQUE INDEX matters_case_number_idx ON matters (organization_id, lower(btrim(case_number)))
  WHERE case_number IS NOT NULL;

ALTER TABLE documents ADD COLUMN matter_id uuid REFERENCES matters(id) ON DELETE SET NULL;
CREATE INDEX documents_matter_idx ON documents (matter_id) WHERE matter_id IS NOT NULL;

-- Dónde buscó cada pregunta (space | matter | folder | documents | all), para el registro y el historial.
ALTER TABLE query_runs ADD COLUMN scope jsonb;

CREATE OR REPLACE FUNCTION app.matter_normalize() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW.title := btrim(NEW.title);
  NEW.client_name := btrim(NEW.client_name);
  NEW.counterparty := NULLIF(btrim(NEW.counterparty), '');
  NEW.case_number := NULLIF(btrim(NEW.case_number), '');
  NEW.court := NULLIF(btrim(NEW.court), '');
  NEW.stage := NULLIF(btrim(NEW.stage), '');
  IF TG_OP = 'UPDATE' THEN
    IF NEW.organization_id <> OLD.organization_id THEN
      RAISE EXCEPTION 'an expediente cannot change organization' USING ERRCODE = 'check_violation';
    END IF;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER matters_normalize BEFORE INSERT OR UPDATE ON matters
  FOR EACH ROW EXECUTE FUNCTION app.matter_normalize();

CREATE OR REPLACE FUNCTION app.document_matter_check() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  m_org uuid;
BEGIN
  IF NEW.matter_id IS NOT NULL THEN
    SELECT organization_id INTO m_org FROM matters WHERE id = NEW.matter_id;
    IF NOT FOUND OR m_org <> NEW.organization_id THEN
      RAISE EXCEPTION 'expediente is in another organization' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER documents_matter_check BEFORE INSERT OR UPDATE OF matter_id ON documents
  FOR EACH ROW EXECUTE FUNCTION app.document_matter_check();

ALTER TABLE matters ENABLE ROW LEVEL SECURITY;  ALTER TABLE matters FORCE ROW LEVEL SECURITY;

-- Los datos del expediente son de la organización; los permisos de escritura (rol, autor) los aplica la API.
CREATE POLICY matters_tenant ON matters FOR ALL TO ragsis_app
  USING (organization_id = app.org_id()) WITH CHECK (organization_id = app.org_id());
CREATE POLICY matters_worker ON matters FOR SELECT TO ragsis_worker USING (organization_id = app.org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON matters TO ragsis_app;
GRANT SELECT ON matters TO ragsis_worker;
