# Reindexado (cambio de parser, chunking, OCR o modelo de embeddings)

Regla: cada cambio de parser, embedding, LLM o prompt requiere evaluación de regresión con el
golden set **antes** de activarse (sección 13). CLI: `python -m ragsis_ingest.reindex` (imagen `ingest-worker`,
credencial del worker; RLS por tenant). `--dry-run` cuenta sin encolar; `--inline` procesa sin SQS.

## Cambio de modelo de embeddings (dual-write, sin downtime)

1. Registrar el modelo en `ModelRegistry` con un `model_id` versionado nuevo (1024 dims).
2. Agregar vectores del modelo nuevo a los chunks activos (coexisten con los actuales):
   ```bash
   python -m ragsis_ingest.reindex --org <uuid> --mode embeddings --model <nuevo_model_id> --dry-run
   python -m ragsis_ingest.reindex --org <uuid> --mode embeddings --model <nuevo_model_id>
   ```
   Repetir hasta que `--dry-run` reporte 0 versiones pendientes (idempotente).
3. `make eval` en staging con `AI_EMBEDDING_MODEL=<nuevo>` en rag-engine; comparar con el baseline de `eval/reports/`.
4. Swap: desplegar rag-engine **y** workers con `AI_EMBEDDING_MODEL=<nuevo>`.
5. Rollback: volver la variable; los vectores viejos siguen presentes.
6. Tras la ventana de observación: `python -m ragsis_ingest.reindex --org <uuid> --purge-model <viejo>`
   (se rechaza purgar el modelo activo).

## Cambio de parser / chunking / OCR (full)

```bash
python -m ragsis_ingest.reindex --org <uuid> --mode full --only-stale
```
Re-parsea desde el original en S3 y reemplaza los chunks de cada versión vigente en **una transacción**
(las consultas ven el índice viejo hasta el COMMIT). Solo recalcula vectores del modelo activo: si hay un
dual-write en curso, repetir el paso `--mode embeddings` después. Versiones que dejaron de ser vigentes
durante el proceso se omiten (`skipped:not_current`). Un fallo no altera la versión servida
(evento `document.reindex_failed`).
