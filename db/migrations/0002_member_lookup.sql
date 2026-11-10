-- Búsqueda de usuario por email para que un admin agregue miembros a SU tenant.
-- Solo devuelve el id (sin otros datos) y exige que quien llama sea owner/admin del tenant activo.
CREATE OR REPLACE FUNCTION app.user_id_for_invite(p_email text) RETURNS uuid
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  uid uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM memberships m
     WHERE m.organization_id = app.org_id() AND m.user_id = app.user_id()
       AND m.role IN ('owner', 'admin') AND m.status = 'active'
  ) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  SELECT id INTO uid FROM users WHERE email = lower(p_email) ORDER BY created_at LIMIT 1;
  RETURN uid;
END $$;

REVOKE EXECUTE ON FUNCTION app.user_id_for_invite(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.user_id_for_invite(text) TO ragsis_app;

-- Agregados de cuota a nivel tenant (independientes de la ACL del usuario que consulta).
-- Solo devuelven números del tenant activo; nunca filas.
CREATE OR REPLACE FUNCTION app.tenant_corpus_stats(OUT documents integer, OUT storage_bytes bigint)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT
    (SELECT count(*)::int FROM documents d WHERE d.organization_id = app.org_id() AND d.status <> 'deleted'),
    (SELECT coalesce(sum(coalesce(v.size_bytes, v.declared_size)), 0)::bigint
       FROM document_versions v JOIN documents d ON d.id = v.document_id
      WHERE v.organization_id = app.org_id() AND d.status <> 'deleted' AND v.status NOT IN ('rejected', 'failed'))
$$;

REVOKE EXECUTE ON FUNCTION app.tenant_corpus_stats() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.tenant_corpus_stats() TO ragsis_app;
