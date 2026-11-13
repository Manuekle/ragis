"""Proveedores HTTP del AI gateway: Meta Model API (Muse) y Ollama, sin red (httpx.MockTransport)."""

import json

import httpx
import pytest
from ragsis_ai.gateway import AIGateway
from ragsis_ai.policy import is_allowed
from ragsis_ai.providers.base import ProviderError
from ragsis_ai.providers.meta import MetaModelProvider
from ragsis_ai.providers.ollama import OllamaProvider
from ragsis_ai.registry import ModelRegistry
from ragsis_ai.types import DataClass, Evidence, GenerationRequest, ImageInput, TenantAIPolicy

REG = ModelRegistry()
MUSE = REG.get("meta-muse-spark-1.3@v1")


def _meta(handler) -> MetaModelProvider:
    return MetaModelProvider(api_key="test-key", base_url="https://api.meta.test/v1",
                             http=httpx.Client(transport=httpx.MockTransport(handler)))


def test_meta_sends_openai_compatible_request_and_parses_usage():
    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["url"] = str(req.url)
        seen["auth"] = req.headers["authorization"]
        seen["body"] = json.loads(req.content)
        return httpx.Response(200, json={"choices": [{"message": {"content": "Respuesta [1]."},
                                                      "finish_reason": "stop"}],
                                         "usage": {"prompt_tokens": 321, "completion_tokens": 12}})

    res = _meta(handler).generate(MUSE, GenerationRequest("reglas", "prompt", "q", max_output_tokens=800))
    assert seen["url"] == "https://api.meta.test/v1/chat/completions"
    assert seen["auth"] == "Bearer test-key"
    body = seen["body"]
    assert body["model"] == "muse-spark-1.3"
    assert [m["role"] for m in body["messages"]] == ["developer", "user"]
    assert body["reasoning_effort"] == "low"
    assert body["max_completion_tokens"] > 800          # margen para el razonamiento
    assert (res.text, res.input_tokens, res.output_tokens) == ("Respuesta [1].", 321, 12)


@pytest.mark.parametrize("response", [
    httpx.Response(200, json={"choices": [{"message": {"content": ""}, "finish_reason": "length"}]}),
    httpx.Response(429, json={"error": {"message": "rate limited"}}),
])
def test_meta_errors_raise_provider_error(response):
    with pytest.raises(ProviderError):
        _meta(lambda _req: response).generate(MUSE, GenerationRequest("s", "p", "q"))


def test_meta_without_key_fails_and_falls_back_to_local_not_ollama():
    gw = AIGateway(providers={"meta": MetaModelProvider(api_key="")})
    ev = (Evidence(1, "El plazo de pago a proveedores es de 30 días.", "Política"),)
    res = gw.generate(GenerationRequest("s", "p", "¿Cuál es el plazo de pago?", ev), TenantAIPolicy(DataClass.INTERNAL),
                      model_id="meta-muse-spark-1.3@v1")
    assert res.model_id == "local-extractive@v1"


def test_meta_is_a_cloud_model_for_the_policy():
    assert not is_allowed(MUSE, TenantAIPolicy(DataClass.RESTRICTED))[0]
    assert not is_allowed(MUSE, TenantAIPolicy(DataClass.CONFIDENTIAL))[0]
    assert is_allowed(MUSE, TenantAIPolicy(DataClass.CONFIDENTIAL, ("meta-muse-spark-1.3@v1",)))[0]

    class _MustNotCall:
        def generate(self, model, request):
            raise AssertionError("un tenant restringido no puede llamar a la API de Meta")

    # Restringido: la cadena salta Muse y responde el extractivo local; Meta nunca recibe la evidencia.
    ev = (Evidence(1, "El plazo de pago a proveedores es de 30 días.", "Política"),)
    res = AIGateway(providers={"meta": _MustNotCall()}).generate(
        GenerationRequest("s", "p", "¿Cuál es el plazo de pago?", ev), TenantAIPolicy(DataClass.RESTRICTED),
        model_id="meta-muse-spark-1.3@v1")
    assert res.model_id == "local-extractive@v1"


def test_ollama_requests_a_context_window_larger_than_its_default():
    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["body"] = json.loads(req.content)
        return httpx.Response(200, json={"message": {"content": "ok [1]"}, "prompt_eval_count": 5000, "eval_count": 3})

    p = OllamaProvider(base_url="http://ollama.test", num_ctx=8192)
    p._http = httpx.Client(transport=httpx.MockTransport(handler))
    p.generate(REG.get("ollama-qwen3-8b@v1"), GenerationRequest("s", "p", "q"))
    assert seen["body"]["options"]["num_ctx"] == 8192


def test_contributor_mode_needs_deployment_opt_in_and_never_takes_confidential(monkeypatch):
    from ragsis_core.settings import get_settings
    contributor = REG.get("meta-muse-spark-1.3-contributor@v1")
    assert contributor.provider_model_id == "muse-spark-1.3-contributor" and contributor.trains_on_data
    monkeypatch.setattr(get_settings(), "ai_allow_training_models", False)
    assert not is_allowed(contributor, TenantAIPolicy(DataClass.INTERNAL))[0]
    monkeypatch.setattr(get_settings(), "ai_allow_training_models", True)
    assert is_allowed(contributor, TenantAIPolicy(DataClass.INTERNAL))[0]
    allow = ("meta-muse-spark-1.3-contributor@v1",)
    assert not is_allowed(contributor, TenantAIPolicy(DataClass.CONFIDENTIAL, allow))[0]
    assert not is_allowed(contributor, TenantAIPolicy(DataClass.RESTRICTED, allow))[0]


def test_meta_vision_sends_images_as_data_urls_and_text_models_never_do():
    bodies = []

    def handler(req: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(req.content))
        return httpx.Response(200, json={"choices": [{"message": {"content": "Una foto de un auto."}}]})

    img = ImageInput(b"\x89PNG fake", "image/png", "Figura 1")
    req = GenerationRequest("reglas", "Describe la figura", "", (), 600, (img,))
    vision = REG.get("meta-muse-spark-1.3-contributor-vision@v1")
    assert vision.vision and vision.trains_on_data and vision.provider_model_id == "muse-spark-1.3-contributor"
    _meta(handler).generate(vision, req)
    parts = bodies[0]["messages"][1]["content"]
    assert parts[0] == {"type": "text", "text": "Describe la figura"}
    assert parts[1] == {"type": "text", "text": "Figura 1"}
    assert parts[2]["type"] == "image_url"
    assert parts[2]["image_url"]["url"].startswith("data:image/png;base64,")

    # The generation models stay text-only, so turning vision on never changes how answers are built.
    assert not MUSE.vision
    _meta(handler).generate(MUSE, req)
    assert bodies[1]["messages"][1]["content"] == "Describe la figura"
