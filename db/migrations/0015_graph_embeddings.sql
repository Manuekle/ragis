-- ADR-029: representación densa de entidades y relaciones del grafo (tabla de embeddings T del índice I = (G, T)).
--
-- Un vector por fila de procedencia y modelo: se embebe la mención tal como aparece en SU chunk fuente, nunca un
-- resumen que mezcle documentos. La visibilidad es la de la procedencia (ADR-019): tenant + ACL del documento del
-- chunk. Borrar el chunk borra la procedencia y, en cascada, su vector.
-- model_version separa espacios vectoriales incompatibles, igual que chunk_embeddings.

CREATE TABLE entity_source_embeddings (
  entity_id       uuid NOT NULL,
  chunk_id        uuid NOT NULL,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  document_id     uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  model_version   text NOT NULL,
  embedding       vector(1024) NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_id, chunk_id, model_version),
  FOREIGN KEY (entity_id, chunk_id) REFERENCES entity_sources (entity_id, chunk_id) ON DELETE CASCADE
);
CREATE INDEX entity_source_embeddings_hnsw_idx ON entity_source_embeddings USING hnsw (embedding vector_cosine_ops);
CREATE INDEX entity_source_embeddings_scope_idx ON entity_source_embeddings (organization_id, model_version);
CREATE INDEX entity_source_embeddings_chunk_idx ON entity_source_embeddings (chunk_id);

CREATE TABLE relation_source_embeddings (
  relation_id     uuid NOT NULL,
  chunk_id        uuid NOT NULL,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  document_id     uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  model_version   text NOT NULL,
  embedding       vector(1024) NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (relation_id, chunk_id, model_version),
  FOREIGN KEY (relation_id, chunk_id) REFERENCES relation_sources (relation_id, chunk_id) ON DELETE CASCADE
);
CREATE INDEX relation_source_embeddings_hnsw_idx ON relation_source_embeddings USING hnsw (embedding vector_cosine_ops);
CREATE INDEX relation_source_embeddings_scope_idx ON relation_source_embeddings (organization_id, model_version);
CREATE INDEX relation_source_embeddings_chunk_idx ON relation_source_embeddings (chunk_id);

ALTER TABLE entity_source_embeddings   ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_source_embeddings   FORCE ROW LEVEL SECURITY;
ALTER TABLE relation_source_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE relation_source_embeddings FORCE ROW LEVEL SECURITY;

-- Misma regla que entity_sources / relation_sources: tenant + ACL efectiva del documento del chunk fuente.
CREATE POLICY ent_emb_app_select ON entity_source_embeddings FOR SELECT TO ragsis_app USING (
  organization_id = app.org_id()
  AND EXISTS (SELECT 1 FROM document_acl a
               WHERE a.document_id = entity_source_embeddings.document_id AND a.principal = ANY (app.principals()))
);
CREATE POLICY rel_emb_app_select ON relation_source_embeddings FOR SELECT TO ragsis_app USING (
  organization_id = app.org_id()
  AND EXISTS (SELECT 1 FROM document_acl a
               WHERE a.document_id = relation_source_embeddings.document_id AND a.principal = ANY (app.principals()))
);
CREATE POLICY ent_emb_worker ON entity_source_embeddings FOR ALL TO ragsis_worker
  USING (organization_id = app.org_id()) WITH CHECK (organization_id = app.org_id());
CREATE POLICY rel_emb_worker ON relation_source_embeddings FOR ALL TO ragsis_worker
  USING (organization_id = app.org_id()) WITH CHECK (organization_id = app.org_id());

-- Defensa en profundidad: el vector debe pertenecer al mismo tenant/documento que su fila de procedencia.
CREATE OR REPLACE FUNCTION app.graph_embedding_check() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  s record;
BEGIN
  IF TG_TABLE_NAME = 'entity_source_embeddings' THEN
    SELECT organization_id, document_id INTO s FROM entity_sources
     WHERE entity_id = NEW.entity_id AND chunk_id = NEW.chunk_id;
  ELSE
    SELECT organization_id, document_id INTO s FROM relation_sources
     WHERE relation_id = NEW.relation_id AND chunk_id = NEW.chunk_id;
  END IF;
  IF NOT FOUND OR s.organization_id <> NEW.organization_id OR s.document_id <> NEW.document_id THEN
    RAISE EXCEPTION 'graph embedding does not match its source' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER entity_source_embeddings_check BEFORE INSERT OR UPDATE ON entity_source_embeddings
  FOR EACH ROW EXECUTE FUNCTION app.graph_embedding_check();
CREATE TRIGGER relation_source_embeddings_check BEFORE INSERT OR UPDATE ON relation_source_embeddings
  FOR EACH ROW EXECUTE FUNCTION app.graph_embedding_check();

GRANT SELECT ON entity_source_embeddings, relation_source_embeddings TO ragsis_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON entity_source_embeddings, relation_source_embeddings TO ragsis_worker;
