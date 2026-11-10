"""Token interno API -> rag-engine.

La API resuelve identidad, membresía, tenant y principals; emite un JWT HS256 de vida
corta (<= 60 s). rag-engine nunca acepta tenant_id desde el cliente final.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

import jwt

from .db import SecurityContext
from .settings import get_settings

MAX_TTL_SECONDS = 120


class InternalAuthError(Exception):
    pass


@dataclass(frozen=True)
class InternalClaims:
    organization_id: uuid.UUID
    user_id: uuid.UUID
    workspace_id: uuid.UUID
    principals: tuple[str, ...]
    plan_id: str
    data_class: str
    model_allowlist: tuple[str, ...]
    max_context_tokens: int
    rerank_enabled: bool
    graph_enabled: bool = False   # RAG-05: grafo habilitado (plan u organización), resuelto por la API

    def security_context(self) -> SecurityContext:
        return SecurityContext(self.organization_id, self.user_id, self.principals)


def verify_internal_token(token: str) -> InternalClaims:
    s = get_settings()
    if not s.internal_service_secret or len(s.internal_service_secret) < 32:
        raise InternalAuthError("INTERNAL_SERVICE_SECRET no configurado o débil")
    try:
        payload = jwt.decode(
            token,
            s.internal_service_secret,
            algorithms=["HS256"],
            audience=s.internal_token_audience,
            issuer=s.internal_token_issuer,
            options={"require": ["exp", "iat", "sub", "org", "ws", "principals"]},
        )
    except jwt.PyJWTError as exc:
        raise InternalAuthError(str(exc)) from exc
    if payload["exp"] - payload["iat"] > MAX_TTL_SECONDS:
        raise InternalAuthError("token interno con TTL excesivo")
    try:
        return InternalClaims(
            organization_id=uuid.UUID(payload["org"]),
            user_id=uuid.UUID(payload["sub"]),
            workspace_id=uuid.UUID(payload["ws"]),
            principals=tuple(payload["principals"]),
            plan_id=str(payload.get("plan", "team")),
            data_class=str(payload.get("data_class", "internal")),
            model_allowlist=tuple(payload.get("allowlist", [])),
            max_context_tokens=int(payload.get("max_ctx", 6000)),
            rerank_enabled=bool(payload.get("rerank", False)),
            graph_enabled=payload.get("graph") is True,
        )
    except (ValueError, KeyError, TypeError) as exc:
        raise InternalAuthError(f"claims inválidos: {exc}") from exc


def issue_internal_token(claims: InternalClaims, ttl: int = 60, secret: str | None = None) -> str:
    """Solo para pruebas y herramientas internas; la API TS emite el token en producción."""
    import time

    s = get_settings()
    now = int(time.time())
    return jwt.encode(
        {
            "iss": s.internal_token_issuer,
            "aud": s.internal_token_audience,
            "iat": now,
            "exp": now + ttl,
            "sub": str(claims.user_id),
            "org": str(claims.organization_id),
            "ws": str(claims.workspace_id),
            "principals": list(claims.principals),
            "plan": claims.plan_id,
            "data_class": claims.data_class,
            "allowlist": list(claims.model_allowlist),
            "max_ctx": claims.max_context_tokens,
            "rerank": claims.rerank_enabled,
            "graph": claims.graph_enabled,
        },
        secret or s.internal_service_secret,
        algorithm="HS256",
    )
