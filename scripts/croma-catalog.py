#!/usr/bin/env python3
"""Regenerates the curated Croma catalog used by "Public records" in Ask (ADR-036).

Croma (https://api.croma.run) publishes 400+ endpoints. Ragis only exposes an allowlist: searches over companies,
court cases, laws and gazettes, regulation, sanctions, public procurement, statistics and the web. Lookups of a
private person's data by ID number (criminal records, health, social security, bank accounts, personal tax
invoices, vehicles by owner) are deliberately left out.

Usage:  python3 scripts/croma-catalog.py            # fetches the public catalog (no API key needed)
        python3 scripts/croma-catalog.py --check    # exits 1 if an allowlisted endpoint disappeared
"""

from __future__ import annotations

import json
import sys
import urllib.request
from pathlib import Path

CATALOG_URL = "https://api.croma.run/catalog"
OUT = Path(__file__).resolve().parents[1] / "services/rag-engine/src/ragsis_rag/public_sources/croma_catalog.json"

COUNTRIES = {
    "Colombia": "co", "Mexico": "mx", "Peru": "pe", "United States": "us", "Brazil": "br", "El Salvador": "sv",
    "Bolivia": "bo", "Japan": "jp", "Chile": "cl", "Venezuela": "ve", "Guatemala": "gt", "Global": "global",
}

# endpoint id -> category. Categories drive the fallback routing when no language model is available.
ALLOWLIST: dict[str, str] = {
    # Colombia
    "rues-entities-by-name": "companies", "rues-entity-by-nit": "companies",
    "supersociedades-companies-search": "companies", "supersociedades-insolvency-processes-search": "companies",
    "rama-judicial-cases-by-entity": "courts", "corte-constitucional-rulings-search": "courts",
    "corte-suprema-rulings-search": "courts", "samai-rulings-search": "courts",
    "legalize-laws-search": "laws", "funcion-publica-norms-search": "laws", "imprenta-diarios-search": "laws",
    "dian-doctrina-search": "tax", "superfinanciera-regulations-search": "regulation",
    "secop-contracts-search": "procurement", "secop-processes-search": "procurement",
    "secop-sanctions-search": "sanctions", "sic-sanctions-sanctions-search": "sanctions",
    "sic-ip-trademarks-search": "ip", "invima-registrations-search": "health", "banrep-series-search": "stats",
    # Mexico
    "dof-publications-by-date": "laws", "scjn-tesis-search": "courts", "diputados-federal-laws": "laws",
    "siem-establishments": "companies", "cnbv-regulations": "regulation", "banxico-circulars": "regulation",
    # Peru
    "sunat-name": "companies", "sunat-ruc": "companies", "oece-processes-search": "procurement",
    "tribunal-constitucional-rulings-search": "courts", "servir-tsc-resolutions-search": "courts",
    # United States
    "sec-companies-search": "companies", "sec-filing-events-search": "companies",
    "delaware-entities-search": "companies", "ofac-sanctions-screen": "sanctions", "csl-parties-search": "sanctions",
    "sam-exclusions-search": "sanctions", "uspto-trademarks-search": "ip",
    # Brazil
    "djen-publications-search": "courts", "cgu-sanctions-search": "sanctions", "planalto-laws-search": "laws",
    "ibge-tables-search": "stats", "pgfn-debts-search": "companies",
    # El Salvador
    "csj-sv-rulings-search": "courts", "csj-sv-laws-search": "laws", "asamblea-sv-decrees-search": "laws",
    "cnr-sv-filings-search": "companies", "comprasal-sv-awards-search": "procurement",
    # Bolivia
    "tcp-bo-rulings-search": "courts", "tsj-bo-rulings-search": "courts",
    # Japan
    "nta-companies-search": "companies", "courts-jp-rulings-search": "courts",
    # Chile
    "leychile-norms-search": "laws", "sii-oficios-search": "tax", "sii-circulars-search": "tax",
    "cmf-regulations-search": "regulation", "cmf-sanctions-search": "sanctions",
    "pjud-supreme-court-rulings-search": "courts", "contraloria-cl-dictamenes-search": "regulation",
    "dt-cl-pronouncements-search": "regulation", "tc-cl-rulings-search": "courts",
    # Venezuela
    "seniat-rif": "companies",
    # Guatemala
    "mintrabajo-gt-minimum-wage": "stats", "mintrabajo-gt-publications-search": "stats",
    "mintrabajo-gt-labour-indicators": "stats",
    # Worldwide
    "web-search": "web", "research": "web", "extract-markdown": "web", "gleif-entities-search": "companies",
}

TEXT_PARAMS = ("query", "q", "name", "text", "search", "keywords", "keyword", "title")
MAX_DESC = 220
MAX_PARAM_DESC = 120


def _param(name: str, spec: dict, required: bool) -> dict:
    out: dict = {"name": name, "type": spec.get("type", "string"), "required": required}
    for key in ("enum", "minLength", "maxLength", "minimum", "maximum", "format", "pattern", "default"):
        if key in spec:
            out[key] = spec[key]
    if spec.get("description"):
        out["description"] = str(spec["description"]).split("\n")[0][:MAX_PARAM_DESC]
    return out


def build(raw: dict) -> dict:
    endpoints = raw["data"]["endpoints"]
    by_id = {e["id"]: e for e in endpoints}
    missing = sorted(set(ALLOWLIST) - set(by_id))
    out = []
    for eid, category in ALLOWLIST.items():
        e = by_id.get(eid)
        if not e:
            continue
        required = set(e.get("required") or [])
        schema = e.get("request_schema") or {}
        params = [_param(n, s if isinstance(s, dict) else {}, n in required) for n, s in schema.items()]
        names = [p["name"] for p in params]
        text_param = next((n for n in TEXT_PARAMS if n in names), None)
        out.append({
            "id": eid,
            "name": e.get("name") or eid,
            "path": e["path"],
            "country": COUNTRIES.get(e.get("country", ""), "global"),
            "source": e.get("source") or "",
            "category": category,
            "served_from": e.get("served_from", "live"),
            "description": (e.get("description") or "")[:MAX_DESC],
            "docs_url": e.get("docs_url") or "",
            "text_param": text_param,
            "params": params,
        })
    return {"generated_from": CATALOG_URL, "version": raw["data"].get("version"), "endpoints": out,
            "missing": missing}


def main() -> int:
    req = urllib.request.Request(CATALOG_URL, headers={"user-agent": "ragsis-catalog/1"})
    with urllib.request.urlopen(req, timeout=30) as res:  # noqa: S310 (fixed https URL)
        raw = json.load(res)
    built = build(raw)
    if built["missing"]:
        print("allowlisted endpoints missing from Croma:", ", ".join(built["missing"]), file=sys.stderr)
    if "--check" in sys.argv:
        return 1 if built["missing"] else 0
    built.pop("missing")
    OUT.write_text(json.dumps(built, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    shown = OUT.relative_to(Path.cwd()) if OUT.is_relative_to(Path.cwd()) else OUT
    print(f"wrote {len(built['endpoints'])} endpoints to {shown}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
