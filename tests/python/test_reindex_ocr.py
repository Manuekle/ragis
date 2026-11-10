"""RAG-03 (reindex dual-write y full) y F3 (OCR de PDFs escaneados con quality gate y política)."""

import io

import pytest
from pypdf import PdfWriter
from ragsis_core.settings import get_settings
from ragsis_ingest.chunker import Chunker
from ragsis_ingest.ocr import OcrResult, TextractOcr
from ragsis_ingest.pipeline import IngestPipeline
from ragsis_ingest.reindex import enqueue, plan_versions, purge_model
from ragsis_rag.orchestrator import QueryOrchestrator

DOC = """# Manual de seguridad industrial

## Elementos de protección
Todo operario debe usar casco, gafas y botas con puntera de acero dentro de la planta de producción.

## Reporte de incidentes
Los incidentes se reportan al supervisor dentro de las 2 horas siguientes mediante el formato SST-04.

## Brigadas
La brigada de emergencias realiza simulacros de evacuación cada seis meses en todas las sedes.
"""
Q = "¿En cuántas horas se reportan los incidentes al supervisor?"


@pytest.fixture
def use_model(monkeypatch):
    def _set(model_id: str):
        monkeypatch.setenv("AI_EMBEDDING_MODEL", model_id)
        get_settings.cache_clear()
    yield _set
    get_settings.cache_clear()


def _count(owner, sql, *params):
    return owner.execute(sql, params).fetchone()["n"]


def test_reindex_embeddings_dual_write_and_switch(make_tenant, s3, worker_pool, app_pool, owner, use_model):
    t = make_tenant("reidx")
    doc, ver, msg = t.add_document(s3, "seguridad.md", DOC.encode(), "text/markdown")
    assert IngestPipeline(pool=worker_pool).handle(msg) == "indexed"
    n_chunks = _count(owner, "SELECT count(*) AS n FROM chunks WHERE version_id=%s", ver)

    pending = plan_versions(t.org, "embeddings", "local-hash-1024@v2", False, pool=worker_pool)
    assert [v["id"] for v in pending] == [ver]
    results = enqueue(t.org, pending, "embeddings", "local-hash-1024@v2", inline=True, pool=worker_pool,
                      pipeline=IngestPipeline(pool=worker_pool))
    assert results == [f"reindexed:embeddings:{n_chunks}"]
    # Ambos espacios coexisten: v1 sigue sirviendo mientras se valida v2.
    for model in ("local-hash-1024@v1", "local-hash-1024@v2"):
        assert _count(owner, "SELECT count(*) AS n FROM chunk_embeddings e JOIN chunks c ON c.id=e.chunk_id "
                             "WHERE c.version_id=%s AND e.model_version=%s", ver, model) == n_chunks
    # Segunda corrida: nada pendiente (idempotente).
    assert plan_versions(t.org, "embeddings", "local-hash-1024@v2", False, pool=worker_pool) == []

    use_model("local-hash-1024@v2")     # swap del rag-engine al nuevo espacio
    r = QueryOrchestrator(pool=app_pool).run(t.claims(), Q)
    assert not r.abstained and "2 horas" in r.answer and r.embedding_model == "local-hash-1024@v2"

    # Purga del espacio retirado; el activo no se puede purgar.
    assert purge_model(t.org, "local-hash-1024@v1", pool=worker_pool) == n_chunks
    with pytest.raises(SystemExit):
        purge_model(t.org, "local-hash-1024@v2", pool=worker_pool)


def test_reindex_full_replaces_chunks_atomically(make_tenant, s3, worker_pool, app_pool, owner):
    t = make_tenant("reidxfull")
    annex = "\n## Anexo de inspecciones\n\n" + "\n\n".join(
        f"La inspección número {i} verifica extintores, señalización y rutas de evacuación en la sede." for i in range(40))
    doc, ver, msg = t.add_document(s3, "seguridad.md", (DOC + annex).encode(), "text/markdown")
    assert IngestPipeline(pool=worker_pool).handle(msg) == "indexed"
    before = _count(owner, "SELECT count(*) AS n FROM chunks WHERE version_id=%s", ver)
    small = IngestPipeline(pool=worker_pool, chunker=Chunker(target=60, maximum=120))
    versions = plan_versions(t.org, "full", get_settings().ai_embedding_model, False, pool=worker_pool)
    [res] = enqueue(t.org, versions, "full", get_settings().ai_embedding_model, inline=True, pool=worker_pool,
                    pipeline=small)
    after = _count(owner, "SELECT count(*) AS n FROM chunks WHERE version_id=%s AND index_state='active'", ver)
    assert res == f"reindexed:full:{after}" and after > before
    assert _count(owner, "SELECT count(*) AS n FROM chunks WHERE version_id=%s AND index_state<>'active'", ver) == 0
    row = owner.execute("SELECT status, chunk_count FROM document_versions WHERE id=%s", (ver,)).fetchone()
    assert row == {"status": "indexed", "chunk_count": after}
    r = QueryOrchestrator(pool=app_pool).run(t.claims(), Q)
    assert not r.abstained and "2 horas" in r.answer


