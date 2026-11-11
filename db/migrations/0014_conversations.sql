-- Historial de conversaciones de Ask (ADR-028).
--
-- Hasta ahora query_runs guardaba solo el hash de la pregunta; la respuesta se perdía al recargar la página.
-- Una conversación es PRIVADA de su autor (ni los admins la ven) y cada turno guarda una instantánea de la respuesta
-- tal como se vio (texto + citas). Al leerla, la API vuelve a comprobar que los documentos citados siguen siendo
-- visibles para el usuario; si no, el turno se devuelve ocultado (ver routes/conversations.ts).
--
-- El id lo genera el cliente (uuid v4): la conversación se crea al guardar el primer turno, así que no existen
-- conversaciones vacías ni una llamada extra antes de preguntar.

CREATE TABLE conversations (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title           text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_user_idx ON conversations (organization_id, user_id, updated_at DESC);

CREATE TABLE conversation_turns (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  question        text NOT NULL,
  as_of           date,
  -- Para el feedback (+1/-1) de la consulta original; si la traza se purga, el turno sigue legible.
  query_run_id    text REFERENCES query_runs(id) ON DELETE SET NULL,
  result          jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversation_turns_conv_idx ON conversation_turns (conversation_id, id);

ALTER TABLE conversations      ENABLE ROW LEVEL SECURITY; ALTER TABLE conversations      FORCE ROW LEVEL SECURITY;
ALTER TABLE conversation_turns ENABLE ROW LEVEL SECURITY; ALTER TABLE conversation_turns FORCE ROW LEVEL SECURITY;

CREATE POLICY conversations_owner ON conversations FOR ALL TO ragsis_app
  USING (organization_id = app.org_id() AND user_id = app.user_id())
  WITH CHECK (organization_id = app.org_id() AND user_id = app.user_id());
-- Los turnos no se editan: se insertan y se leen. Se borran al borrar la conversación (cascada).
CREATE POLICY conversation_turns_select ON conversation_turns FOR SELECT TO ragsis_app
  USING (organization_id = app.org_id() AND user_id = app.user_id());
CREATE POLICY conversation_turns_insert ON conversation_turns FOR INSERT TO ragsis_app
  WITH CHECK (
    organization_id = app.org_id() AND user_id = app.user_id()
    AND EXISTS (SELECT 1 FROM conversations c WHERE c.id = conversation_turns.conversation_id)
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON conversations TO ragsis_app;
GRANT SELECT, INSERT ON conversation_turns TO ragsis_app;
