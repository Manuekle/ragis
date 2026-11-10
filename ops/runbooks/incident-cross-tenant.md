# Incidente: sospecha de acceso entre tenants

Severidad crítica. Objetivo de leakage: 0.

1. Contener: si hay evidencia activa, poner la API en mantenimiento (desired count 0 del servicio `api`) o bloquear el tenant (`organizations.status='suspended'`).
2. Preservar evidencia: exportar `audit_events` (cadena de hash: verificar `prev_hash` → `hash`) y logs de API/rag-engine por `trace_id`.
3. Determinar alcance: `query_runs` + `citations` del periodo; comprobar que cada `citations.document_id` pertenezca al `organization_id` del run:
   ```sql
   SELECT c.query_run_id FROM citations c JOIN documents d ON d.id = c.document_id
    WHERE d.organization_id <> c.organization_id;
   ```
4. Reproducir con `tests/python/test_isolation.py` y `test_rag_flow.py` sobre una copia de datos.
5. Notificar según DPA y Ley 1581/2012 en los plazos pactados.
6. Post-mortem con test de regresión obligatorio antes de reabrir.
