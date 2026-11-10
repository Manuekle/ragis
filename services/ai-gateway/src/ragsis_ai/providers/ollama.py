"""Ollama (o servidor compatible en red privada) para tenants restringidos / on-premise."""

from __future__ import annotations

import base64

import httpx
from ragsis_core.settings import get_settings
from ragsis_core.text import estimate_tokens

from ..registry import ModelSpec
from ..types import GenerationRequest, GenerationResult
from .base import ProviderError


class OllamaProvider:
    name = "ollama"

    def __init__(self, base_url: str | None = None, timeout: float = 120.0) -> None:
        self.base_url = (base_url or get_settings().ollama_base_url).rstrip("/")
        self._http = httpx.Client(timeout=timeout)

    def generate(self, model: ModelSpec, request: GenerationRequest) -> GenerationResult:
        try:
            r = self._http.post(f"{self.base_url}/api/chat", json={
                "model": model.provider_model_id,
                "stream": False,
                "messages": [{"role": "system", "content": request.system}, self._user_message(model, request)],
                "options": {"num_predict": request.max_output_tokens},
            })
            r.raise_for_status()
        except httpx.HTTPError as exc:
            raise ProviderError(f"ollama chat: {exc}") from exc
        data = r.json()
        text = data.get("message", {}).get("content", "")
        return GenerationResult(text, model.model_id, int(data.get("prompt_eval_count", estimate_tokens(request.prompt))),
                                int(data.get("eval_count", estimate_tokens(text))))

    @staticmethod
    def _user_message(model: ModelSpec, request: GenerationRequest) -> dict:
        if not (model.vision and request.images):
            return {"role": "user", "content": request.prompt}
        # La API de Ollama adjunta imágenes al mensaje sin intercalar texto: el orden se declara en el texto.
        order = "\n".join(f"Imagen {i}: {img.label}" for i, img in enumerate(request.images, start=1) if img.label)
        content = f"{order}\n\n{request.prompt}" if order else request.prompt
        return {"role": "user", "content": content,
                "images": [base64.b64encode(img.data).decode("ascii") for img in request.images]}

    def embed(self, model: ModelSpec, texts: list[str], input_type: str) -> tuple[list[list[float]], int]:
        try:
            r = self._http.post(f"{self.base_url}/api/embed", json={"model": model.provider_model_id, "input": texts})
            r.raise_for_status()
        except httpx.HTTPError as exc:
            raise ProviderError(f"ollama embed: {exc}") from exc
        return r.json()["embeddings"], sum(estimate_tokens(t) for t in texts)

    def rerank(self, model, query, documents):  # pragma: no cover
        raise ProviderError("rerank no soportado en Ollama")

    def tokenize(self, text: str) -> int:
        return estimate_tokens(text)

    def healthcheck(self) -> bool:
        try:
            return self._http.get(f"{self.base_url}/api/tags", timeout=3).status_code == 200
        except httpx.HTTPError:
            return False
