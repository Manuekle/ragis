"""HTTP client for Croma (https://api.croma.run). Only POSTs to allowlisted catalog paths on a fixed host.

The API key never leaves the rag-engine and is never logged. Every Croma call is a read-only lookup, so retrying is
safe, but Ask answers within one request: a slow lookup (async job, HTTP 202) is reported as "still processing"
instead of polling.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Protocol

import httpx

from .catalog import Endpoint


class CromaError(Exception):
    """`code`: invalid_request | not_configured | credits_exhausted | rate_limited | source_unavailable | timeout |
    unavailable."""

    def __init__(self, code: str, status: int | None = None, message: str = "") -> None:
        super().__init__(f"{code} ({status})" if status else code)
        self.code = code
        self.status = status
        self.message = message


@dataclass(frozen=True)
class CromaResponse:
    data: Any
    status: int
    credits: int
    cached: bool
    request_id: str | None
    elapsed_ms: int
    pending: bool = False   # 202: an async job that did not finish within the wait window


class LookupClient(Protocol):
    demo: bool

    def call(self, endpoint: Endpoint, params: dict) -> CromaResponse: ...


_ERRORS = {400: "invalid_request", 401: "not_configured", 402: "credits_exhausted", 403: "not_configured",
           404: "invalid_request", 410: "invalid_request", 429: "rate_limited"}


class CromaClient:
    demo = False

    def __init__(self, base_url: str, api_key: str, timeout: float = 25.0,
                 transport: httpx.BaseTransport | None = None) -> None:
        if not base_url.startswith("https://") and "://127.0.0.1" not in base_url and "://localhost" not in base_url:
            raise ValueError("CROMA_BASE_URL must be https")
        self._base = base_url.rstrip("/")
        self._key = api_key
        self._timeout = timeout
        self._transport = transport

    def call(self, endpoint: Endpoint, params: dict) -> CromaResponse:
        if not self._key:
            raise CromaError("not_configured")
        # Prefer: wait=N (RFC 7240): Croma holds async jobs up to N s (max 55) before answering 202.
        wait = max(1, min(55, int(self._timeout) - 3))
        headers = {"authorization": f"Bearer {self._key}", "content-type": "application/json",
                   "prefer": f"wait={wait}", "user-agent": "ragsis-rag/0.1"}
        t0 = time.perf_counter()
        try:
            with httpx.Client(timeout=self._timeout, transport=self._transport, follow_redirects=False) as client:
                res = client.post(self._base + endpoint.path, json=params, headers=headers)
        except httpx.TimeoutException as exc:
            raise CromaError("timeout") from exc
        except httpx.HTTPError as exc:
            raise CromaError("unavailable") from exc
        elapsed = int((time.perf_counter() - t0) * 1000)
        request_id = res.headers.get("x-request-id")
        cached = res.headers.get("x-cache", "").upper() == "HIT"
        if res.status_code == 202:
            return CromaResponse(None, 202, 0, False, request_id, elapsed, pending=True)
        if res.status_code != 200:
            code = _ERRORS.get(res.status_code, "source_unavailable" if res.status_code >= 500 else "unavailable")
            message = ""
            try:
                message = str(res.json().get("error", {}).get("code", ""))[:80]
            except (ValueError, AttributeError):
                pass
            raise CromaError(code, res.status_code, message)
        try:
            body = res.json()
        except ValueError as exc:
            raise CromaError("unavailable", 200, "invalid json") from exc
        if not isinstance(body, dict) or "data" not in body:
            raise CromaError("unavailable", 200, "unexpected body")
        return CromaResponse(body["data"], 200, 0 if cached else endpoint.credits, cached, request_id, elapsed)
