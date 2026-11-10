from __future__ import annotations

from typing import Protocol

from ..registry import ModelSpec
from ..types import GenerationRequest, GenerationResult


class ProviderError(Exception):
    """Fallo recuperable del proveedor (red, cuota, 5xx): habilita fallback permitido."""


class RefusalError(ProviderError):
    """El modelo declinó responder (stop_reason=refusal)."""


class Provider(Protocol):
    name: str

    def generate(self, model: ModelSpec, request: GenerationRequest) -> GenerationResult: ...

    def embed(self, model: ModelSpec, texts: list[str], input_type: str) -> tuple[list[list[float]], int]: ...

    def rerank(self, model: ModelSpec, query: str, documents: list[str]) -> list[float]: ...

    def tokenize(self, text: str) -> int: ...

    def healthcheck(self) -> bool: ...
