"""«Solo IA privada»: con `llm_policy=local_only` (o el despliegue «En tus servidores») nada sale a un modelo en la nube.

El onboarding promete «Tus documentos nunca se envían a un servicio de IA externo», pero solo los agentes lo
respetaban: Preguntar y la ingesta usaban el modelo configurado (p. ej. Muse Contributor, que entrena con lo enviado).
"""

import uuid
from dataclasses import replace

import pytest
from ragsis_ai.gateway import AIGateway
from ragsis_ai.policy import is_allowed
from ragsis_ai.registry import CLOUD, ModelRegistry
from ragsis_ai.types import Evidence, GenerationRequest, TenantAIPolicy
from ragsis_core.db import SecurityContext, fetch_one, tenant_tx
from ragsis_core.internal_auth import issue_internal_token, verify_internal_token
from ragsis_core.settings import get_settings
from ragsis_ingest.pipeline import _VERSION_SQL, IngestPipeline
from ragsis_rag.orchestrator import QueryOrchestrator

MUSE = "meta-muse-spark-1.3-contributor@v1"


class CloudTripwire:
    """Proveedor en la nube que no debe recibir nada: si lo llaman, la evidencia habría salido de la organización."""

    name = "tripwire"

    def __init__(self) -> None:
        self.calls = 0

    def generate(self, model, request):
        self.calls += 1
        raise AssertionError(f"se envió contenido a {model.model_id}")

    def embed(self, model, texts, input_type):
        self.calls += 1
        raise AssertionError(f"se enviaron textos a {model.model_id}")

    def rerank(self, model, query, documents):
        self.calls += 1
        raise AssertionError(f"se enviaron fragmentos a {model.model_id}")


@pytest.fixture
def env(monkeypatch):
    def _set(**kw):
        for k, v in kw.items():
            monkeypatch.setenv(k, v)
        get_settings.cache_clear()
    yield _set
    get_settings.cache_clear()


def _gateway(tripwire: CloudTripwire) -> AIGateway:
    return AIGateway(ModelRegistry(), {"meta": tripwire, "bedrock": tripwire})


def test_private_ai_policy_allows_only_local_models(env):
    env(AI_ALLOW_TRAINING_MODELS="true")
    policy = TenantAIPolicy(local_only=True)
    for model in ModelRegistry().all():
        assert is_allowed(model, policy)[0] is (model.locality != CLOUD), model.model_id


def test_generation_falls_back_to_private_ai_without_calling_the_cloud(env):
    env(AI_GENERATION_MODEL=MUSE, AI_ALLOW_TRAINING_MODELS="true")
    tripwire = CloudTripwire()
    req = GenerationRequest("sistema", "prompt", "¿Cuál es el plazo?",
                            (Evidence(1, "El plazo de pago es de 30 días.", "Política"),))
    res = _gateway(tripwire).generate(req, TenantAIPolicy(local_only=True))
    assert res.model_id == "local-extractive@v1" and tripwire.calls == 0
    # Sin «Solo IA privada» la misma configuración sí manda la evidencia a Muse (la trampa salta).
    with pytest.raises(AssertionError):
        _gateway(tripwire).generate(req, TenantAIPolicy())


@pytest.mark.parametrize("question,lead", [
    ("¿Cuál es el plazo de pago a proveedores?", "Según los documentos: "),
    ("cual es el plazo de pago de la empresa", "Según los documentos: "),
    ("What is the supplier payment term?", "According to the documents: "),
])
def test_private_ai_answers_in_the_language_of_the_question(question, lead):
    # Antes el motor local anteponía «According to the documents:» también a las preguntas en español.
    req = GenerationRequest("sistema", "prompt", question,
                            (Evidence(1, "El plazo de pago a proveedores es de 30 días calendario.", "Política"),
                             Evidence(2, "The supplier payment term is 30 calendar days.", "Policy")))
    res = AIGateway().generate(req, TenantAIPolicy(local_only=True), model_id="local-extractive@v1")
    assert res.text.startswith(lead), res.text


def test_internal_token_carries_private_ai(make_tenant, owner):
    claims = make_tenant("token").claims()
    assert verify_internal_token(issue_internal_token(claims)).local_only is False
    assert verify_internal_token(issue_internal_token(replace(claims, local_only=True))).local_only is True


def test_ask_answers_with_private_ai_when_the_token_says_so(make_tenant, s3, worker_pool, app_pool, env):
    env(AI_GENERATION_MODEL=MUSE, AI_ALLOW_TRAINING_MODELS="true")
    t = make_tenant("privada")
    _, _, msg = t.add_document(s3, "plazos.md", b"# Plazos\n\nEl plazo de pago a proveedores es de 30 dias calendario.",
                               "text/markdown", title="Plazos")
    assert IngestPipeline(pool=worker_pool).handle(msg) == "indexed"
    tripwire = CloudTripwire()
    rag = QueryOrchestrator(gateway=_gateway(tripwire), pool=app_pool)

    r = rag.run(replace(t.claims(), local_only=True), "¿Cuál es el plazo de pago a proveedores?")
    assert not r.abstained and "30" in r.answer
    assert r.generation_model == "local-extractive@v1" and tripwire.calls == 0


def _profile(owner, org, **cols) -> None:
    names = ", ".join(cols)
    marks = ", ".join(["%s"] * len(cols))
    owner.execute(f"INSERT INTO organization_profiles (organization_id, {names}) VALUES (%s, {marks}) "
                  f"ON CONFLICT (organization_id) DO UPDATE SET ({names}) = ROW({marks})",
                  (org, *cols.values(), *cols.values()))


@pytest.mark.parametrize("cols,expected", [
    ({"llm_policy": "local_only"}, True),
    ({"llm_policy": "cloud_allowed", "deployment_preference": "on_prem"}, True),
    ({"llm_policy": "cloud_allowed", "deployment_preference": "private_cloud"}, False),
    ({"llm_policy": "ask"}, False),
    ({}, False),
])
def test_the_ingest_worker_reads_the_onboarding_choice(make_tenant, owner, s3, worker_pool, cols, expected):
    t = make_tenant("ingesta")
    other = make_tenant("vecina")
    if cols:
        _profile(owner, t.org, **cols)
    _profile(owner, other.org, llm_policy="local_only")
    doc, ver, _ = t.add_document(s3, "a.md", b"# A\n\nTexto.", "text/markdown", title="A")
    with tenant_tx(SecurityContext(t.org, None, ()), worker_pool) as conn:
        row = fetch_one(conn, _VERSION_SQL, (ver, doc))
        # La función solo lee la organización del contexto: la de la vecina no se cuela.
        assert fetch_one(conn, "SELECT app.ai_local_only() AS lo")["lo"] is expected
    assert IngestPipeline._policy(row).local_only is expected


def test_private_ai_rule_never_reads_another_organization(make_tenant, owner, app_pool):
    a, b = make_tenant("a"), make_tenant("b")
    _profile(owner, a.org, llm_policy="local_only")
    with tenant_tx(SecurityContext(b.org, b.user, b.principals), app_pool) as conn:
        assert fetch_one(conn, "SELECT app.ai_local_only() AS lo")["lo"] is False
    with tenant_tx(SecurityContext(uuid.uuid4(), None, ()), app_pool) as conn:
        assert fetch_one(conn, "SELECT app.ai_local_only() AS lo")["lo"] is False
