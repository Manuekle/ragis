-- RAG-05: GraphRAG (entidades y relaciones) dentro de Postgres, bajo las mismas RLS/ACL que los chunks.
--
-- Modelo de ACL del grafo (ADR-019):
--   * Ningún dato del grafo existe sin procedencia. `entities` y `relations` guardan solo su clave
--     (nombre normalizado, o par de extremos), que es función determinista de cualquiera de sus menciones.
--   * Nombre visible, tipo, descripción, keywords y peso viven en `entity_sources` / `relation_sources`, una fila
--     por chunk fuente, con el document_id del chunk para aplicar la ACL del documento.
--   * Una entidad/relación es visible solo si el usuario puede ver al menos un chunk fuente (ACL del documento).
--   * Las descripciones/resúmenes se construyen en consulta SOLO con fuentes visibles para ese usuario: no hay
--     resúmenes globales ni comunidades precomputadas que mezclen documentos con ACL distinta.
--   * Borrar un chunk borra su procedencia (ON DELETE CASCADE); las claves huérfanas quedan invisibles y el worker
--     las recolecta.

-- ---------------------------------------------------------------------------
-- Habilitación: default por plan + override por organización (ADR-005: no por defecto en team).
-- ---------------------------------------------------------------------------
ALTER TABLE plans ADD COLUMN graph_enabled boolean NOT NULL DEFAULT false;
UPDATE plans SET graph_enabled = true WHERE id IN ('business', 'private');

ALTER TABLE organizations ADD COLUMN graph_mode text NOT NULL DEFAULT 'inherit'
  CHECK (graph_mode IN ('inherit', 'on', 'off'));

-- ---------------------------------------------------------------------------
-- Grafo
-- ---------------------------------------------------------------------------
CREATE TABLE entities (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  normalized_name text NOT NULL CHECK (length(normalized_name) BETWEEN 1 AND 200),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, workspace_id, normalized_name)
);

CREATE TABLE entity_sources (
  entity_id       uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  chunk_id        uuid NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  document_id     uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),   -- mención tal como aparece en el chunk
  type            text NOT NULL DEFAULT 'otro' CHECK (type ~ '^[a-z_]{1,40}$'),
  description     text NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  tsv             tsvector GENERATED ALWAYS AS (
                    setweight(to_tsvector('spanish', name), 'A') ||
                    setweight(to_tsvector('spanish', description), 'B') ||
                    to_tsvector('simple', name)
                  ) STORED,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_id, chunk_id)
);
CREATE INDEX entity_sources_chunk_idx ON entity_sources (chunk_id);
CREATE INDEX entity_sources_doc_idx ON entity_sources (document_id);
CREATE INDEX entity_sources_tsv_idx ON entity_sources USING gin (tsv);

CREATE TABLE relations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  src_entity_id   uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  dst_entity_id   uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (src_entity_id <> dst_entity_id),
  UNIQUE (organization_id, workspace_id, src_entity_id, dst_entity_id)
);
CREATE INDEX relations_src_idx ON relations (src_entity_id);
CREATE INDEX relations_dst_idx ON relations (dst_entity_id);

CREATE TABLE relation_sources (
  relation_id     uuid NOT NULL REFERENCES relations(id) ON DELETE CASCADE,
  chunk_id        uuid NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  document_id     uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  keywords        text NOT NULL DEFAULT '' CHECK (length(keywords) <= 300),
  description     text NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  weight          real NOT NULL DEFAULT 1 CHECK (weight > 0 AND weight <= 10),
  tsv             tsvector GENERATED ALWAYS AS (
                    setweight(to_tsvector('spanish', keywords), 'A') ||
                    setweight(to_tsvector('spanish', description), 'B')
                  ) STORED,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (relation_id, chunk_id)
);
CREATE INDEX relation_sources_chunk_idx ON relation_sources (chunk_id);
CREATE INDEX relation_sources_doc_idx ON relation_sources (document_id);
CREATE INDEX relation_sources_tsv_idx ON relation_sources USING gin (tsv);

-- ---------------------------------------------------------------------------
-- RLS forzada
-- ---------------------------------------------------------------------------
ALTER TABLE entities         ENABLE ROW LEVEL SECURITY;  ALTER TABLE entities         FORCE ROW LEVEL SECURITY;
ALTER TABLE entity_sources   ENABLE ROW LEVEL SECURITY;  ALTER TABLE entity_sources   FORCE ROW LEVEL SECURITY;
ALTER TABLE relations        ENABLE ROW LEVEL SECURITY;  ALTER TABLE relations        FORCE ROW LEVEL SECURITY;
ALTER TABLE relation_sources ENABLE ROW LEVEL SECURITY;  ALTER TABLE relation_sources FORCE ROW LEVEL SECURITY;

