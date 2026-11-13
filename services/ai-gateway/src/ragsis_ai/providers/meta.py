"""Meta Model API (Muse Spark y familia) por su endpoint Chat Completions, compatible con OpenAI.

Docs: https://dev.meta.ai/docs/protocols/chat-completions. Es una API externa a AWS: el texto de la evidencia sale a
Meta. La política del gateway la trata como cualquier modelo cloud (bloqueada en `restricted`, allowlist en
`confidential`). Los modelos Muse siempre razonan: `reasoning_effort` no admite "none" y los tokens de razonamiento
consumen el mismo presupuesto que la respuesta, por eso se pide margen sobre `max_output_tokens`.
"""

from __future__ import annotations

import base64

import httpx
from ragsis_core.settings import get_settings
from ragsis_core.text import estimate_tokens

from ..registry import ModelSpec
from ..types import GenerationRequest, GenerationResult
from .base import ProviderError


class MetaModelProvider:
    name = "meta"

    def __init__(self, api_key: str | None = None, base_url: str | None = None,
                 http: httpx.Client | None = None) -> None:
        s = get_settings()
        self.api_key = api_key if api_key is not None else s.meta_model_api_key
        self.base_url = (base_url or s.meta_model_api_base_url).rstrip("/")
        self.reasoning_effort = s.meta_reasoning_effort
        self.reasoning_budget = s.meta_reasoning_budget_tokens
        self._http = http or httpx.Client(timeout=120.0)

    def generate(self, model: ModelSpec, request: GenerationRequest) -> GenerationResult:
        if not self.api_key:
            raise ProviderError("META_MODEL_API_KEY no configurada")
        body = {
            "model": model.provider_model_id,
            # `developer` es el rol de instrucciones con más precedencia; `system` solo existe por compatibilidad.
            "messages": [{"role": "developer", "content": request.system},
                         {"role": "user", "content": self._user_content(model, request)}],
            "max_completion_tokens": request.max_output_tokens + self.reasoning_budget,
            "reasoning_effort": self.reasoning_effort,
        }
        try:
            r = self._http.post(f"{self.base_url}/chat/completions", json=body,
                                headers={"authorization": f"Bearer {self.api_key}"})
        except httpx.HTTPError as exc:
            raise ProviderError(f"meta chat: {exc}") from exc
        if r.status_code >= 400:
            # El cuerpo de error no incluye el prompt; se recorta por si acaso.
            raise ProviderError(f"meta chat: HTTP {r.status_code}: {r.text[:300]}")
        data = r.json()
        choice = (data.get("choices") or [{}])[0]
        text = (choice.get("message") or {}).get("content") or ""
        if not text.strip():
            # Sin texto (p. ej. finish_reason=length porque el razonamiento agotó el presupuesto): el gateway pasa
            # al siguiente modelo de la cadena en vez de devolver una respuesta vacía.
            raise ProviderError(f"meta chat: respuesta vacía (finish_reason={choice.get('finish_reason')})")
        usage = data.get("usage") or {}
        return GenerationResult(text, model.model_id,
                                int(usage.get("prompt_tokens") or estimate_tokens(request.prompt)),
                                int(usage.get("completion_tokens") or estimate_tokens(text)))

    @staticmethod
    def _user_content(model: ModelSpec, request: GenerationRequest) -> str | list[dict]:
        """Texto plano, o partes `text` + `image_url` (data URL base64) si el modelo ve imágenes. Meta solo procesa
        imágenes en mensajes `user` y admite hasta 50 por petición."""
        if not (model.vision and request.images):
            return request.prompt
        parts: list[dict] = [{"type": "text", "text": request.prompt}]
        for img in request.images[:50]:
            if img.label:
                parts.append({"type": "text", "text": img.label})
            data = base64.b64encode(img.data).decode("ascii")
            parts.append({"type": "image_url", "image_url": {"url": f"data:{img.mime};base64,{data}"}})
        return parts

    def embed(self, model: ModelSpec, texts: list[str], input_type: str):  # pragma: no cover
        raise ProviderError("embeddings no soportados en el proveedor meta")

    def rerank(self, model, query, documents):  # pragma: no cover
        raise ProviderError("rerank no soportado en el proveedor meta")

    def tokenize(self, text: str) -> int:
        return estimate_tokens(text)

    def healthcheck(self) -> bool:
        if not self.api_key:
            return False
        try:
            r = self._http.get(f"{self.base_url}/models", headers={"authorization": f"Bearer {self.api_key}"},
                               timeout=5)
            return r.status_code == 200
        except httpx.HTTPError:
            return False
