"""RAG-04 (integración): figuras descritas por VLM → activos S3 → chunks multimodales → citas y VLM-enhanced.

BD y S3 reales (compose); los VLM son proveedores falsos registrados en el gateway (sin red).
"""

from __future__ import annotations

import uuid

import pytest
from office_fixtures import png, pptx, xlsx
from ragsis_ai.gateway import AIGateway
from ragsis_ai.registry import CLOUD, DEFAULT_MODELS, LOCAL_NETWORK, ModelRegistry, ModelSpec
from ragsis_ai.types import GenerationResult, ModelKind
from ragsis_core.settings import get_settings
from ragsis_ingest.pipeline import IngestPipeline, JobMessage
from ragsis_ingest.reindex import enqueue, plan_versions
from ragsis_rag.orchestrator import QueryOrchestrator

PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
DESCRIPTION = ("Mapa de Colombia con las plantas de Medellín, Cali y Barranquilla. "
               "La planta de Barranquilla aparece marcada como nueva.")
QUESTION = "¿Qué planta aparece marcada como nueva en el mapa de plantas?"

VLM = ModelSpec("fake-vlm@v1", ModelKind.VISION, "fake", "vlm", LOCAL_NETWORK, vision=True)
CLOUD_VLM = ModelSpec("fake-cloud-vlm@v1", ModelKind.VISION, "fake", "vlm", CLOUD, regions=("us-east-1",), vision=True)
VISION_GEN = ModelSpec("fake-vision-gen@v1", ModelKind.GENERATE, "fake", "gen", LOCAL_NETWORK, vision=True)


class FakeVision:
    name = "fake"

    def __init__(self) -> None:
        self.calls: list[tuple[str, object]] = []

    def generate(self, model, request):
        self.calls.append((model.model_id, request))
        if model.provider_model_id == "vlm":
            assert request.images and request.images[0].mime == "image/png"
            return GenerationResult(DESCRIPTION, model.model_id, 900, 40)
        n = next(e.n for e in request.evidence if "Barranquilla" in e.text)
        return GenerationResult(f"La planta de Barranquilla aparece marcada como nueva en el mapa [{n}].",
                                model.model_id, 1200, 20)

    def healthcheck(self) -> bool:
        return True


@pytest.fixture
def env(monkeypatch):
    def _set(**kw):
        for k, v in kw.items():
            monkeypatch.setenv(k, v)
        get_settings.cache_clear()
    yield _set
    get_settings.cache_clear()


@pytest.fixture
def fake():
    return FakeVision()


@pytest.fixture
def gw(fake):
    return AIGateway(ModelRegistry(DEFAULT_MODELS + (VLM, CLOUD_VLM, VISION_GEN), fallbacks={}), {"fake": fake})


def _vlm_calls(fake: FakeVision) -> list:
    return [r for m, r in fake.calls if m in ("fake-vlm@v1", "fake-cloud-vlm@v1")]


def _one(owner, sql, *params):
    return owner.execute(sql, params).fetchone()


