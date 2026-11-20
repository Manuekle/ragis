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
    # ADR-036: registros públicos permitidos para ESTA pregunta (interruptor de la organización + cupo mensual),
    # resuelto por la API: {"country": "co"|None, "web": bool, "max_calls": int, "override": str|None}.
    public_sources: dict | None = None
    # ADR-037: dónde puede buscar ESTA pregunta, resuelto y firmado por la API. `workspace_ids`: espacios (vacío = solo
    # `workspace_id`); `scope`: {"kind": space|matter|folder|documents|all, "matter_id"?, "folder_id"?, "document_ids"?}.
    workspace_ids: tuple[uuid.UUID, ...] = ()
    scope: dict | None = None

    def security_context(self) -> SecurityContext:
        return SecurityContext(self.organization_id, self.user_id, self.principals)

    @property
    def search_workspaces(self) -> list[uuid.UUID]:
        """Espacios donde busca la pregunta: los firmados en `wss` o, si no vienen, el espacio activo."""
        return list(self.workspace_ids) or [self.workspace_id]


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
            public_sources=_public_claim(payload.get("pub")),
            workspace_ids=_workspaces_claim(payload.get("wss")),
            scope=_scope_claim(payload.get("sc")),
        )
    except (ValueError, KeyError, TypeError) as exc:
        raise InternalAuthError(f"claims inválidos: {exc}") from exc


MAX_SCOPE_DOCUMENTS = 50
_SCOPE_KINDS = ("space", "matter", "folder", "documents", "all")


def _workspaces_claim(raw) -> tuple[uuid.UUID, ...]:
    """`wss` del token. Ausente = solo el espacio activo. Malformado = token inválido: nunca se busca de más."""
    if raw is None:
        return ()
    if not isinstance(raw, list) or not raw or len(raw) > 500:
        raise ValueError("wss must be a non-empty list")
    return tuple(dict.fromkeys(uuid.UUID(str(w)) for w in raw))


def _scope_claim(raw) -> dict | None:
    """`sc` del token (ADR-037). Malformado = token inválido (falla cerrado, no se ignora el filtro)."""
    if raw is None:
        return None
    if not isinstance(raw, dict) or raw.get("k") not in _SCOPE_KINDS:
        raise ValueError("invalid sc claim")
    kind = raw["k"]
    out: dict = {"kind": kind}
    if kind == "matter":
        out["matter_id"] = uuid.UUID(str(raw["m"]))
    elif kind == "folder":
        out["folder_id"] = uuid.UUID(str(raw["f"]))
    elif kind == "documents":
        docs = raw.get("d")
        if not isinstance(docs, list) or not docs or len(docs) > MAX_SCOPE_DOCUMENTS:
            raise ValueError("sc.d must list 1-50 documents")
        out["document_ids"] = tuple(dict.fromkeys(uuid.UUID(str(d)) for d in docs))
    return out


def _public_claim(raw) -> dict | None:
    """`pub` del token: ausente o malformado = sin registros públicos (nunca se infiere del cuerpo de la petición)."""
    if not isinstance(raw, dict):
        return None

    def code(v):
        return v if isinstance(v, str) and 2 <= len(v) <= 8 and v.isalpha() else None

    n = raw.get("n")
    if not isinstance(n, int) or isinstance(n, bool) or n <= 0:
        return None
    return {"country": code(raw.get("c")), "web": raw.get("w") is True, "max_calls": min(n, 10),
            "override": code(raw.get("o"))}


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
            **({"wss": [str(w) for w in claims.workspace_ids]} if claims.workspace_ids else {}),
            **({"sc": _scope_payload(claims.scope)} if claims.scope else {}),
            **({"pub": {"c": claims.public_sources.get("country"), "w": bool(claims.public_sources.get("web")),
                        "n": int(claims.public_sources.get("max_calls", 0)),
                        "o": claims.public_sources.get("override")}} if claims.public_sources else {}),
        },
        secret or s.internal_service_secret,
        algorithm="HS256",
    )


def _scope_payload(scope: dict) -> dict:
    out: dict = {"k": scope["kind"]}
    if scope.get("matter_id"):
        out["m"] = str(scope["matter_id"])
    if scope.get("folder_id"):
        out["f"] = str(scope["folder_id"])
    if scope.get("document_ids"):
        out["d"] = [str(d) for d in scope["document_ids"]]
    return out
