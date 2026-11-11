"""Saludos y cortesías: respuesta fija sin recuperar ni llamar al modelo; las preguntas reales no se tocan."""

import pytest
from ragsis_ingest.pipeline import IngestPipeline
from ragsis_rag.orchestrator import QueryOrchestrator
from ragsis_rag.smalltalk import MESSAGES, detect

POLICY = """# Política de viáticos ACME

## Montos
El monto máximo de viáticos nacionales es de 180000 pesos por día.
"""


@pytest.mark.parametrize("text,expected", [
    ("hola", ("greeting", "es")),
    ("Hola!", ("greeting", "es")),
    ("hola equipo", ("greeting", "es")),
    ("buenos días", ("greeting", "es")),
    ("Hola, ¿qué puedes hacer?", ("help", "es")),
    ("ayuda", ("help", "es")),
    ("Muchas gracias!", ("thanks", "es")),
    ("adiós", ("bye", "es")),
    ("hello", ("greeting", "en")),
    ("What can you do?", ("help", "en")),
    ("thank you", ("thanks", "en")),
])
def test_detects_small_talk(text, expected):
    found = detect(text)
    assert found is not None and (found.kind, found.lang) == expected
    assert found.message == MESSAGES[expected]


@pytest.mark.parametrize("text", [
    "",
    "días",
    "viáticos",
    "¿Cuántos días de vacaciones tiene cada colaborador?",
    "hola, ¿cuál es el plazo de pago a proveedores?",
    "gracias por el reporte de ventas del trimestre pasado",
    "ayuda con el reglamento de trabajo",
    "hi, what is the per diem limit?",
])
def test_real_questions_are_not_small_talk(text):
    assert detect(text) is None


def test_small_talk_skips_retrieval_and_quota(make_tenant, s3, worker_pool, app_pool, owner):
    tenant = make_tenant("acme")
    _, _, msg = tenant.add_document(s3, "viaticos.md", POLICY.encode(), "text/markdown", title="Política de viáticos")
    assert IngestPipeline(pool=worker_pool).handle(msg) == "indexed"
    rag = QueryOrchestrator(pool=app_pool)

    res = rag.run(tenant.claims(), "hola")
    assert res.abstained and res.abstain_reason == "smalltalk"
    assert res.answer == MESSAGES[("greeting", "es")]
    assert res.citations == [] and res.generation_model is None
    assert res.usage["llm_input_tokens"] == 0 and rag.gateway.calls == []   # ni embeddings ni modelo

    run = owner.execute("SELECT abstained, abstain_reason, question_class, strategy FROM query_runs WHERE id=%s",
                        (res.trace_id,)).fetchone()
    assert run["abstained"] and run["abstain_reason"] == "smalltalk"
    assert run["question_class"] == "smalltalk" and run["strategy"] == "smalltalk"
    # No consume la cuota mensual de consultas.
    n = owner.execute("SELECT count(*) AS n FROM usage_events WHERE organization_id=%s AND kind='query' AND ref=%s",
                      (tenant.org, res.trace_id)).fetchone()["n"]
    assert n == 0

    # La pregunta real, dicha tras un saludo, sigue el camino normal.
    real = rag.run(tenant.claims(), "hola, ¿cuál es el monto máximo de viáticos nacionales por día?")
    assert not real.abstained and "180000" in real.answer and real.citations
