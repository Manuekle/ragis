"""CLI de reindexado (RAG-03). Crea jobs `reindex` para las versiones vigentes de uno o más tenants.

  # Dual-write: agrega vectores del modelo nuevo sin tocar los actuales (luego se cambia AI_EMBEDDING_MODEL
  # del rag-engine; rollback = volver la variable).
  python -m ragsis_ingest.reindex --org <uuid> --mode embeddings --model bedrock-titan-embed-v2-1024@v1

  # Re-parseo/re-chunking completo (cambio de parser, chunking u OCR) con swap atómico por versión.
  python -m ragsis_ingest.reindex --org <uuid> --mode full [--only-stale]

  # Backfill del grafo (RAG-05) tras habilitarlo en el tenant (plan u organizations.graph_mode='on').
  python -m ragsis_ingest.reindex --org <uuid> --mode graph

  # Purga de un espacio vectorial retirado tras la ventana de observación.
  python -m ragsis_ingest.reindex --org <uuid> --purge-model local-hash-1024@v1

Opciones: --dry-run (solo cuenta), --inline (procesa en el proceso actual sin SQS: on-prem/soporte).
Se ejecuta con la credencial del worker (RLS por tenant); cada tenant se procesa en su propio contexto.
"""

from __future__ import annotations

import argparse
import json
import sys
import uuid

from ragsis_ai.registry import ModelRegistry
from ragsis_core.aws import sqs_client
from ragsis_core.db import SecurityContext, execute, fetch_all, tenant_tx
from ragsis_core.settings import get_settings

from .pipeline import IngestPipeline, JobMessage


def plan_versions(org: uuid.UUID, mode: str, model: str, only_stale: bool, pool=None) -> list[dict]:
    s = get_settings()
    with tenant_tx(SecurityContext(org), pool) as conn:
        if mode == "embeddings":
            return fetch_all(conn, """
                SELECT v.id, v.document_id FROM document_versions v JOIN documents d ON d.id = v.document_id
                 WHERE v.is_current AND v.status = 'indexed' AND d.status = 'active'
                   AND EXISTS (SELECT 1 FROM chunks c WHERE c.version_id = v.id AND c.index_state = 'active'
                                 AND NOT EXISTS (SELECT 1 FROM chunk_embeddings e
                                                  WHERE e.chunk_id = c.id AND e.model_version = %s))
                 ORDER BY v.created_at""", (model,))
        return fetch_all(conn, """
            SELECT v.id, v.document_id FROM document_versions v JOIN documents d ON d.id = v.document_id
             WHERE v.is_current AND v.status = 'indexed' AND d.status = 'active'
               AND (NOT %s OR v.pipeline_version IS DISTINCT FROM %s OR v.embedding_model IS DISTINCT FROM %s)
             ORDER BY v.created_at""", (only_stale, s.pipeline_version, model))


def enqueue(org: uuid.UUID, versions: list[dict], mode: str, model: str, inline: bool, pool=None,
            pipeline: IngestPipeline | None = None) -> list[str]:
    batch = uuid.uuid4().hex[:8]
    msgs: list[JobMessage] = []
    with tenant_tx(SecurityContext(org), pool) as conn:
        for v in versions:
            job = uuid.uuid4()
            execute(conn, "INSERT INTO ingestion_jobs (id, organization_id, kind, document_id, version_id, idempotency_key, "
                          "params) VALUES (%s,%s,'reindex',%s,%s,%s,%s::jsonb)",
                    (job, org, v["document_id"], v["id"], f"reindex:{mode}:{model}:{v['id']}:{batch}",
                     json.dumps({"mode": mode, "model": model, "batch": batch})))
            msgs.append(JobMessage("reindex", org, v["document_id"], v["id"], job))
    results = []
    if inline:
        p = pipeline or IngestPipeline(pool=pool)
        results = [p.handle(m) for m in msgs]
    else:
        s = get_settings()
        sqs = sqs_client()
        for m in msgs:
            sqs.send_message(QueueUrl=s.sqs_ingest_queue_url, MessageBody=m.body())
        results = [f"queued:{m.job_id}" for m in msgs]
    return results


def purge_model(org: uuid.UUID, model: str, pool=None) -> int:
    if model == get_settings().ai_embedding_model:
        raise SystemExit("no se puede purgar el modelo de embeddings activo")
    with tenant_tx(SecurityContext(org), pool) as conn:
        n = execute(conn, "DELETE FROM chunk_embeddings WHERE model_version = %s", (model,))
        execute(conn, "INSERT INTO audit_events (organization_id, action, resource, decision, metadata) "
                      "VALUES (%s, 'embeddings.purged', %s, 'allow', %s::jsonb)",
                (org, f"model:{model}", json.dumps({"rows": n})))
    return n


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="ragsis-reindex", description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--org", action="append", required=True, type=uuid.UUID)
    ap.add_argument("--mode", choices=["embeddings", "full", "graph"], default="embeddings")
    ap.add_argument("--model", default=None, help="model_id del registry (por defecto AI_EMBEDDING_MODEL)")
    ap.add_argument("--only-stale", action="store_true", help="full: solo versiones con pipeline/modelo distinto")
    ap.add_argument("--purge-model", default=None)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--inline", action="store_true")
    args = ap.parse_args(argv)

    model = args.model or get_settings().ai_embedding_model
    spec = ModelRegistry().get(model)
    if spec.dimensions != 1024:
        raise SystemExit(f"{model} no es un modelo de embeddings de 1024 dimensiones")
    for org in args.org:
        if args.purge_model:
            print(f"{org}: {purge_model(org, args.purge_model)} vectores de {args.purge_model} eliminados")
            continue
        versions = plan_versions(org, args.mode, model, args.only_stale)
        print(f"{org}: {len(versions)} versiones a reindexar (mode={args.mode}, model={model})")
        if args.dry_run or not versions:
            continue
        for r in enqueue(org, versions, args.mode, model, args.inline):
            print(f"  {r}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
