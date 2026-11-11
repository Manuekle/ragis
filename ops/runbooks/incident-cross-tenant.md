# Incident: suspected cross-tenant access

Critical severity. Leakage target: 0.

1. Contain: if there is active evidence, put the API in maintenance (desired count 0 of the `api` service) or block the tenant (`organizations.status='suspended'`).
2. Preserve evidence: export `audit_events` (hash chain: verify `prev_hash` → `hash`) and API/rag-engine logs by `trace_id`.
3. Determine scope: `query_runs` + `citations` for the period; check that each `citations.document_id` belongs to the run's `organization_id`:
   ```sql
   SELECT c.query_run_id FROM citations c JOIN documents d ON d.id = c.document_id
    WHERE d.organization_id <> c.organization_id;
   ```
4. Reproduce with `tests/python/test_isolation.py` and `test_rag_flow.py` on a copy of the data.
5. Notify according to the DPA and Colombian Law 1581 of 2012 (data protection) within the agreed deadlines.
6. Post-mortem with a mandatory regression test before reopening.
