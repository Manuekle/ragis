"""rag-engine: servicio interno (red privada). Solo acepta llamadas de la API con token interno."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from dataclasses import asdict
from datetime import date
from typing import Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response
from pydantic import BaseModel, Field
from ragsis_ai.gateway import AIGateway, BudgetExceeded
from ragsis_ai.policy import PolicyViolation
from ragsis_ai.providers.base import ProviderError
from ragsis_core.db import close_pool, get_pool
from ragsis_core.internal_auth import InternalAuthError, InternalClaims, verify_internal_token
from ragsis_core.logging import setup_logging
from ragsis_core.settings import get_settings
from ragsis_core.telemetry import init_tracing, remote_parent, shutdown_tracing

from .documents.model import MAX_MARKDOWN_CHARS
from .documents.render import render as render_document
from .orchestrator import QueryOptions, QueryOrchestrator
from .public_sources import status as public_sources_status

logger = logging.getLogger("ragsis.rag.app")


@asynccontextmanager
async def lifespan(_: FastAPI):
    setup_logging(get_settings().log_level)
    init_tracing("ragsis-rag-engine")
    get_pool()
    yield
    close_pool()
    shutdown_tracing()


app = FastAPI(title="ragsis rag-engine", version="0.1.0", lifespan=lifespan, docs_url=None, redoc_url=None)
_gateway = AIGateway()
_orchestrator = QueryOrchestrator(_gateway)


def claims_dep(authorization: str = Header(default="")) -> InternalClaims:
    if not authorization.startswith("Bearer "):
        raise HTTPException(401, "missing internal token")
    try:
        return verify_internal_token(authorization.removeprefix("Bearer ").strip())
    except InternalAuthError as exc:
        logger.warning("token interno rechazado: %s", exc)
        raise HTTPException(401, "invalid internal token") from exc


class QueryIn(BaseModel):
    question: str = Field(min_length=2, max_length=2000)
    as_of: date | None = None
    top_k: int = Field(default=8, ge=1, le=8)
    max_output_tokens: int = Field(default=800, ge=64, le=1200)
    # RAG-05: solo aplica si el tenant tiene el grafo habilitado (claim `graph` firmado por la API).
    graph_mode: Literal["auto", "off", "local", "global", "hybrid"] = "auto"
    # ADR-034: "answer" mantiene el contrato anterior; "auto" detecta pedidos de archivo; un formato lo fuerza.
    output: Literal["answer", "auto", "pdf", "docx", "pptx", "xlsx", "csv", "md"] = "answer"


class RenderIn(BaseModel):
    """Conversión de un documento ya generado y verificado (la API lo lee bajo RLS antes de llamar aquí)."""
    markdown: str = Field(min_length=1, max_length=MAX_MARKDOWN_CHARS)
    format: Literal["pdf", "docx", "pptx", "xlsx", "csv", "md"]
    kind: Literal["report", "presentation", "table"] = "report"
    title: str = Field(default="Document", min_length=1, max_length=200)
    citations: list[dict] = Field(default_factory=list, max_length=50)
    created: date | None = None


@app.get("/healthz")
def healthz() -> dict:
    with get_pool().connection() as conn:
        conn.execute("SELECT 1")
    return {"status": "ok"}


@app.post("/internal/query")
def query(body: QueryIn, request: Request, claims: InternalClaims = Depends(claims_dep)) -> dict:  # noqa: B008
    try:
        with remote_parent({k: v for k, v in request.headers.items() if k in ("traceparent", "tracestate")}):
            res = _orchestrator.run(claims, body.question,
                                    QueryOptions(as_of=body.as_of, top_k=body.top_k,
                                                 max_output_tokens=body.max_output_tokens,
                                                 graph_mode=body.graph_mode, output=body.output))
    except PolicyViolation as exc:
        raise HTTPException(403, {"code": "model_policy_violation", "detail": str(exc)}) from exc
    except BudgetExceeded as exc:
        raise HTTPException(429, {"code": "budget_exceeded", "detail": str(exc)}) from exc
    except ProviderError as exc:
        logger.exception("proveedor de IA no disponible")
        raise HTTPException(503, {"code": "ai_unavailable"}) from exc
    return asdict(res)


@app.post("/internal/render")
def render(body: RenderIn, _: InternalClaims = Depends(claims_dep)) -> Response:  # noqa: B008
    """Markdown → archivo. Sin red ni disco: los renderizadores no descargan nada (ni imágenes ni enlaces)."""
    try:
        out = render_document(body.markdown, body.format, body.citations, kind=body.kind, title=body.title,
                              created=body.created, page=get_settings().docs_page_size)
    except (ValueError, KeyError) as exc:
        raise HTTPException(422, {"code": "render_failed", "detail": str(exc)}) from exc
    return Response(out.data, media_type=out.mime, headers={"x-filename": out.filename})


@app.get("/internal/public-sources/status")
def public_status(_: InternalClaims = Depends(claims_dep)) -> dict:  # noqa: B008
    """ADR-036: si los registros públicos están configurados (clave de Croma o modo demo). La clave nunca sale."""
    return public_sources_status()


@app.get("/internal/health/models")
def model_health(_: InternalClaims = Depends(claims_dep)) -> dict:  # noqa: B008
    return _gateway.healthcheck()
