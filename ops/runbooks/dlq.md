# Messages in the ingestion DLQ

A message reaches `ragsis-<env>-ingest-dlq` after 4 failed receives (transient errors: Bedrock/ClamAV/S3/DB
unavailable). Permanent errors (invalid file, malware, model policy, page limit) do **not** go to the DLQ: they end as
`failed/rejected`.

1. Review `ingestion_jobs` with `state='dead'`:
   ```sql
   SELECT id, organization_id, document_id, version_id, attempts, last_error, updated_at
     FROM ingestion_jobs WHERE state = 'dead' ORDER BY updated_at DESC LIMIT 50;
   ```
2. Classify the cause in `last_error` and the worker logs (`/ragsis/<env>/ingest-worker`, filter by `job`).
3. Fix the cause (Bedrock quota, ClamAV sidecar, credentials).
4. Requeue: set the job to `queued` and redrive from the SQS console (*Start DLQ redrive*) or:
   ```sql
   UPDATE ingestion_jobs SET state='queued', last_error=NULL WHERE id = '<job_id>';
   UPDATE document_versions SET status='uploaded', error_code=NULL WHERE id = '<version_id>';
   ```
   Processing is idempotent per job/version.
5. Verify the final state `indexed` at `GET /v1/organizations/{org}/documents/{id}/status`.
