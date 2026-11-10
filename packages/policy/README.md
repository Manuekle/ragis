# policy

Las políticas de autorización viven en la base de datos (RLS forzada, `db/migrations/0001_init.sql`)
y en `apps/api/src/lib/tenant.ts` (membresía → tenant → principals → roles).

Pruebas de política (SEC-01, AUTH-02):

- `tests/python/test_isolation.py` — RLS cross-tenant, ACL por grupo, privilegios de roles, cadena de auditoría.
- `tests/python/test_rag_flow.py` — retrieval sin cruces entre tenants similares, ACL en retrieval, borrado verificable.
- `apps/api/test/api.test.ts` — resolución de tenant por membresía, roles, ACL en listados, token interno.
- `eval/golden/sample.yaml` — casos ACL adversariales en el golden set (meta: leakage = 0).
