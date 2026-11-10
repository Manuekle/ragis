"""Amazon Bedrock: Converse (Nova), InvokeModel (embeddings) y Rerank; Claude vía Anthropic SDK (Mantle).

Credenciales por rol IAM de la tarea ECS; nunca claves estáticas en la imagen.
"""

from __future__ import annotations

import base64
import json
from functools import cached_property

from botocore.exceptions import BotoCoreError, ClientError
from ragsis_core.settings import get_settings
from ragsis_core.text import estimate_tokens

from ..registry import ModelSpec
from ..types import GenerationRequest, GenerationResult
from .base import ProviderError, RefusalError

_CONVERSE_FORMATS = {"image/png": "png", "image/jpeg": "jpeg", "image/gif": "gif", "image/webp": "webp"}


def converse_content(model: ModelSpec, request: GenerationRequest) -> list[dict]:
    """Bloques de contenido Converse: cada imagen va precedida de su etiqueta y el prompt al final."""
    content: list[dict] = []
    if model.vision:
        for img in request.images:
            if img.label:
                content.append({"text": img.label})
            content.append({"image": {"format": _CONVERSE_FORMATS[img.mime], "source": {"bytes": img.data}}})
    content.append({"text": request.prompt})
    return content


def anthropic_content(model: ModelSpec, request: GenerationRequest) -> str | list[dict]:
    if not (model.vision and request.images):
        return request.prompt
    content: list[dict] = []
    for img in request.images:
        if img.label:
            content.append({"type": "text", "text": img.label})
        content.append({"type": "image", "source": {"type": "base64", "media_type": img.mime,
                                                    "data": base64.b64encode(img.data).decode("ascii")}})
    content.append({"type": "text", "text": request.prompt})
    return content


class BedrockProvider:
    name = "bedrock"

    def __init__(self, region: str | None = None) -> None:
        self.region = region or get_settings().aws_region

    @cached_property
    def _runtime(self):
        import boto3

        return boto3.client("bedrock-runtime", region_name=self.region)

    @cached_property
    def _agent_runtime(self):
        import boto3

        return boto3.client("bedrock-agent-runtime", region_name=self.region)

    def generate(self, model: ModelSpec, request: GenerationRequest) -> GenerationResult:
        try:
            resp = self._runtime.converse(
                modelId=model.provider_model_id,
                system=[{"text": request.system}],
                messages=[{"role": "user", "content": converse_content(model, request)}],
                inferenceConfig={"maxTokens": request.max_output_tokens},
            )
        except (ClientError, BotoCoreError) as exc:
            raise ProviderError(f"bedrock converse: {exc}") from exc
        stop = resp.get("stopReason", "end_turn")
        if stop in ("guardrail_intervened", "content_filtered"):
            raise RefusalError(stop)
        blocks = resp["output"]["message"]["content"]
        text = "".join(b.get("text", "") for b in blocks)
        usage = resp.get("usage", {})
        return GenerationResult(text, model.model_id, int(usage.get("inputTokens", 0)),
                                int(usage.get("outputTokens", 0)), stop)

    def embed(self, model: ModelSpec, texts: list[str], input_type: str) -> tuple[list[list[float]], int]:
        try:
            if model.provider_model_id.startswith("cohere.embed"):
                vectors: list[list[float]] = []
                for i in range(0, len(texts), 96):           # límite de lote de Cohere
                    body = {"texts": texts[i:i + 96], "truncate": "END",
                            "input_type": "search_query" if input_type == "query" else "search_document"}
                    out = json.loads(self._runtime.invoke_model(
                        modelId=model.provider_model_id, body=json.dumps(body))["body"].read())
                    vectors.extend(out["embeddings"])
                return vectors, sum(estimate_tokens(t) for t in texts)
            vectors, tokens = [], 0
            for t in texts:
                body = {"inputText": t, "dimensions": model.dimensions or 1024, "normalize": True}
                out = json.loads(self._runtime.invoke_model(
                    modelId=model.provider_model_id, body=json.dumps(body))["body"].read())
                vectors.append(out["embedding"])
                tokens += int(out.get("inputTextTokenCount", estimate_tokens(t)))
            return vectors, tokens
        except (ClientError, BotoCoreError) as exc:
            raise ProviderError(f"bedrock embed: {exc}") from exc

    def rerank(self, model: ModelSpec, query: str, documents: list[str]) -> list[float]:
        region = model.regions[0] if model.regions else self.region
        try:
            resp = self._agent_runtime.rerank(
                queries=[{"type": "TEXT", "textQuery": {"text": query}}],
                sources=[{"type": "INLINE", "inlineDocumentSource": {"type": "TEXT", "textDocument": {"text": d}}}
                         for d in documents],
                rerankingConfiguration={
                    "type": "BEDROCK_RERANKING_MODEL",
                    "bedrockRerankingConfiguration": {
                        "numberOfResults": len(documents),
                        "modelConfiguration": {
                            "modelArn": f"arn:aws:bedrock:{region}::foundation-model/{model.provider_model_id}"
                        },
                    },
                },
            )
        except (ClientError, BotoCoreError) as exc:
            raise ProviderError(f"bedrock rerank: {exc}") from exc
        scores = [0.0] * len(documents)
        for r in resp.get("results", []):
            scores[int(r["index"])] = float(r["relevanceScore"])
        return scores

    def tokenize(self, text: str) -> int:
        return estimate_tokens(text)

    def healthcheck(self) -> bool:
        return True


class BedrockAnthropicProvider:
    """Claude en Bedrock mediante el cliente Mantle del SDK oficial de Anthropic."""

    name = "bedrock-anthropic"

    def __init__(self, region: str | None = None) -> None:
        self.region = region or get_settings().aws_region

    @cached_property
    def _client(self):
        from anthropic import AnthropicBedrockMantle

        return AnthropicBedrockMantle(aws_region=self.region)

    def generate(self, model: ModelSpec, request: GenerationRequest) -> GenerationResult:
        import anthropic

        try:
            resp = self._client.messages.create(
                model=model.provider_model_id,
                max_tokens=max(request.max_output_tokens, 2000),
                system=request.system,
                messages=[{"role": "user", "content": anthropic_content(model, request)}],
                output_config={"effort": "medium"},
            )
        except anthropic.RateLimitError as exc:
            raise ProviderError(f"claude rate limited: {exc}") from exc
        except anthropic.APIStatusError as exc:
            if exc.status_code >= 500:
                raise ProviderError(f"claude {exc.status_code}") from exc
            raise
        except anthropic.APIConnectionError as exc:
            raise ProviderError(f"claude connection: {exc}") from exc
        if resp.stop_reason == "refusal":
            raise RefusalError(getattr(resp.stop_details, "category", None) or "refusal")
        text = "".join(b.text for b in resp.content if b.type == "text")
        return GenerationResult(text, model.model_id, resp.usage.input_tokens, resp.usage.output_tokens,
                                resp.stop_reason or "end_turn")

    def embed(self, model, texts, input_type):  # pragma: no cover - no aplica
        raise ProviderError("Claude no ofrece embeddings")

    def rerank(self, model, query, documents):  # pragma: no cover - no aplica
        raise ProviderError("Claude no ofrece rerank")

    def tokenize(self, text: str) -> int:
        return estimate_tokens(text)

    def healthcheck(self) -> bool:
        return True
