-- «Solo IA privada» también en Preguntar y en la ingesta.
--
-- El onboarding promete «Tus documentos nunca se envían a un servicio de IA externo» (llm_policy = 'local_only') y
-- «En tus servidores: nada sale de ahí» (deployment_preference = 'on_prem'). Hasta ahora solo los agentes lo
-- respetaban; Preguntar y la ingesta usaban el modelo configurado aunque estuviera en la nube.
--
-- La regla vive aquí para que la API (que la firma en el token interno del rag-engine) y el ingest-worker lean lo
-- mismo. Es SECURITY DEFINER porque ragsis_worker no tiene acceso a organization_profiles, y está acotada a la
-- organización del contexto (app.org_id()): no recibe parámetros, así que nadie puede preguntar por otra.

CREATE OR REPLACE FUNCTION app.ai_local_only() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(
    (SELECT p.llm_policy = 'local_only' OR p.deployment_preference = 'on_prem'
       FROM organization_profiles p
      WHERE p.organization_id = app.org_id()),
    false)
$$;

REVOKE EXECUTE ON FUNCTION app.ai_local_only() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ai_local_only() TO ragsis_app, ragsis_worker;