-- Procedencia: misma regla que chunks (tenant + ACL efectiva del documento del chunk fuente).
CREATE POLICY ent_src_app_select ON entity_sources FOR SELECT TO ragsis_app USING (
  organization_id = app.org_id()
  AND EXISTS (SELECT 1 FROM document_acl a
               WHERE a.document_id = entity_sources.document_id AND a.principal = ANY (app.principals()))
);
CREATE POLICY rel_src_app_select ON relation_sources FOR SELECT TO ragsis_app USING (
  organization_id = app.org_id()
  AND EXISTS (SELECT 1 FROM document_acl a
               WHERE a.document_id = relation_sources.document_id AND a.principal = ANY (app.principals()))
);

-- Claves: visibles solo si existe al menos una fuente visible. El EXISTS evalúa la ACL de forma explícita
-- (no depende de que la RLS de *_sources se aplique dentro de la subconsulta).
CREATE POLICY ent_app_select ON entities FOR SELECT TO ragsis_app USING (
  organization_id = app.org_id()
  AND EXISTS (SELECT 1 FROM entity_sources s
                JOIN document_acl a ON a.document_id = s.document_id
               WHERE s.entity_id = entities.id AND a.principal = ANY (app.principals()))
);
CREATE POLICY rel_app_select ON relations FOR SELECT TO ragsis_app USING (
  organization_id = app.org_id()
  AND EXISTS (SELECT 1 FROM relation_sources s
                JOIN document_acl a ON a.document_id = s.document_id
               WHERE s.relation_id = relations.id AND a.principal = ANY (app.principals()))
);

-- Worker: visibilidad por tenant (sin ACL de usuario), igual que chunks.
CREATE POLICY ent_worker ON entities FOR ALL TO ragsis_worker
  USING (organization_id = app.org_id()) WITH CHECK (organization_id = app.org_id());
CREATE POLICY ent_src_worker ON entity_sources FOR ALL TO ragsis_worker
  USING (organization_id = app.org_id()) WITH CHECK (organization_id = app.org_id());
CREATE POLICY rel_worker ON relations FOR ALL TO ragsis_worker
  USING (organization_id = app.org_id()) WITH CHECK (organization_id = app.org_id());
CREATE POLICY rel_src_worker ON relation_sources FOR ALL TO ragsis_worker
  USING (organization_id = app.org_id()) WITH CHECK (organization_id = app.org_id());

-- Defensa en profundidad: la procedencia debe pertenecer al mismo tenant/documento que su chunk, y la clave
-- al mismo tenant/workspace (un worker con un bug no puede atar un chunk de un documento a otro).
CREATE OR REPLACE FUNCTION app.graph_source_check() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  c record;
  k record;
BEGIN
  SELECT organization_id, workspace_id, document_id INTO c FROM chunks WHERE id = NEW.chunk_id;
  IF NOT FOUND OR c.organization_id <> NEW.organization_id OR c.document_id <> NEW.document_id THEN
    RAISE EXCEPTION 'graph source does not match its chunk' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_TABLE_NAME = 'entity_sources' THEN
    SELECT organization_id, workspace_id INTO k FROM entities WHERE id = NEW.entity_id;
  ELSE
    SELECT organization_id, workspace_id INTO k FROM relations WHERE id = NEW.relation_id;
  END IF;
  IF NOT FOUND OR k.organization_id <> c.organization_id OR k.workspace_id <> c.workspace_id THEN
    RAISE EXCEPTION 'graph key outside the chunk workspace' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER entity_sources_check BEFORE INSERT OR UPDATE ON entity_sources
  FOR EACH ROW EXECUTE FUNCTION app.graph_source_check();
CREATE TRIGGER relation_sources_check BEFORE INSERT OR UPDATE ON relation_sources
  FOR EACH ROW EXECUTE FUNCTION app.graph_source_check();

-- ---------------------------------------------------------------------------
-- Privilegios
-- ---------------------------------------------------------------------------
GRANT SELECT ON entities, entity_sources, relations, relation_sources TO ragsis_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON entities, entity_sources, relations, relation_sources TO ragsis_worker;
