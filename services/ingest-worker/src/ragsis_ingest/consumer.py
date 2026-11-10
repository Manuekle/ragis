"""Consumidor SQS con long polling, backoff exponencial y apagado limpio (SIGTERM de ECS)."""

from __future__ import annotations

import logging
import signal
import sys

from ragsis_core.aws import sqs_client
from ragsis_core.logging import log, setup_logging
from ragsis_core.settings import get_settings
from ragsis_core.telemetry import init_tracing, shutdown_tracing

from .pipeline import IngestPipeline, JobMessage, PermanentError, TransientError

logger = logging.getLogger("ragsis.ingest.consumer")
_running = True


def _stop(*_):
    global _running
    _running = False


def run_once(pipeline: IngestPipeline, max_messages: int = 5, wait: int = 20) -> int:
    s = get_settings()
    sqs = sqs_client()
    resp = sqs.receive_message(QueueUrl=s.sqs_ingest_queue_url, MaxNumberOfMessages=max_messages,
                               WaitTimeSeconds=wait, VisibilityTimeout=300,
                               MessageSystemAttributeNames=["ApproximateReceiveCount"])
    messages = resp.get("Messages", [])
    if not _running and messages:
        # SIGTERM llegó durante el long poll: devolver los mensajes a la cola de inmediato
        # en vez de dejarlos invisibles hasta que venza el visibility timeout.
        for m in messages:
            sqs.change_message_visibility(QueueUrl=s.sqs_ingest_queue_url, ReceiptHandle=m["ReceiptHandle"],
                                          VisibilityTimeout=0)
        log(logger, logging.INFO, "mensajes liberados por apagado", count=len(messages))
        return 0
    handled = 0
    for m in messages:
        receive_count = int(m.get("Attributes", {}).get("ApproximateReceiveCount", "1"))
        try:
            msg = JobMessage.parse(m["Body"])
            result = pipeline.handle(msg, receive_count)
            log(logger, logging.INFO, "job.done", job=str(msg.job_id), result=result)
            sqs.delete_message(QueueUrl=s.sqs_ingest_queue_url, ReceiptHandle=m["ReceiptHandle"])
        except PermanentError as exc:
            log(logger, logging.ERROR, "mensaje descartado", code=exc.code)
            sqs.delete_message(QueueUrl=s.sqs_ingest_queue_url, ReceiptHandle=m["ReceiptHandle"])
        except TransientError:
            delay = min(900, 30 * 2 ** (receive_count - 1))
            sqs.change_message_visibility(QueueUrl=s.sqs_ingest_queue_url, ReceiptHandle=m["ReceiptHandle"],
                                          VisibilityTimeout=delay)
            log(logger, logging.WARNING, "job reintentará", delay_s=delay, receive_count=receive_count)
        handled += 1
    return handled


def main() -> None:
    s = get_settings()
    setup_logging(s.log_level)
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    init_tracing("ragsis-ingest-worker")
    pipeline = IngestPipeline()
    log(logger, logging.INFO, "ingest-worker iniciado", queue=s.sqs_ingest_queue_url,
        embedding_model=s.ai_embedding_model)
    while _running:
        try:
            run_once(pipeline)
        except Exception:  # noqa: BLE001 - el bucle no debe morir por un error inesperado
            logger.exception("error en ciclo de consumo")
    shutdown_tracing()
    log(logger, logging.INFO, "ingest-worker detenido")
    sys.exit(0)


if __name__ == "__main__":
    main()
