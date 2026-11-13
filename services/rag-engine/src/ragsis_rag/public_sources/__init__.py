"""Public records in Ask (ADR-036): official government data and the web, through Croma, on request.

The API decides whether a question may use them (organization switch, monthly limit) and says so in the signed
internal token; this package plans the lookups from the question alone, calls Croma and turns the answers into
evidence that the verifier treats like any other source.
"""

from __future__ import annotations

import contextvars
import logging
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import date

from ragsis_core.logging import log
from ragsis_core.settings import get_settings
from ragsis_core.text import estimate_tokens

from .catalog import COUNTRY_CODES, COUNTRY_NAMES, load_catalog
from .client import CromaClient, CromaError, LookupClient
from .evidence import ExternalItem, items_from_response, unavailable_item
from .fake import FakeCromaClient
from .planner import Generate, make_plan

logger = logging.getLogger("ragsis.rag.public")

__all__ = ["COUNTRY_CODES", "COUNTRY_NAMES", "ExternalItem", "PublicClaim", "PublicOutcome", "build_client",
           "run_lookup", "status"]


@dataclass(frozen=True)
class PublicClaim:
    """Signed by the API: the organization allows public records for this question."""
    country: str | None          # organization default (ISO 3166 alpha-2, lower case) or None
    web: bool                    # web search / research allowed
    max_calls: int               # remaining monthly allowance, capped by the API
    override: str | None = None  # country the person picked for this question ("global" = worldwide only)


@dataclass
class PublicOutcome:
    items: list[ExternalItem] = field(default_factory=list)
    refs: list[dict] = field(default_factory=list)   # audit refs per call: endpoint + outcome, never parameters
    lookups: int = 0
    credits: int = 0
    countries: list[str] = field(default_factory=list)
    planner: str = "none"
    unavailable: str | None = None
    demo: bool = False

    def summary(self) -> dict:
        return {
            "requested": True,
            "lookups": self.lookups,
            "countries": self.countries,
            "sources": sorted({i.source for i in self.items}),
            "unavailable": self.unavailable,
            "demo": self.demo,
        }


def build_client() -> LookupClient | None:
    s = get_settings()
    if s.croma_demo:
        return FakeCromaClient()
    if s.croma_api_key:
        return CromaClient(s.croma_base_url, s.croma_api_key, s.croma_timeout_seconds)
    return None


def status() -> dict:
    s = get_settings()
    return {"available": bool(s.croma_demo or s.croma_api_key), "demo": bool(s.croma_demo),
            "endpoints": len(load_catalog())}


def _fit(items: list[ExternalItem], budget_tokens: int) -> list[ExternalItem]:
    out, used = [], 0
    for item in items:
        cost = estimate_tokens(item.text) + 40
        if used + cost > budget_tokens and out:
            continue
        out.append(item)
        used += cost
    return out


def run_lookup(question: str, claim: PublicClaim, generate: Generate | None,
               client: LookupClient | None) -> PublicOutcome:
    if client is None:
        return PublicOutcome(unavailable="not_configured")
    s = get_settings()
    plan = make_plan(question, claim.country, claim.web, min(claim.max_calls, s.croma_max_calls), generate,
                     claim.override)
    outcome = PublicOutcome(countries=plan.countries, planner=plan.planner, demo=client.demo)
    if not plan.calls:
        return outcome
    day = date.today().isoformat()
    with ThreadPoolExecutor(max_workers=len(plan.calls), thread_name_prefix="croma") as pool:
        futures = [pool.submit(contextvars.copy_context().run, client.call, c.endpoint, c.params)
                   for c in plan.calls]
        results = []
        for call, fut in zip(plan.calls, futures, strict=True):
            try:
                results.append((call, fut.result(), None))
            except CromaError as exc:
                results.append((call, None, exc))
    errors: list[str] = []
    for call, resp, err in results:
        ref = {"kind": "public_lookup", "endpoint": call.endpoint.id, "planner": plan.planner}
        if err is not None:
            errors.append(err.code)
            outcome.refs.append({**ref, "status": err.code, "http": err.status})
            level = logging.ERROR if err.code == "not_configured" else logging.WARNING
            log(logger, level, "public lookup failed", endpoint=call.endpoint.id, code=err.code, http=err.status,
                detail=err.message)
            continue
        outcome.lookups += 1
        outcome.credits += resp.credits
        outcome.refs.append({**ref, "status": "pending" if resp.pending else "ok", "credits": resp.credits,
                             "cached": resp.cached, "request_id": resp.request_id, "ms": resp.elapsed_ms})
        if resp.pending:
            item = unavailable_item(call.endpoint, "pending", day)
            if item:
                outcome.items.append(item)
        else:
            outcome.items.extend(items_from_response(call.endpoint, call.params, resp.data, demo=client.demo))
    outcome.items = _fit(outcome.items, s.croma_context_tokens)
    if errors and not outcome.lookups:
        outcome.unavailable = errors[0]
    return outcome
