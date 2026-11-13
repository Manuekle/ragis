"""ModelRegistry: catálogo versionado de modelos admitidos.

Los precios NO se inventan: `price_*` queda en 0 hasta cargarse desde AWS Pricing /
contrato vía la variable RAGSIS_MODEL_PRICES (JSON {model_id: {"in": x, "out": y}} por 1M tokens).
La disponibilidad regional de Bedrock cambia: verificar antes de habilitar cada modelo.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, replace

from .types import DataClass, ModelKind

CLOUD = "cloud"
LOCAL_NETWORK = "local"


@dataclass(frozen=True)
class ModelSpec:
    model_id: str                     # id interno versionado (estable en BD/índices)
    kind: ModelKind
    provider: str                     # local | bedrock | bedrock-anthropic | ollama | meta
    provider_model_id: str
    locality: str                     # cloud | local
    dimensions: int | None = None     # embeddings
    context_tokens: int = 8000
    regions: tuple[str, ...] = ()
    price_in_per_mtok: float = 0.0
    price_out_per_mtok: float = 0.0
    abstain_similarity: float = 0.0   # umbral mínimo de similitud para evidencia (embeddings)
    vision: bool = False              # acepta imágenes de entrada (descripción de figuras / VLM-enhanced)
    trains_on_data: bool = False      # el proveedor puede entrenar con el contenido enviado (p. ej. Muse Contributor)
    notes: str = ""

    @property
    def offline_capable(self) -> bool:
        return self.locality == LOCAL_NETWORK


_US = ("us-east-1", "us-west-2")

DEFAULT_MODELS: tuple[ModelSpec, ...] = (
    # --- Locales deterministas (dev, tests, on-prem sin GPU) ---
    ModelSpec("local-hash-1024@v1", ModelKind.EMBED, "local", "hash-1024", LOCAL_NETWORK,
              dimensions=1024, abstain_similarity=0.45,
              notes="Feature hashing lexical; baseline offline, no semántico."),
    ModelSpec("local-extractive@v1", ModelKind.GENERATE, "local", "extractive", LOCAL_NETWORK,
              context_tokens=32000, notes="Respuesta extractiva con citas; sin LLM."),
    ModelSpec("local-hash-1024@v2", ModelKind.EMBED, "local", "hash-1024-v2", LOCAL_NETWORK,
              dimensions=1024, abstain_similarity=0.45,
              notes="Variante con otra semilla: ejercita migraciones/dual-write de embeddings sin red."),
    ModelSpec("local-lexical-rerank@v1", ModelKind.RERANK, "local", "lexical", LOCAL_NETWORK),
    ModelSpec("local-graph-heuristic@v1", ModelKind.GENERATE, "local", "graph-heuristic", LOCAL_NETWORK,
              context_tokens=32000, notes="Extracción de grafo heurística (nombres propios y siglas); sin LLM."),
    # --- Ollama / vLLM privado ---
    ModelSpec("ollama-bge-m3@v1", ModelKind.EMBED, "ollama", "bge-m3", LOCAL_NETWORK,
              dimensions=1024, abstain_similarity=0.35),
    ModelSpec("ollama-qwen3-8b@v1", ModelKind.GENERATE, "ollama", "qwen3:8b", LOCAL_NETWORK, context_tokens=32000),
    ModelSpec("ollama-qwen3-14b@v1", ModelKind.GENERATE, "ollama", "qwen3:14b", LOCAL_NETWORK, context_tokens=32000),
    ModelSpec("ollama-qwen3-vl-8b@v1", ModelKind.VISION, "ollama", "qwen3-vl:8b", LOCAL_NETWORK,
              context_tokens=32000, vision=True, notes="VLM local: figuras de tenants restringidos/on-prem."),
    ModelSpec("ollama-qwen2.5vl-7b@v1", ModelKind.VISION, "ollama", "qwen2.5vl:7b", LOCAL_NETWORK,
              context_tokens=32000, vision=True),
    # --- Amazon Bedrock ---
    ModelSpec("bedrock-titan-embed-v2-1024@v1", ModelKind.EMBED, "bedrock", "amazon.titan-embed-text-v2:0",
              CLOUD, dimensions=1024, regions=_US, abstain_similarity=0.25),
    ModelSpec("bedrock-cohere-embed-multilingual-v3@v1", ModelKind.EMBED, "bedrock",
              "cohere.embed-multilingual-v3", CLOUD, dimensions=1024, regions=_US, abstain_similarity=0.25),
    ModelSpec("bedrock-nova-micro@v1", ModelKind.GENERATE, "bedrock", "amazon.nova-micro-v1:0", CLOUD,
              context_tokens=128000, regions=_US),
    ModelSpec("bedrock-nova-lite@v1", ModelKind.GENERATE, "bedrock", "amazon.nova-lite-v1:0", CLOUD,
              context_tokens=300000, regions=_US, vision=True),
    ModelSpec("bedrock-claude-sonnet-5-5@v1", ModelKind.GENERATE, "bedrock-anthropic", "anthropic.claude-sonnet-5-5",
              CLOUD, context_tokens=1000000, regions=_US, vision=True),
    ModelSpec("bedrock-claude-opus-5-5@v1", ModelKind.GENERATE, "bedrock-anthropic", "anthropic.claude-opus-5-5",
              CLOUD, context_tokens=1000000, regions=_US, vision=True),
    # --- Meta Model API (externa a AWS; no la cubren los créditos de AWS) ---
    ModelSpec("meta-muse-spark-1.3@v1", ModelKind.GENERATE, "meta", "muse-spark-1.3", CLOUD,
              notes="Muse Spark por Chat Completions (https://api.meta.ai/v1). La evidencia sale a Meta."),
    ModelSpec("meta-muse-spark-1.3-contributor@v1", ModelKind.GENERATE, "meta", "muse-spark-1.3-contributor", CLOUD,
              trains_on_data=True,
              notes="Modo Contributor: precio muy rebajado a cambio de que Meta entrene con el contenido enviado. "
                    "Solo con AI_ALLOW_TRAINING_MODELS=true y nunca con datos confidential/restricted."),
    # Visión de Muse solo para ingesta (describir fotos y figuras). Va aparte de los modelos de generación para que
    # activarla no cambie las respuestas: el modo VLM-enhanced de la consulta mira `vision` del modelo de generación.
    ModelSpec("meta-muse-spark-1.3-vision@v1", ModelKind.VISION, "meta", "muse-spark-1.3", CLOUD, vision=True,
              notes="Muse Spark describe imágenes (image_url con data URL). Las imágenes salen a Meta."),
    ModelSpec("meta-muse-spark-1.3-contributor-vision@v1", ModelKind.VISION, "meta", "muse-spark-1.3-contributor",
              CLOUD, vision=True, trains_on_data=True,
              notes="Visión en modo Contributor: Meta puede entrenar con las imágenes. Solo datos de prueba."),
    ModelSpec("aws-textract@v1", ModelKind.OCR, "textract", "detect-document-text", CLOUD, regions=_US,
              notes="OCR asíncrono sobre el objeto S3; datos salen a un servicio administrado de AWS."),
    ModelSpec("aws-transcribe@v1", ModelKind.TRANSCRIBE, "transcribe", "start-transcription-job", CLOUD, regions=_US,
              notes="Voz a texto asíncrono sobre el objeto S3; el audio sale a un servicio administrado de AWS."),
    ModelSpec("bedrock-cohere-rerank-3-5@v1", ModelKind.RERANK, "bedrock", "cohere.rerank-v3-5:0", CLOUD,
              regions=("us-west-2",), notes="Verificar región de rerank."),
)

# Cadenas de fallback: solo entre modelos equivalentes; la política filtra cada paso.
DEFAULT_FALLBACKS: dict[str, tuple[str, ...]] = {
    "bedrock-claude-opus-5-5@v1": ("bedrock-claude-sonnet-5-5@v1", "bedrock-nova-lite@v1"),
    "bedrock-claude-sonnet-5-5@v1": ("bedrock-nova-lite@v1",),
    "bedrock-nova-lite@v1": ("bedrock-nova-micro@v1",),
    "ollama-qwen3-14b@v1": ("ollama-qwen3-8b@v1", "local-extractive@v1"),
    "ollama-qwen3-8b@v1": ("local-extractive@v1",),
    # Sin Ollama en la cadena: quien elige Muse no quiere cargar la GPU local.
    "meta-muse-spark-1.3@v1": ("local-extractive@v1",),
    # Sin pasar a Standard: cambiaría el coste sin aviso.
    "meta-muse-spark-1.3-contributor@v1": ("local-extractive@v1",),
    "bedrock-cohere-rerank-3-5@v1": ("local-lexical-rerank@v1",),
    "ollama-qwen3-vl-8b@v1": ("ollama-qwen2.5vl-7b@v1",),
    # Embeddings NO tienen fallback: mezclar espacios vectoriales rompe el índice.
}


class UnknownModelError(KeyError):
    pass


class ModelRegistry:
    def __init__(self, models: tuple[ModelSpec, ...] = DEFAULT_MODELS,
                 fallbacks: dict[str, tuple[str, ...]] | None = None) -> None:
        prices = json.loads(os.environ.get("RAGSIS_MODEL_PRICES", "{}") or "{}")
        self._models: dict[str, ModelSpec] = {}
        for m in models:
            p = prices.get(m.model_id)
            if p:
                m = replace(m, price_in_per_mtok=float(p.get("in", 0)), price_out_per_mtok=float(p.get("out", 0)))
            self._models[m.model_id] = m
        self._fallbacks = dict(DEFAULT_FALLBACKS if fallbacks is None else fallbacks)

    def get(self, model_id: str) -> ModelSpec:
        try:
            return self._models[model_id]
        except KeyError as exc:
            raise UnknownModelError(model_id) from exc

    def all(self, kind: ModelKind | None = None) -> list[ModelSpec]:
        return [m for m in self._models.values() if kind is None or m.kind == kind]

    def fallback_chain(self, model_id: str) -> list[ModelSpec]:
        return [self.get(model_id)] + [self.get(m) for m in self._fallbacks.get(model_id, ())]

    def estimate_cost(self, model_id: str, input_tokens: int, output_tokens: int) -> float:
        m = self.get(model_id)
        return (input_tokens * m.price_in_per_mtok + output_tokens * m.price_out_per_mtok) / 1_000_000


__all__ = ["ModelSpec", "ModelRegistry", "UnknownModelError", "DataClass", "CLOUD", "LOCAL_NETWORK"]