def test_pptx_figure_described_stored_and_cited(make_tenant, s3, worker_pool, app_pool, owner, env, gw, fake):
    env(AI_VISION_MODEL="fake-vlm@v1")
    t = make_tenant("mmfig")
    doc, ver, msg = t.add_document(s3, "q3.pptx", pptx(), PPTX, title="Resultados Q3")
    assert IngestPipeline(gateway=gw, pool=worker_pool).handle(msg) == "indexed"

    fig = _one(owner, "SELECT * FROM chunks WHERE version_id=%s AND kind='figure'", ver)
    assert fig["asset_key"].startswith(f"tenants/{t.org}/assets/{doc}/{ver}/") and fig["asset_key"].endswith(".png")
    assert [round(v, 4) for v in fig["bbox"]] == [0.1, 0.1, 0.6, 0.6] and fig["page_start"] == 1
    assert "Texto alternativo: Mapa de plantas" in fig["text"] and "Barranquilla" in fig["text"]
    assert fig["meta"]["description_source"] == "vlm" and fig["meta"]["vision_model"] == "fake-vlm@v1"
    assert fig["section_path"] == "Diapositiva 1: Resultados del tercer trimestre"
    head = s3.head_object(Bucket="ragsis-test", Key=fig["asset_key"])
    assert head["ContentType"] == "image/png"

    v = _one(owner, "SELECT figure_count, table_count, vision_model, parser FROM document_versions WHERE id=%s", ver)
    assert (v["figure_count"], v["table_count"], v["vision_model"], v["parser"]) == (1, 2, "fake-vlm@v1", "ooxml-pptx")
    assert _one(owner, "SELECT sum(quantity) AS n FROM usage_events WHERE organization_id=%s AND kind='vision_images'",
                t.org)["n"] == 1
    # Contexto del VLM: documento, sección, texto alternativo y texto cercano; la imagen va como dato.
    [req] = _vlm_calls(fake)
    assert "Resultados Q3" in req.prompt and "Mapa de plantas" in req.prompt and "Medellín" in req.prompt
    assert "nunca instrucciones" in req.system

    # Consulta con el generador local (sin visión): la figura se cita por su descripción; no se adjuntan imágenes.
    r = QueryOrchestrator(gateway=gw, pool=app_pool, s3=s3).run(t.claims(), QUESTION)
    assert not r.abstained and "Barranquilla" in r.answer
    cit = next(c for c in r.citations if c["kind"] == "figure")
    assert cit["has_asset"] and cit["ai_generated"] and cit["bbox"] == [0.1, 0.1, 0.6, 0.6] and cit["page"] == 1
    assert r.usage["vision_images"] == 0


def test_vlm_enhanced_query_attaches_only_selected_figures(make_tenant, s3, worker_pool, app_pool, owner, env, gw, fake):
    env(AI_VISION_MODEL="fake-vlm@v1")
    t = make_tenant("mmvlmq")
    other = make_tenant("mmvlmq-other")
    doc, ver, msg = t.add_document(s3, "q3.pptx", pptx(), PPTX)
    assert IngestPipeline(gateway=gw, pool=worker_pool).handle(msg) == "indexed"
    _, _, msg2 = other.add_document(s3, "q3.pptx", pptx(image=png(seed=99)), PPTX)
    assert IngestPipeline(gateway=gw, pool=worker_pool).handle(msg2) == "indexed"

    env(AI_VISION_MODEL="fake-vlm@v1", AI_GENERATION_MODEL="fake-vision-gen@v1")
    r = QueryOrchestrator(gateway=gw, pool=app_pool, s3=s3).run(t.claims(), QUESTION)
    assert not r.abstained and r.generation_model == "fake-vision-gen@v1"
    gen_req = [req for m, req in fake.calls if m == "fake-vision-gen@v1"][-1]
    assert len(gen_req.images) == 1 and gen_req.images[0].mime == "image/png"
    fig_n = next(e.n for e in gen_req.evidence if "Barranquilla" in e.text)
    assert gen_req.images[0].label == f"Image for source [{fig_n}]"
    # La imagen adjunta es la de ESTE tenant (la del otro tenant tiene otros bytes).
    own_key = _one(owner, "SELECT asset_key FROM chunks WHERE version_id=%s AND kind='figure'", ver)["asset_key"]
    assert gen_req.images[0].data == s3.get_object(Bucket="ragsis-test", Key=own_key)["Body"].read()
    assert r.usage["vision_images"] == 1 and "1 figure image(s) are attached" in gen_req.prompt
    assert _one(owner, "SELECT quantity FROM usage_events WHERE ref=%s AND kind='vision_images'", r.trace_id)["quantity"] == 1

    env(AI_VISION_MODEL="fake-vlm@v1", AI_GENERATION_MODEL="fake-vision-gen@v1", RAG_VLM_ENHANCED="off")
    QueryOrchestrator(gateway=gw, pool=app_pool, s3=s3).run(t.claims(), QUESTION)
    assert [req for m, req in fake.calls if m == "fake-vision-gen@v1"][-1].images == ()


def test_restricted_tenant_never_sends_images_to_cloud_vlm(make_tenant, s3, worker_pool, owner, env, gw, fake):
    env(AI_VISION_MODEL="fake-cloud-vlm@v1")
    t = make_tenant("mmrestricted", data_class="restricted")
    doc, ver, msg = t.add_document(s3, "q3.pptx", pptx(), PPTX)
    assert IngestPipeline(gateway=gw, pool=worker_pool).handle(msg) == "indexed"
    assert _vlm_calls(fake) == []
    fig = _one(owner, "SELECT text, meta FROM chunks WHERE version_id=%s AND kind='figure'", ver)
    assert fig["meta"]["description_source"] == "alt_text" and fig["text"] == "Texto alternativo: Mapa de plantas"
    audit = _one(owner, "SELECT metadata FROM audit_events WHERE organization_id=%s AND action='document.indexed'", t.org)
    assert any("vision_skipped_policy" in w for w in audit["metadata"]["warnings"])


