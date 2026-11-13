"""AI Gateway: selección por política, fallback acotado, presupuestos y contabilidad de tokens."""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from dataclasses import dataclass, replace

from ragsis_core.logging import log
from ragsis_core.settings import get_settings

from .policy import PolicyViolation, is_allowed, require_allowed
from .providers.base import Provider, ProviderError
from .registry import ModelRegistry, ModelSpec
from .types import (
    EmbeddingResult,
    GenerationRequest,
    GenerationResult,
    ModelKind,
    RerankResult,
    TenantAIPolicy,
)

logger = logging.getLogger("ragsis.ai")


class BudgetExceeded(Exception):
    pass


class VisionDisabled(Exception):
    """No hay modelo de visión configurado (AI_VISION_MODEL vacío)."""


@dataclass
class CallRecord:
    kind: str
    model_id: str
    input_tokens: int
    output_tokens: int
    latency_ms: int
    fallback_from: str | None = None


class AIGateway:
    def __init__(self, registry: ModelRegistry | None = None,
                 providers: dict[str, Provider] | None = None) -> None:
        self.registry = registry or ModelRegistry()
        self._providers: dict[str, Provider] = providers or {}
        self.calls: list[CallRecord] = []

    # -- proveedores perezosos (no importar boto3/anthropic si no se usan) --
    def provider(self, name: str) -> Provider:
        if name not in self._providers:
            if name == "local":
                from .providers.local import LocalProvider
                self._providers[name] = LocalProvider()
            elif name == "bedrock":
                from .providers.bedrock import BedrockProvider
                self._providers[name] = BedrockProvider()
            elif name == "bedrock-anthropic":
                from .providers.bedrock import BedrockAnthropicProvider
                self._providers[name] = BedrockAnthropicProvider()
            elif name == "ollama":
                from .providers.ollama import OllamaProvider
                self._providers[name] = OllamaProvider()
            elif name == "meta":
                from .providers.meta import MetaModelProvider
                self._providers[name] = MetaModelProvider()
            else:
                raise ProviderError(f"proveedor desconocido {name}")
        return self._providers[name]

    def embedding_model(self) -> ModelSpec:
        m = self.registry.get(get_settings().ai_embedding_model)
        if m.kind != ModelKind.EMBED or m.dimensions != 1024:
            raise ValueError("el modelo de embeddings activo debe producir 1024 dimensiones")
        return m

    # ------------------------------------------------------------------
    def embed(self, texts: list[str], policy: TenantAIPolicy, input_type: str = "document",
              model_id: str | None = None) -> EmbeddingResult:
        """Sin fallback: el modelo define el espacio vectorial del índice."""
        model = self.registry.get(model_id) if model_id else self.embedding_model()
        require_allowed(model, policy)
        t0 = time.perf_counter()
        vectors, tokens = self.provider(model.provider).embed(model, texts, input_type)
        for v in vectors:
            if len(v) != model.dimensions:
                raise ProviderError(f"dimensión inesperada {len(v)} != {model.dimensions}")
        self.calls.append(CallRecord("embed", model.model_id, tokens, 0, int((time.perf_counter() - t0) * 1000)))
        return EmbeddingResult(vectors, model.model_id, tokens)

    def generate(self, request: GenerationRequest, policy: TenantAIPolicy,
                 model_id: str | None = None) -> GenerationResult:
        if request.max_output_tokens > policy.max_output_tokens:
            raise BudgetExceeded("max_output_tokens excede el presupuesto del plan")
        primary = model_id or get_settings().ai_generation_model
        # Un fallback sin visión recibe solo el texto (las descripciones de figuras siguen en la evidencia).
        return self._with_fallback(primary, policy, ModelKind.GENERATE,
                                   lambda m: self.provider(m.provider).generate(
                                       m, request if m.vision else replace(request, images=())))

    def vision_model(self, model_id: str | None = None) -> ModelSpec | None:
        primary = model_id or get_settings().ai_vision_model
        if not primary:
            return None
        m = self.registry.get(primary)
        if not m.vision:
            raise ValueError(f"{primary} no acepta imágenes")
        return m

    def describe(self, request: GenerationRequest, policy: TenantAIPolicy,
                 model_id: str | None = None) -> GenerationResult:
        """Llamada a un VLM (descripción de figuras en ingesta). La cadena solo admite modelos con visión
        y la política del tenant filtra cada paso: un tenant restringido nunca envía imágenes a la nube."""
        model = self.vision_model(model_id)
        if model is None:
            raise VisionDisabled("AI_VISION_MODEL no configurado")
        if not request.images:
            raise ValueError("describe() requiere al menos una imagen")
        if request.max_output_tokens > policy.max_output_tokens:
            raise BudgetExceeded("max_output_tokens excede el presupuesto del plan")
        return self._with_fallback(model.model_id, policy, None,
                                   lambda m: self.provider(m.provider).generate(m, request),
                                   require=lambda m: m.vision, record_kind="vision")

    def rerank(self, query: str, documents: list[str], policy: TenantAIPolicy,
               model_id: str | None = None) -> RerankResult:
        primary = model_id or get_settings().ai_rerank_model
        holder: dict = {}

        def call(m: ModelSpec):
            scores = self.provider(m.provider).rerank(m, query, documents)
            holder["model"] = m.model_id
            return scores

        scores = self._with_fallback(primary, policy, ModelKind.RERANK, call)
        return RerankResult(scores, holder["model"])

    def _with_fallback(self, primary: str, policy: TenantAIPolicy, kind: ModelKind | None, fn,
                       require: Callable[[ModelSpec], bool] | None = None, record_kind: str | None = None):
        chain = self.registry.fallback_chain(primary)
        if kind is not None and chain[0].kind != kind:
            raise ValueError(f"{primary} no es un modelo {kind}")
        last_error: Exception | None = None
        tried_allowed = False
        for i, model in enumerate(chain):
            if require is not None and not require(model):
                continue
            ok, reason = is_allowed(model, policy)
            if not ok:
                log(logger, logging.INFO, "modelo descartado por política", model=model.model_id, reason=reason)
                continue
            tried_allowed = True
            t0 = time.perf_counter()
            try:
                result = fn(model)
            except ProviderError as exc:
                last_error = exc
                log(logger, logging.WARNING, "fallo de proveedor; evaluando fallback permitido",
                    model=model.model_id, error=type(exc).__name__)
                continue
            latency = int((time.perf_counter() - t0) * 1000)
            if isinstance(result, GenerationResult):
                self.calls.append(CallRecord(record_kind or "generate", model.model_id, result.input_tokens,
                                             result.output_tokens, latency, chain[0].model_id if i else None))
            else:
                self.calls.append(CallRecord(record_kind or (kind.value if kind else "call"), model.model_id, 0, 0,
                                             latency, chain[0].model_id if i else None))
            return result
        if not tried_allowed:
            raise PolicyViolation(f"ningún modelo de la cadena {primary} está permitido para el tenant")
        raise ProviderError(f"cadena de modelos agotada para {primary}: {last_error}")

    def healthcheck(self) -> dict[str, bool]:
        names = {m.provider for m in self.registry.all()}
        out = {}
        for n in sorted(names):
            try:
                out[n] = self.provider(n).healthcheck()
            except Exception:  # noqa: BLE001
                out[n] = False
        return out
