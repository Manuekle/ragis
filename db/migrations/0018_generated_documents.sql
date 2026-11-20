-- Documentos generados desde el chat (ADR-034).
--
-- El chat puede devolver un archivo (informe PDF, documento Word, presentación PowerPoint, tabla CSV) en lugar de una
-- respuesta. Por debajo siempre es Markdown verificado (cada afirmación con su cita [n]); los formatos se generan al
-- descargar, así que aquí solo se guarda el Markdown y las citas.
--
-- Privado de su autor, como el historial (ADR-028): ni los admins lo ven. Al descargar, la API vuelve a comprobar que
-- los documentos citados siguen siendo visibles para el usuario; si alguno dejó de serlo, no se entrega el archivo.
-- Lo inserta el rag-engine en la misma transacción que la traza de la consulta (query_runs).

CREATE TABLE generated_documents (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  query_run_id    text REFERENCES query_runs(id) ON DELETE SET NULL,
  title           text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  format          text NOT NULL CHECK (format IN ('pdf', 'docx', 'pptx', 'csv', 'md')),
  kind            text NOT NULL CHECK (kind IN ('report', 'presentation', 'table')),
  markdown        text NOT NULL CHECK (char_length(markdown) BETWEEN 1 AND 200000),
  citations       jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX generated_documents_user_idx ON generated_documents (organization_id, user_id, created_at DESC);

ALTER TABLE generated_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE generated_documents FORCE ROW LEVEL SECURITY;

CREATE POLICY generated_documents_owner ON generated_documents FOR ALL TO ragsis_app
  USING (organization_id = app.org_id() AND user_id = app.user_id())
  WITH CHECK (organization_id = app.org_id() AND user_id = app.user_id());

-- Sin UPDATE: el contenido verificado no se edita después de generarlo.
GRANT SELECT, INSERT, DELETE ON generated_documents TO ragsis_app;