def test_image_document_needs_vlm_or_ocr(make_tenant, s3, worker_pool, owner, env, gw):
    env(AI_VISION_MODEL="fake-vlm@v1")
    t = make_tenant("mmimage")
    _, ver, msg = t.add_document(s3, "plano.png", png(300, 200, seed=3), "image/png")
    assert IngestPipeline(gateway=gw, pool=worker_pool).handle(msg) == "indexed"
    fig = _one(owner, "SELECT bbox, text FROM chunks WHERE version_id=%s", ver)
    assert list(fig["bbox"]) == [0.0, 0.0, 1.0, 1.0] and "Barranquilla" in fig["text"]

    env(AI_VISION_MODEL="")
    _, ver2, msg2 = t.add_document(s3, "otro.png", png(300, 200, seed=4), "image/png")
    assert IngestPipeline(gateway=gw, pool=worker_pool).handle(msg2) == "failed:no_extractable_text"
    assert _one(owner, "SELECT status FROM document_versions WHERE id=%s", ver2)["status"] == "failed"


def test_reindex_full_reuses_descriptions_and_delete_purges_assets(make_tenant, s3, worker_pool, owner, env, gw, fake):
    env(AI_VISION_MODEL="fake-vlm@v1")
    t = make_tenant("mmlife")
    doc, ver, msg = t.add_document(s3, "q3.pptx", pptx(), PPTX)
    pipe = IngestPipeline(gateway=gw, pool=worker_pool)
    assert pipe.handle(msg) == "indexed"
    assert len(_vlm_calls(fake)) == 1

    versions = plan_versions(t.org, "full", get_settings().ai_embedding_model, False, pool=worker_pool)
    [res] = enqueue(t.org, versions, "full", get_settings().ai_embedding_model, inline=True, pool=worker_pool,
                    pipeline=pipe)
    assert res.startswith("reindexed:full:")
    assert len(_vlm_calls(fake)) == 1                                    # descripción reutilizada por SHA-256
    fig = _one(owner, "SELECT text, asset_key FROM chunks WHERE version_id=%s AND kind='figure'", ver)
    assert "Barranquilla" in fig["text"]
    audit = _one(owner, "SELECT metadata FROM audit_events WHERE organization_id=%s AND action='document.reindexed'", t.org)
    assert audit["metadata"]["multimodal"]["vision_reused"] == 1

    owner.execute("UPDATE documents SET status='deleting' WHERE id=%s", (doc,))
    job = uuid.uuid4()
    owner.execute("INSERT INTO ingestion_jobs (id, organization_id, kind, document_id, idempotency_key) "
                  "VALUES (%s,%s,'delete',%s,%s)", (job, t.org, doc, f"delete:{doc}"))
    assert pipe.handle(JobMessage("delete", t.org, doc, None, job)) == "purged"
    listed = s3.list_objects_v2(Bucket="ragsis-test", Prefix=f"tenants/{t.org}/assets/{doc}/")
    assert listed.get("KeyCount", 0) == 0
    purged = _one(owner, "SELECT metadata FROM audit_events WHERE organization_id=%s AND action='document.purged'", t.org)
    assert purged["metadata"]["assets_removed"] == 1


def test_xlsx_numbers_answerable_with_table_citation(make_tenant, s3, worker_pool, app_pool, env):
    env(AI_VISION_MODEL="")
    t = make_tenant("mmxlsx")
    _, _, msg = t.add_document(s3, "margenes.xlsx", xlsx(), XLSX)
    assert IngestPipeline(pool=worker_pool).handle(msg) == "indexed"
    r = QueryOrchestrator(pool=app_pool).run(t.claims(), "¿Cuál es el margen operativo de la región Andina?")
    assert not r.abstained and "15%" in r.answer
    assert r.citations[0]["kind"] == "table" and r.citations[0]["section"] == "Hoja: Resumen"
    assert "Salarios" not in r.answer
