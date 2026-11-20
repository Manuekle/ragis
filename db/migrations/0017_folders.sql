-- ADR-031: carpetas de la biblioteca con sugerencia por contenido.
--
-- Las carpetas SOLO organizan: el acceso a un documento sigue siendo su ACL (document_acl). Mover un documento no
-- cambia quién lo ve; por eso el nombre de una carpeta es visible para todo el workspace y su contenido no.
--
-- Sugerencia: cada documento indexado tiene un vector resumen (promedio de los vectores de sus chunks) con la MISMA
-- regla de acceso que sus chunks. La carpeta sugerida se calcula en consulta comparando ese vector con el promedio
-- de los documentos que la persona puede ver en cada carpeta: lo que alguien no puede leer no influye en lo que se
-- le sugiere.

CREATE TABLE folders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_id       uuid REFERENCES folders(id) ON DELETE CASCADE,
  name            text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120 AND name !~ '[/\\]'),
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
-- Sin dos hermanas con el mismo nombre (sin distinguir mayúsculas), también en la raíz.
CREATE UNIQUE INDEX folders_sibling_name_idx ON folders
  (workspace_id, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(btrim(name)));
CREATE INDEX folders_parent_idx ON folders (parent_id);

-- Borrar una carpeta nunca borra documentos: quedan sin carpeta.
ALTER TABLE documents
  ADD COLUMN folder_id uuid REFERENCES folders(id) ON DELETE SET NULL,
  ADD COLUMN folder_suggestion_dismissed_at timestamptz;
CREATE INDEX documents_folder_idx ON documents (folder_id) WHERE folder_id IS NOT NULL;

CREATE TABLE document_centroids (
  document_id     uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  model_version   text NOT NULL,
  embedding       vector(1024) NOT NULL,
  chunk_count     integer NOT NULL CHECK (chunk_count > 0),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, model_version)
);
CREATE INDEX document_centroids_scope_idx ON document_centroids (organization_id, model_version);

-- Documentos ya indexados.
INSERT INTO document_centroids (document_id, organization_id, model_version, embedding, chunk_count)
SELECT c.document_id, c.organization_id, e.model_version, avg(e.embedding), count(*)
  FROM chunks c JOIN chunk_embeddings e ON e.chunk_id = c.id
 WHERE c.index_state = 'active'
 GROUP BY c.document_id, c.organization_id, e.model_version;

-- Estructura: misma organización y workspace que la carpeta madre, sin ciclos, profundidad máxima 6.
CREATE OR REPLACE FUNCTION app.folder_check() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  p record;
  cur uuid := NEW.parent_id;
  depth integer := 1;
BEGIN
  NEW.name := btrim(NEW.name);
  IF TG_OP = 'UPDATE' AND (NEW.workspace_id <> OLD.workspace_id OR NEW.organization_id <> OLD.organization_id) THEN
    RAISE EXCEPTION 'a folder cannot change workspace' USING ERRCODE = 'check_violation';
  END IF;
  WHILE cur IS NOT NULL LOOP
    IF cur = NEW.id THEN
      RAISE EXCEPTION 'a folder cannot be inside itself' USING ERRCODE = 'check_violation';
    END IF;
    SELECT organization_id, workspace_id, parent_id INTO p FROM folders WHERE id = cur;
    IF NOT FOUND OR p.organization_id <> NEW.organization_id OR p.workspace_id <> NEW.workspace_id THEN
      RAISE EXCEPTION 'parent folder is in another workspace' USING ERRCODE = 'check_violation';
    END IF;
    depth := depth + 1;
    IF depth > 6 THEN
      RAISE EXCEPTION 'folders can be nested up to 6 levels' USING ERRCODE = 'check_violation';
    END IF;
    cur := p.parent_id;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER folders_check BEFORE INSERT OR UPDATE ON folders
  FOR EACH ROW EXECUTE FUNCTION app.folder_check();

CREATE OR REPLACE FUNCTION app.document_folder_check() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  f record;
BEGIN
  IF NEW.folder_id IS NOT NULL THEN
    SELECT organization_id, workspace_id INTO f FROM folders WHERE id = NEW.folder_id;
    IF NOT FOUND OR f.organization_id <> NEW.organization_id OR f.workspace_id <> NEW.workspace_id THEN
      RAISE EXCEPTION 'folder is in another workspace' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER documents_folder_check BEFORE INSERT OR UPDATE OF folder_id, workspace_id ON documents
  FOR EACH ROW EXECUTE FUNCTION app.document_folder_check();

ALTER TABLE folders            ENABLE ROW LEVEL SECURITY;  ALTER TABLE folders            FORCE ROW LEVEL SECURITY;
ALTER TABLE document_centroids ENABLE ROW LEVEL SECURITY;  ALTER TABLE document_centroids FORCE ROW LEVEL SECURITY;

CREATE POLICY folders_tenant ON folders FOR ALL TO ragsis_app
  USING (organization_id = app.org_id()) WITH CHECK (organization_id = app.org_id());
CREATE POLICY folders_worker ON folders FOR SELECT TO ragsis_worker USING (organization_id = app.org_id());

-- Vector resumen: misma regla que chunks/chunk_embeddings (tenant + ACL del documento).
CREATE POLICY centroids_app_select ON document_centroids FOR SELECT TO ragsis_app USING (
  organization_id = app.org_id()
  AND EXISTS (SELECT 1 FROM document_acl a
               WHERE a.document_id = document_centroids.document_id AND a.principal = ANY (app.principals()))
);
CREATE POLICY centroids_worker ON document_centroids FOR ALL TO ragsis_worker
  USING (organization_id = app.org_id()) WITH CHECK (organization_id = app.org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON folders TO ragsis_app;
GRANT SELECT ON folders TO ragsis_worker;
GRANT SELECT ON document_centroids TO ragsis_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON document_centroids TO ragsis_worker;
