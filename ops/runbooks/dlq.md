# Mensajes en la DLQ de ingesta

Un mensaje llega a `ragsis-<env>-ingest-dlq` tras 4 recepciones fallidas (errores transitorios:
Bedrock/ClamAV/S3/BD no disponibles). Los errores definitivos (archivo inválido, malware,
política de modelos, límite de páginas) **no** van a la DLQ: quedan como `failed/rejected`.

1. Revisar `ingestion_jobs` con `state='dead'`:
   ```sql
   SELECT id, organization_id, document_id, version_id, attempts, last_error, updated_at
     FROM ingestion_jobs WHERE state = 'dead' ORDER BY updated_at DESC LIMIT 50;
   ```
2. Clasificar la causa en `last_error` y logs del worker (`/ragsis/<env>/ingest-worker`, filtrar por `job`).
3. Corregir la causa (cuota Bedrock, sidecar ClamAV, credenciales).
4. Reencolar: poner el job en `queued` y redrive desde la consola SQS (*Start DLQ redrive*) o:
   ```sql
   UPDATE ingestion_jobs SET state='queued', last_error=NULL WHERE id = '<job_id>';
   UPDATE document_versions SET status='uploaded', error_code=NULL WHERE id = '<version_id>';
   ```
   El procesamiento es idempotente por job/versión.
5. Verificar estado final `indexed` en `GET /v1/organizations/{org}/documents/{id}/status`.
