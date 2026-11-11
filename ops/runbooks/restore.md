# Consistent restore (RPO ≤ 24 h, RTO ≤ 8 h in the MVP)

RDS snapshots do not transactionally rebuild S3 or the job state.

1. Restore RDS to a point in time (PITR) on a new instance; point the services to it in maintenance mode.
2. S3 is versioned: the original objects are the source of truth; no restore is needed unless they were deleted.
3. Reconcile: `indexed` versions whose object does not exist in S3 → mark `failed` (`error_code='restore_missing_object'`).
4. Chunks/embeddings are derived: if consistency is in doubt, reindex (runbook `reindex.md`) from the originals.
5. `queued/running` jobs after the restore point: requeue.
6. Mandatory quarterly rehearsal (the "Continuity" gate in the production checklist).
