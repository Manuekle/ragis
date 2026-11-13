"""Croma JSON → citable evidence for the prompt (ADR-036).

One evidence item per record (up to MAX_ITEMS_PER_CALL per lookup) so each citation points at one company, case,
norm or web page. An empty result is evidence too ("the search returned no records"), scoped to that search only.
Everything here is untrusted data: the prompt escapes it and the system prompt says so.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Any
from urllib.parse import urlparse

from .catalog import COUNTRY_NAMES, Endpoint

MAX_ITEMS_PER_CALL = 4
MAX_ITEM_CHARS = 2200
MAX_VALUE_CHARS = 320
# Campos de texto largo (resumen, decisión…): son los que responden «qué dijo». Más espacio que un metadato.
LONG_VALUE_CHARS = 900
_LONG_KEYS = {"summary", "decision", "text", "content", "abstract", "description", "body", "excerpt", "snippet",
              "holding", "considerations", "resumen", "report", "markdown"}
MAX_REPORT_CHARS = 3500
SNIPPET_CHARS = 320

_LIST_KEYS = ("results", "entities", "cases", "items", "records", "publications", "rulings", "matches", "parties",
              "establishments", "laws", "norms", "filings", "data")
_URL_KEYS = ("official_url", "url", "source_url", "document_url", "pdf_url", "html_url", "detail_url", "link")
_NAME_KEYS = ("name", "title", "legal_name")
_IDENT_KEYS = ("number", "registration_number", "rif", "ruc", "nit")
_SKIP_KEYS = {"connection_id", "relatoria_id", "related_relatoria_ids", "reporting_judge_keys", "score",
              "is_private", "capped", "pagination", "total_is_exact", "per_page", "page", "total_pages"}


@dataclass(frozen=True)
class ExternalItem:
    """One citable piece of public information."""
    text: str
    title: str
    source: str
    country: str
    kind: str                 # public_record | web
    endpoint: str
    url: str | None = None
    as_of: str | None = None
    retrieved: str = ""
    no_match: bool = False
    demo: bool = False

    @property
    def snippet(self) -> str:
        body = self.text.split("\n", 1)[-1].strip()
        return body[:SNIPPET_CHARS] + ("…" if len(body) > SNIPPET_CHARS else "")


def _human(key: str) -> str:
    return key.replace("_", " ").strip().capitalize()


def _scalar(value: Any, limit: int = MAX_VALUE_CHARS) -> str | None:
    if value is None or value == "" or value == []:
        return None
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, (int, float, str)):
        text = " ".join(str(value).split())
        if not text:
            return None
        return text[:limit] + ("…" if len(text) > limit else "")
    return None


def _skip(key: str) -> bool:
    return key in _SKIP_KEYS or key == "id" or key.endswith(("_id", "_ids", "_keys", "_code"))


def _lines(obj: dict, prefix: str = "", depth: int = 0) -> list[str]:
    out: list[str] = []
    for key, value in obj.items():
        if _skip(key) or key in _URL_KEYS:
            continue
        label = f"{prefix}{_human(key)}"
        s = _scalar(value, LONG_VALUE_CHARS if key in _LONG_KEYS else MAX_VALUE_CHARS)
        if s is not None:
            out.append(f"{label}: {s}")
        elif isinstance(value, list) and value and all(_scalar(v) is not None for v in value):
            out.append(f"{label}: {', '.join(_scalar(v) or '' for v in value[:8])}")
        elif isinstance(value, list) and value and isinstance(value[0], dict) and depth == 0:
            names = [_title_of(v) for v in value[:3]]
            names = [n for n in names if n]
            out.append(f"{label}: {len(value)} entr{'y' if len(value) == 1 else 'ies'}"
                       + (f" ({'; '.join(names)})" if names else ""))
        elif isinstance(value, dict) and depth == 0:
            out.extend(_lines(value, f"{_human(key)} · ", depth + 1))
    return out


def _title_of(obj: dict) -> str:
    """A company or norm by its name; a case or ruling by its number and subject."""
    for key in _NAME_KEYS:
        s = _scalar(obj.get(key))
        if s:
            return s[:120]
    ident = next((_scalar(obj.get(k)) for k in _IDENT_KEYS if _scalar(obj.get(k))), None)
    subject = _scalar(obj.get("subject"))
    if ident and subject:
        return f"{ident} · {subject}"[:120]
    return (ident or subject or _scalar(obj.get("id")) or "")[:120]


def _url_of(obj: dict) -> str | None:
    for container in (obj, obj.get("detail") if isinstance(obj.get("detail"), dict) else {}):
        for key in _URL_KEYS:
            v = container.get(key)
            if isinstance(v, str) and v.startswith(("https://", "http://")):
                return v[:500]
    return None


def _main_list(data: dict) -> list | None:
    for key in _LIST_KEYS:
        v = data.get(key)
        if isinstance(v, list):
            return v
    for v in data.values():
        if isinstance(v, list) and (not v or isinstance(v[0], dict)):
            return v
    return None


def _clip(text: str, limit: int = MAX_ITEM_CHARS) -> str:
    return text if len(text) <= limit else text[: limit - 1] + "…"


def items_from_response(endpoint: Endpoint, params: dict, data: Any, retrieved: date | None = None,
                        demo: bool = False) -> list[ExternalItem]:
    day = (retrieved or date.today()).isoformat()
    country = COUNTRY_NAMES.get(endpoint.country, endpoint.country)
    source = endpoint.source or endpoint.name
    where = source if endpoint.country == "global" else f"{source} ({country})"
    # Lo que se buscó (valores tomados de la pregunta): da contexto al modelo y une el registro con la pregunta.
    searched = "; ".join(str(v) for k, v in params.items()
                         if isinstance(v, str) and (p := endpoint.param(k)) is not None and not p.enum)
    base = {"source": source, "country": endpoint.country, "kind": endpoint.kind, "endpoint": endpoint.id,
            "retrieved": day, "demo": demo}
    prefix = "[Demo data] " if demo else ""

    if endpoint.id == "web-search":
        out = []
        for r in (data or {}).get("results", [])[:MAX_ITEMS_PER_CALL]:
            if not isinstance(r, dict) or not str(r.get("url", "")).startswith(("https://", "http://")):
                continue
            host = urlparse(r["url"]).netloc
            lines = [f"{prefix}Public web page ({host}), found by web search on {day}."]
            if r.get("title"):
                lines.append(f"Title: {_scalar(r['title'])}")
            if r.get("publication_date"):
                lines.append(f"Published: {_scalar(r['publication_date'])}")
            for h in (r.get("highlights") or [])[:3]:
                if _scalar(h):
                    lines.append(_scalar(h) or "")
            out.append(ExternalItem(_clip("\n".join(lines)), f"{_scalar(r.get('title')) or host}", **{
                **base, "source": host}, url=r["url"][:500]))
        return out or [_no_match(base, where, searched, day, prefix)]

    if endpoint.id == "research":
        d = data or {}
        report = _clip(str(d.get("report") or ""), MAX_REPORT_CHARS)
        sources = [f"[{i + 1}] {s.get('title') or s.get('url')} ({s.get('url')})"
                   for i, s in enumerate(d.get("sources") or [])[:8] if isinstance(s, dict)]
        text = f"{prefix}Web research report written by Croma from live web sources on {day}.\n{report}"
        if sources:
            text += "\nSources of the report: " + "; ".join(sources)
        return [ExternalItem(_clip(text, MAX_REPORT_CHARS + 800), "Web research report", **base)]

    if endpoint.id == "extract-markdown":
        d = data or {}
        meta = d.get("metadata") if isinstance(d.get("metadata"), dict) else {}
        url = str(d.get("url") or params.get("url") or "")[:500] or None
        title = _scalar(meta.get("title")) or (urlparse(url).netloc if url else "Web page")
        text = f"{prefix}Public web page read on {day}.\n{_clip(str(d.get('markdown') or ''), MAX_REPORT_CHARS)}"
        return [ExternalItem(text, title, **base, url=url)]

    if not isinstance(data, dict):
        return [_no_match(base, where, searched, day, prefix)]
    as_of = _scalar(data.get("as_of"))
    if as_of and len(as_of) > 10 and as_of[4] == "-" and as_of[10] == "T":
        as_of = as_of[:10]   # "2026-11-12T10:52:58Z" → fecha: es lo que el lector necesita
    header = (f"{prefix}Official public record from {where}"
              + (f" for the search “{searched}”" if searched else "")
              + f", retrieved via Croma on {day}" + (f" (data as of {as_of})." if as_of else "."))
    rows = _main_list(data)
    if rows is None:
        if data.get("found") is False:
            return [_no_match(base, where, searched, day, prefix, as_of)]
        record = {k: v for k, v in data.items() if k not in ("as_of", "found", "query")}
        lines = _lines(record)
        title = _title_of(record) or endpoint.name
        return [ExternalItem(_clip("\n".join([header, *lines])), f"{where} · {title}", **base,
                             url=_url_of(record), as_of=as_of)]
    records = [r for r in rows if isinstance(r, dict)][:MAX_ITEMS_PER_CALL]
    if not records:
        return [_no_match(base, where, searched, day, prefix, as_of)]
    pagination = data.get("pagination") if isinstance(data.get("pagination"), dict) else {}
    total = data.get("total", pagination.get("total"))
    out = []
    for i, r in enumerate(records):
        lines = [header]
        if i == 0 and isinstance(total, int) and total > len(records):
            lines.append(f"The search matched {total} records; the first {len(records)} are shown.")
        lines += _lines(r)
        url = _url_of(r)
        if url:
            lines.append(f"Link: {url}")
        title = _title_of(r) or f"record {i + 1}"
        out.append(ExternalItem(_clip("\n".join(lines)), f"{where} · {title}", **base, url=url, as_of=as_of))
    return out


def _no_match(base: dict, where: str, searched: str, day: str, prefix: str, as_of: str | None = None) -> ExternalItem:
    when = f"on {day}" + (f" (data as of {as_of})" if as_of else "")
    what = f"no matching records for “{searched}”" if searched else "no matching records"
    text = f"{prefix}Search in {where} {when}: {what}. This only covers this register and search."
    return ExternalItem(text, f"{where} · no records found", **base, as_of=as_of, no_match=True)


def unavailable_item(endpoint: Endpoint, reason: str, day: str) -> ExternalItem | None:
    """A lookup that is still running (async job) is reported so the answer does not claim there is nothing."""
    if reason != "pending":
        return None
    country = COUNTRY_NAMES.get(endpoint.country, endpoint.country)
    where = endpoint.source if endpoint.country == "global" else f"{endpoint.source} ({country})"
    return ExternalItem(f"The lookup in {where} on {day} was still being processed by the source when this answer "
                        "was written; no result is available yet.", f"{where} · still processing",
                        endpoint.source, endpoint.country, endpoint.kind, endpoint.id, retrieved=day, no_match=True)
