"""La clasificación de cada documento cuenta para elegir modelo, no solo la de la organización.

La API acepta `classification` por documento (public, internal, confidential, restricted) y la guardaba, pero ni
Preguntar ni la ingesta la consultaban: un documento `restricted` de una organización `internal` salía igual al
modelo en la nube. Ahora manda la clasificación más estricta entre la organización y los documentos que se envían.
"""

import pytest
from ragsis_ai.gateway import AIGateway
from ragsis_ai.registry import ModelRegistry
from ragsis_ai.types import DataClass, GenerationResult, strictest
from ragsis_core.db import SecurityContext, fetch_one, tenant_tx
from ragsis_core.settings import get_settings
from ragsis_ingest.pipeline import _VERSION_SQL, IngestPipeline
from ragsis_rag.orchestrator import QueryOrchestrator

CLOUD_MODEL = "meta-muse-spark-1.3@v1"


class FakeCloud:
    """Modelo en la nube que responde citando la primera evidencia y registra qué documentos recibió."""

    name = "fake-cloud"

    def __init__(self) -> None:
        self.seen: list[str] = []

    def generate(self, model, request):
        self.seen.extend(ev.title for ev in request.evidence)
        return GenerationResult(f"{request.evidence[0].text} [1]", model.model_id, 100, 20)

    def embed(self, model, texts, input_type):
        raise AssertionError("embeddings en la nube no esperados")

    def rerank(self, model, query, documents):
        raise AssertionError("rerank en la nube no esperado")


@pytest.fixture
def env(monkeypatch):
    def _set(**kw):
        for k, v in kw.items():
            monkeypatch.setenv(k, v)
        get_settings.cache_clear()
    yield _set
    get_settings.cache_clear()


def test_strictest_never_relaxes():
    assert strictest("internal") is DataClass.INTERNAL
    assert strictest("internal", "restricted", "public") is DataClass.RESTRICTED
    assert strictest(DataClass.RESTRICTED, "public") is DataClass.RESTRICTED
    assert strictest("public", "confidential", "internal") is DataClass.CONFIDENTIAL


@pytest.fixture
def firm(make_tenant, owner, s3, worker_pool):
    t = make_tenant("clasificacion")
    pipeline = IngestPipeline(pool=worker_pool)

    def add(name: str, text: str, classification: str):
        doc, _, msg = t.add_document(s3, f"{name}.md", text.encode(), "text/markdown", title=name)
        owner.execute("UPDATE documents SET classification=%s WHERE id=%s", (classification, doc))
        assert pipeline.handle(msg) == "indexed"
        return doc

    add("Reglamento interno", "# Vacaciones\n\nCada colaborador tiene derecho a 15 dias habiles de vacaciones.", "internal")
    add("Memorando de honorarios", "# Honorarios\n\nLos honorarios pactados con el cliente son 27.500.000 pesos.",
        "restricted")
    add("Acuerdo de confidencialidad", "# Penalidad\n\nLa penalidad por divulgar la estrategia es de 90 millones.",
        "confidential")
    return t


@pytest.mark.parametrize("question,cloud", [
    ("¿Cuántos días de vacaciones tiene cada colaborador?", True),
    ("¿Cuáles son los honorarios pactados con el cliente?", False),       # restricted: nunca a la nube
    ("¿Cuál es la penalidad por divulgar la estrategia?", False),         # confidential sin allowlist: local
])
def test_ask_uses_the_strictest_classification_of_its_evidence(firm, app_pool, env, question, cloud):
    env(AI_GENERATION_MODEL=CLOUD_MODEL)
    fake = FakeCloud()
    rag = QueryOrchestrator(gateway=AIGateway(ModelRegistry(), {"meta": fake}), pool=app_pool)
    r = rag.run(firm.claims(), question)
    assert not r.abstained, r.answer
    if cloud:
        assert r.generation_model == CLOUD_MODEL and fake.seen == ["Reglamento interno"]
    else:
        assert r.generation_model == "local-extractive@v1"
        assert fake.seen == [], f"salió a la nube: {fake.seen}"


@pytest.mark.parametrize("org_class,doc_class,expected", [
    ("internal", "restricted", DataClass.RESTRICTED),
    ("internal", "confidential", DataClass.CONFIDENTIAL),
    ("internal", "public", DataClass.INTERNAL),       # un documento público no relaja la organización
    ("restricted", "public", DataClass.RESTRICTED),
])
def test_ingestion_policy_uses_the_document_classification(make_tenant, owner, s3, worker_pool,
                                                           org_class, doc_class, expected):
    t = make_tenant("ingesta-clase", data_class=org_class)
    doc, ver, _ = t.add_document(s3, "a.md", b"# A\n\nTexto.", "text/markdown", title="A")
    owner.execute("UPDATE documents SET classification=%s WHERE id=%s", (doc_class, doc))
    with tenant_tx(SecurityContext(t.org, None, ()), worker_pool) as conn:
        row = fetch_one(conn, _VERSION_SQL, (ver, doc))
    assert IngestPipeline._policy(row).data_class is expected
