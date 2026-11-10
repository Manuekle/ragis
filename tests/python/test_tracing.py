"""OBS-01: spans por etapa con atributos pseudónimos, propagación W3C y sin datos de usuario."""

import re

import pytest
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from ragsis_core.telemetry import remote_parent
from ragsis_ingest.pipeline import IngestPipeline
from ragsis_rag.orchestrator import QueryOrchestrator

EXPORTER = InMemorySpanExporter()
_provider = TracerProvider()
_provider.add_span_processor(SimpleSpanProcessor(EXPORTER))
trace.set_tracer_provider(_provider)

SECRET_Q = "¿Cuál es el plazo confidencial de reembolso de viáticos de la gerencia?"
DOC = "# Viáticos\n\n## Reembolsos\nEl plazo de reembolso de viáticos de la gerencia es de 7 días hábiles.\n"
PARENT_TRACE = "4bf92f3577b34da6a3ce929d0e0e4736"


@pytest.fixture(autouse=True)
def _clear():
    EXPORTER.clear()


def test_query_spans_propagation_and_no_pii(make_tenant, s3, worker_pool, app_pool):
    t = make_tenant("otel")
    _, _, msg = t.add_document(s3, "v.md", DOC.encode(), "text/markdown")
    assert IngestPipeline(pool=worker_pool).handle(msg) == "indexed"
    EXPORTER.clear()
    with remote_parent({"traceparent": f"00-{PARENT_TRACE}-00f067aa0ba902b7-01"}):
        r = QueryOrchestrator(pool=app_pool).run(t.claims(), SECRET_Q)
    assert not r.abstained
    spans = {s.name: s for s in EXPORTER.get_finished_spans()}
    assert {"rag.query", "rag.embed", "rag.retrieve", "rag.generate", "rag.verify", "rag.persist"} <= set(spans)
    root = spans["rag.query"]
    assert format(root.context.trace_id, "032x") == PARENT_TRACE           # continúa la traza de la API
    assert spans["rag.retrieve"].parent.span_id == root.context.span_id
    assert root.attributes["ragsis.org_id"] == str(t.org)
    assert root.attributes["ragsis.query_trace_id"] == r.trace_id
    assert root.attributes["ragsis.cited"] >= 1
    dump = repr([dict(s.attributes) for s in spans.values()])
    assert "confidencial" not in dump and "7 días" not in dump
    assert not re.search(r"[\w.+-]+@[\w-]+\.\w+", dump)                    # sin emails


def test_ingest_job_span_continues_upload_trace(make_tenant, s3, worker_pool):
    t = make_tenant("oteling")
    _, _, msg = t.add_document(s3, "v.md", DOC.encode(), "text/markdown")
    msg = msg.__class__(msg.kind, msg.organization_id, msg.document_id, msg.version_id, msg.job_id,
                        f"00-{PARENT_TRACE}-00f067aa0ba902b7-01")
    assert IngestPipeline(pool=worker_pool).handle(msg) == "indexed"
    [span] = [s for s in EXPORTER.get_finished_spans() if s.name == "ingest.ingest"]
    assert format(span.context.trace_id, "032x") == PARENT_TRACE
    assert span.attributes["ragsis.result"] == "indexed"
