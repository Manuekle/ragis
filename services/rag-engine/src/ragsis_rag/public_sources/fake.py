"""Demo Croma (CROMA_DEMO=1): canned, clearly labelled answers so Public records can be tried without a key.

Shapes follow Croma's real responses (`data` with a main list, `as_of` on datasets). Every value says "Demo" so
nobody mistakes it for a real record; links point at Croma's public documentation.
"""

from __future__ import annotations

from datetime import date

from .catalog import COUNTRY_NAMES, Endpoint
from .client import CromaResponse

DOCS = "https://docs.usecroma.com"


def _term(endpoint: Endpoint, params: dict) -> str:
    for key in (endpoint.text_param, "name", "query", "q"):
        if key and str(params.get(key) or "").strip():
            return str(params[key]).strip()[:80]
    return "your search"


class FakeCromaClient:
    demo = True

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []

    def call(self, endpoint: Endpoint, params: dict) -> CromaResponse:
        self.calls.append((endpoint.id, dict(params)))
        term = _term(endpoint, params)
        country = COUNTRY_NAMES.get(endpoint.country, endpoint.country)
        today = date.today().isoformat()
        url = endpoint.docs_url or DOCS
        if endpoint.id == "web-search":
            data = {"results": [
                {"url": f"{DOCS}/introduction", "title": f"Demo web result about {term}", "publication_date": today,
                 "author": None, "highlights": [f"Demo excerpt: this is sample web content mentioning {term}. "
                                                "Connect a real Croma key to see live results."], "score": 0.9},
                {"url": f"{DOCS}/guides/global/web-search", "title": f"Second demo result for {term}",
                 "publication_date": None, "author": "Demo", "highlights": [f"Demo excerpt two about {term}."],
                 "score": 0.7},
            ]}
        elif endpoint.id == "research":
            data = {"query": term, "report": f"Demo research report on {term}. Live research is available once a "
                                             "Croma key is configured [1].",
                    "sources": [{"title": "Croma documentation", "url": f"{DOCS}/introduction"}], "pages_analyzed": 1}
        elif endpoint.category == "companies":
            data = {"query": term, "capped": False, "entities": [
                {"name": f"{term.upper()} (Demo)", "nit": "900000000", "registration_status": "ACTIVA (Demo)",
                 "legal_organization": "SOCIEDAD POR ACCIONES SIMPLIFICADA (Demo)",
                 "chamber_name": f"Demo chamber of commerce · {country}", "last_renewed_year": "2026"},
            ]}
        elif endpoint.category == "courts":
            data = {"as_of": today, "query": term, "total": 1, "results": [
                {"number": "DEMO-2026-00001", "type": "Demo ruling", "ruling_date": "2026-03-02",
                 "court": f"Demo court · {country}", "subject": f"Demo case involving {term}",
                 "summary": "Demo summary. Real court data appears once a Croma key is configured.",
                 "official_url": url},
            ]}
        elif endpoint.category in ("laws", "regulation", "tax"):
            data = {"as_of": today, "query": term, "total": 1, "results": [
                {"title": f"Demo norm about {term}", "type": "Demo decree", "number": "0001 de 2026",
                 "publication_date": "2026-01-15", "status": "in_force (demo)",
                 "summary": f"Demo text of a {country} norm mentioning {term}.", "official_url": url},
            ]}
        else:
            data = {"as_of": today, "query": term, "total": 0, "results": []}
        return CromaResponse(data, 200, endpoint.credits, False, "req_demo", 5)
