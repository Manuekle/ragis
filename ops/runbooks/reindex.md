# Reindex (change of parser, chunking, OCR or embedding model)

Rule: every change of parser, embedding, LLM or prompt requires a regression evaluation with the golden set **before**
it is activated (section 13). CLI: `python -m ragsis_ingest.reindex` (`ingest-worker` image, worker credential; RLS per
tenant). `--dry-run` counts without enqueueing; `--inline` processes without SQS.

## Embedding model change (dual-write, no downtime)

1. Register the model in `ModelRegistry` with a new versioned `model_id` (1024 dims).
2. Add vectors from the new model to the active chunks (they coexist with the current ones):
   ```bash
   python -m ragsis_ingest.reindex --org <uuid> --mode embeddings --model <new_model_id> --dry-run
   python -m ragsis_ingest.reindex --org <uuid> --mode embeddings --model <new_model_id>
   ```
   Repeat until `--dry-run` reports 0 pending versions (idempotent).
3. `make eval` in staging with `AI_EMBEDDING_MODEL=<new>` on the rag-engine; compare with the baseline in
   `eval/reports/`.
4. Swap: deploy the rag-engine **and** workers with `AI_EMBEDDING_MODEL=<new>`.
5. Rollback: revert the variable; the old vectors are still present.
6. After the observation window: `python -m ragsis_ingest.reindex --org <uuid> --purge-model <old>`
   (purging the active model is rejected).

## Parser / chunking / OCR change (full)

```bash
python -m ragsis_ingest.reindex --org <uuid> --mode full --only-stale
```
Re-parses from the original in S3 and replaces the chunks of each current version in **one transaction** (queries see
the old index until COMMIT). It only recomputes vectors of the active model: if a dual-write is in progress, repeat the
`--mode embeddings` step afterwards. Versions that stopped being current during the process are skipped
(`skipped:not_current`). A failure does not alter the served version (`document.reindex_failed` event).
