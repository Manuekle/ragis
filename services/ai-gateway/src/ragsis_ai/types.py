from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum


class ModelKind(StrEnum):
    EMBED = "embed"
    GENERATE = "generate"
    RERANK = "rerank"
    VISION = "vision"
    OCR = "ocr"
    TRANSCRIBE = "transcribe"


class DataClass(StrEnum):
    PUBLIC = "public"
    INTERNAL = "internal"
    CONFIDENTIAL = "confidential"
    RESTRICTED = "restricted"


@dataclass(frozen=True)
class Evidence:
    """Fragmento autorizado entregado al generador. `n` es el índice citable [n]."""

    n: int
    text: str
    title: str = ""
    page: int | None = None


IMAGE_MIMES = ("image/png", "image/jpeg", "image/gif", "image/webp")


@dataclass(frozen=True)
class ImageInput:
    """Imagen entregada a un modelo con visión. `label` se envía como texto justo antes de la imagen
    (p. ej. "Imagen de la evidencia [3]") para que el modelo la asocie a su cita."""

    data: bytes
    mime: str
    label: str = ""

    def __post_init__(self) -> None:
        if self.mime not in IMAGE_MIMES:
            raise ValueError(f"tipo de imagen no admitido por los VLM: {self.mime}")


@dataclass(frozen=True)
class GenerationRequest:
    system: str
    prompt: str                      # prompt renderizado (proveedores LLM)
    question: str                    # pregunta original (generador extractivo local)
    evidence: tuple[Evidence, ...] = ()
    max_output_tokens: int = 800
    images: tuple[ImageInput, ...] = ()   # solo se envían a modelos con `vision=True`
    # RAG-05: nombres de entidades puente (grafo, solo de fuentes visibles para el usuario). Solo los usa el
    # generador extractivo local para elegir oraciones del segundo salto; no entran al prompt de un LLM.
    hints: tuple[str, ...] = ()


@dataclass(frozen=True)
class GenerationResult:
    text: str
    model_id: str
    input_tokens: int
    output_tokens: int
    stop_reason: str = "end_turn"


@dataclass(frozen=True)
class EmbeddingResult:
    vectors: list[list[float]]
    model_id: str
    input_tokens: int


@dataclass(frozen=True)
class RerankResult:
    scores: list[float]
    model_id: str


@dataclass(frozen=True)
class TenantAIPolicy:
    """Restricciones de IA del tenant resueltas por el control plane."""

    data_class: DataClass = DataClass.INTERNAL
    model_allowlist: tuple[str, ...] = ()
    approved_regions: tuple[str, ...] = ("us-east-1",)
    max_output_tokens: int = 1200
    extra: dict = field(default_factory=dict)
