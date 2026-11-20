"""Las citas se numeran 1, 2, 3… en el orden en que aparecen en la respuesta.

Antes llevaban el número del fragmento dentro de la evidencia entregada al modelo, así que una respuesta con 7 fuentes
mostraba [8], [4], [3], [5], [1], [7], [2]. El número de cada cita, sus marcas en el texto y lo que se guarda en la base
deben seguir coincidiendo.
"""

import pytest
from ragsis_ai.gateway import AIGateway
from ragsis_ai.registry import ModelRegistry
from ragsis_ai.types import GenerationResult
from ragsis_core.db import SecurityContext, fetch_all, tenant_tx
from ragsis_core.settings import get_settings
from ragsis_ingest.pipeline import IngestPipeline
from ragsis_rag.orchestrator import QueryOrchestrator
from ragsis_rag.verifier import renumber_citations

CLOUD_MODEL = "meta-muse-spark-1.3@v1"


@pytest.mark.parametrize("text,cited,expected,mapping", [
    ("A [8]. B [4]. C [8][3].", [8, 4, 3], "A [1]. B [2]. C [1][3].", {8: 1, 4: 2, 3: 3}),
    ("Uno [2][1].", [2, 1], "Uno [1][2].", {2: 1, 1: 2}),
    ("Ya en orden [1]. Luego [2].", [1, 2], "Ya en orden [1]. Luego [2].", {1: 1, 2: 2}),
    # Una cita válida que no aparece en el texto (p. ej. solo en una tabla del documento) va al final.
    ("Solo [5].", [5, 2], "Solo [1].", {5: 1, 2: 2}),
    # Corchetes que no son citas válidas no se tocan.
    ("Ver [9] y el anexo [1].", [1], "Ver [9] y el anexo [1].", {1: 1}),
])
def test_renumber_citations_by_first_appearance(text, cited, expected, mapping):
    assert renumber_citations(text, cited) == (expected, mapping)


class Backwards:
    """Modelo en la nube que cita la evidencia al revés: la última primero."""

    name = "backwards"

    def generate(self, model, request):
        body = " ".join(f"{e.text.strip().rstrip('.')} [{e.n}]." for e in reversed(request.evidence))
        return GenerationResult(body, model.model_id, 100, 40)

    def embed(self, model, texts, input_type):
        raise AssertionError("no embeddings en la nube")

    def rerank(self, model, query, documents):
        raise AssertionError("no rerank en la nube")


@pytest.fixture
def env(monkeypatch):
    def _set(**kw):
        for k, v in kw.items():
            monkeypatch.setenv(k, v)
        get_settings.cache_clear()
    yield _set
    get_settings.cache_clear()


@pytest.fixture
def firm(make_tenant, s3, worker_pool):
    t = make_tenant("orden-citas")
    pipeline = IngestPipeline(pool=worker_pool)
    for name, text in [
        ("Reglamento de vacaciones", "# Vacaciones\n\nCada colaborador tiene 15 dias habiles de vacaciones al año."),
        ("Politica de viaticos", "# Viaticos\n\nLos viaticos nacionales son de 180000 pesos por dia de viaje."),
        ("Politica de pagos", "# Pagos\n\nEl plazo de pago a proveedores es de 30 dias calendario."),
    ]:
        _, _, msg = t.add_document(s3, f"{name}.md", text.encode(), "text/markdown", title=name)
        assert pipeline.handle(msg) == "indexed"
    return t


Q = "¿Cuántos días de vacaciones hay, cuánto son los viáticos por día de viaje y cuál es el plazo de pago a proveedores?"


def _markers(text: str) -> list[int]:
    import re

    return [int(n) for n in re.findall(r"\[(\d+)\]", text)]


def test_chat_answer_numbers_sources_in_reading_order(firm, app_pool, env):
    env(AI_GENERATION_MODEL=CLOUD_MODEL)
    rag = QueryOrchestrator(gateway=AIGateway(ModelRegistry(), {"meta": Backwards()}), pool=app_pool)
    r = rag.run(firm.claims(), Q)
    assert not r.abstained, r.answer
    seen = list(dict.fromkeys(_markers(r.answer)))
    assert len(seen) >= 2, r.answer
    assert seen == list(range(1, len(seen) + 1)), r.answer
    assert [c["n"] for c in r.citations] == list(range(1, len(r.citations) + 1))
    # Cada marca sigue apuntando a la fuente cuyo texto está a su lado.
    by_n = {c["n"]: c["title"] for c in r.citations}
    topic = {"vacaciones": "vacaciones", "viaticos": "viaticos", "proveedores": "pagos"}
    for sentence in r.answer.split("]."):
        word = next((w for w in topic if w in sentence.lower()), None)
        if word is None:
            continue
        n = _markers(sentence + "]")[-1]
        assert topic[word] in by_n[n].lower(), (n, sentence, by_n[n])
    # Lo guardado (y lo que devuelve /query-runs/:trace) usa los mismos números.
    with tenant_tx(SecurityContext(firm.org, firm.user, firm.principals), app_pool) as conn:
        stored = fetch_all(conn, "SELECT ordinal, document_id::text AS doc FROM citations WHERE query_run_id=%s "
                                 "ORDER BY ordinal", (r.trace_id,))
    assert [(s["ordinal"], s["doc"]) for s in stored] == [(c["n"], c["document_id"]) for c in r.citations]
