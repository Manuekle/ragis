# policy

Authorization policies live in the database (forced RLS, `db/migrations/0001_init.sql`)
and in `apps/api/src/lib/tenant.ts` (membership → tenant → principals → roles).

Policy tests (SEC-01, AUTH-02):

- `tests/python/test_isolation.py` — cross-tenant RLS, ACL by group, role privileges, audit chain.
- `tests/python/test_rag_flow.py` — retrieval without crossings between similar tenants, ACL in retrieval, verifiable deletion.
- `apps/api/test/api.test.ts` — tenant resolution by membership, roles, ACL in listings, internal token.
- `eval/golden/sample.yaml` — adversarial ACL cases in the golden set (target: leakage = 0).