def test_reindex_skips_superseded_versions(make_tenant, s3, worker_pool, owner):
    t = make_tenant("reidxold")
    doc, v1, m1 = t.add_document(s3, "a.md", DOC.encode(), "text/markdown")
    IngestPipeline(pool=worker_pool).handle(m1)
    stale = [{"id": v1, "document_id": doc}]
    _, v2, m2 = t.add_document(s3, "a.md", DOC.replace("2 horas", "4 horas").encode(), "text/markdown",
                               document_id=doc, version_no=2)
    IngestPipeline(pool=worker_pool).handle(m2)
    [res] = enqueue(t.org, stale, "full", get_settings().ai_embedding_model, inline=True, pool=worker_pool,
                    pipeline=IngestPipeline(pool=worker_pool))
    assert res == "skipped:not_current"
    assert _count(owner, "SELECT count(*) AS n FROM chunks WHERE version_id=%s AND index_state='active'", v1) == 0


# ---------------------------------------------------------------- OCR
def _scanned_pdf(pages: int = 2) -> bytes:
    w = PdfWriter()
    for _ in range(pages):
        w.add_blank_page(width=612, height=792)
    buf = io.BytesIO()
    w.write(buf)
    return buf.getvalue()


class StubOcr:
    model_id = "aws-textract@v1"

    def __init__(self, pages: dict[int, list[str]]):
        self.pages = pages
        self.calls = []

    def recognize(self, bucket, key, pages):
        self.calls.append((bucket, key, list(pages)))
        return OcrResult(self.model_id, {p: self.pages[p] for p in pages if p in self.pages}, 96.4, 2)


SCANNED = {
    1: ["CONTRATO DE ARRENDAMIENTO", "El canon mensual de arrendamiento es de 3500000 pesos pagaderos",
        "dentro de los primeros cinco días de cada mes."],
    2: ["El contrato tiene una duración de doce meses prorrogables automáticamente."],
}


def test_scanned_pdf_uses_ocr_and_answers_with_page(make_tenant, s3, worker_pool, app_pool, owner):
    t = make_tenant("ocr")
    pdf = _scanned_pdf()
    doc, ver, msg = t.add_document(s3, "contrato.pdf", pdf, "application/pdf", title="Contrato escaneado")
    ocr = StubOcr(SCANNED)
    assert IngestPipeline(pool=worker_pool, ocr=ocr).handle(msg) == "indexed"
    bucket, key, pages = ocr.calls[0]
    assert key.startswith(f"tenants/{t.org}/") and pages == [1, 2]
    row = owner.execute("SELECT parser, ocr_provider, ocr_mean_confidence, page_count FROM document_versions WHERE id=%s",
                        (ver,)).fetchone()
    assert row["parser"].endswith("+ocr") and row["ocr_provider"] == "aws-textract@v1" and row["page_count"] == 2
    assert _count(owner, "SELECT coalesce(sum(quantity),0)::int AS n FROM usage_events WHERE organization_id=%s "
                         "AND kind='ocr_pages'", t.org) == 2
    r = QueryOrchestrator(pool=app_pool).run(t.claims(), "¿Cuál es el canon mensual de arrendamiento?")
    assert not r.abstained and "3500000" in r.answer
    assert r.citations[0]["page"] == 1


def test_scanned_pdf_without_ocr_is_rejected_explicitly(make_tenant, s3, worker_pool, owner):
    t = make_tenant("noocr")
    _, ver, msg = t.add_document(s3, "scan.pdf", _scanned_pdf(), "application/pdf")
    assert IngestPipeline(pool=worker_pool).handle(msg) == "failed:ocr_required"
    assert owner.execute("SELECT error_code FROM document_versions WHERE id=%s", (ver,)).fetchone()["error_code"] == \
        "ocr_required"


def test_restricted_tenant_cannot_send_pages_to_textract(make_tenant, s3, worker_pool):
    t = make_tenant("ocroffline", data_class="restricted")
    _, _, msg = t.add_document(s3, "scan.pdf", _scanned_pdf(), "application/pdf")
    ocr = StubOcr(SCANNED)
    assert IngestPipeline(pool=worker_pool, ocr=ocr).handle(msg) == "failed:model_policy_violation"
    assert ocr.calls == []


class FakeTextract:
    def __init__(self):
        self.polls = 0

    def start_document_text_detection(self, DocumentLocation):
        assert DocumentLocation["S3Object"]["Name"].startswith("tenants/")
        return {"JobId": "job-1"}

    def get_document_text_detection(self, JobId, MaxResults, NextToken=None):
        self.polls += 1
        if self.polls == 1:
            return {"JobStatus": "IN_PROGRESS"}
        if NextToken is None:
            return {"JobStatus": "SUCCEEDED", "NextToken": "p2", "Blocks": [
                {"BlockType": "PAGE", "Page": 1},
                {"BlockType": "LINE", "Page": 1, "Text": "Línea clara", "Confidence": 99.1},
                {"BlockType": "LINE", "Page": 1, "Text": "l1n3a b0rr0sa", "Confidence": 31.0},
                {"BlockType": "LINE", "Page": 3, "Text": "página con texto digital", "Confidence": 99.0},
            ]}
        return {"JobStatus": "SUCCEEDED", "Blocks": [
            {"BlockType": "LINE", "Page": 2, "Text": "Segunda página", "Confidence": 88.0}]}


def test_textract_adapter_paginates_and_filters_low_confidence(monkeypatch):
    monkeypatch.setattr("time.sleep", lambda _s: None)
    res = TextractOcr(timeout_s=30, min_conf=60, client=FakeTextract()).recognize("b", "tenants/x/raw/a.pdf", [1, 2])
    assert res.pages == {1: ["Línea clara"], 2: ["Segunda página"]}
    assert res.dropped_lines == 1 and res.mean_confidence == pytest.approx(93.55)
