"""Utilidades OOXML compartidas (DOCX/PPTX/XLSX) sin dependencias nativas.

- XML seguro: se rechaza DTD/entidades antes de parsear (XXE / billion laughs).
- Relaciones: resuelve rId → parte interna; los destinos externos (TargetMode=External) se ignoran
  siempre: nunca se descarga nada referenciado por un documento (SSRF).
- Gráficos: convierte la caché de datos de un chart (c:chartSpace) en una tabla Markdown con cifras exactas.
"""

from __future__ import annotations

import posixpath
import re
import zipfile
from xml.etree import ElementTree as ET  # noqa: S405 - se rechaza DTD/entidades antes de parsear

from ragsis_core.text import normalize

from ..images import inspect_image

NS = {
    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "c": "http://schemas.openxmlformats.org/drawingml/2006/chart",
    "m": "http://schemas.openxmlformats.org/officeDocument/2006/math",
    "wp": "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
    "v": "urn:schemas-microsoft-com:vml",
    "pr": "http://schemas.openxmlformats.org/package/2006/relationships",
}


def q(prefix: str, tag: str) -> str:
    return f"{{{NS[prefix]}}}{tag}"


R_EMBED = q("r", "embed")
R_ID = q("r", "id")
MAX_MEDIA_BYTES = 20_000_000

_CAPTION_TEXT = re.compile(
    r"^(figura|fig\.|gr[aá]fico|imagen|ilustraci[oó]n|diagrama|tabla|cuadro|ecuaci[oó]n|"
    r"figure|chart|table|equation)\s*[\dIVXLC]+[\s.:\-–]", re.I)
_TABLE_CAPTION = re.compile(r"^(tabla|cuadro|table)\b", re.I)
_CAPTION_STYLE = re.compile(r"^(caption|descripci[oó]?n|ep[ií]grafe|leyenda|pie)$", re.I)


def safe_xml(data: bytes) -> ET.Element:
    if b"<!DOCTYPE" in data or b"<!ENTITY" in data:
        raise ValueError("OOXML con DTD/entidades no admitido")
    return ET.fromstring(data)  # noqa: S314


def read_part(zf: zipfile.ZipFile, name: str) -> bytes | None:
    try:
        return zf.read(name)
    except KeyError:
        return None


def rels_for(zf: zipfile.ZipFile, part: str) -> dict[str, tuple[str, str]]:
    """rId → (parte interna resuelta, tipo). Ignora destinos externos."""
    folder, base = posixpath.split(part)
    data = read_part(zf, posixpath.join(folder, "_rels", f"{base}.rels"))
    if not data:
        return {}
    out: dict[str, tuple[str, str]] = {}
    for rel in safe_xml(data).iter(q("pr", "Relationship")):
        if rel.get("TargetMode") == "External":
            continue
        target = rel.get("Target", "")
        resolved = posixpath.normpath(target.lstrip("/") if target.startswith("/") else posixpath.join(folder, target))
        if resolved.startswith(".."):
            continue
        out[rel.get("Id", "")] = (resolved, rel.get("Type", "").rsplit("/", 1)[-1])
    return out


def media_image(zf: zipfile.ZipFile, path: str) -> tuple[bytes, str] | None:
    """Bytes + MIME de una imagen embebida si es un formato que un VLM acepta (EMF/WMF/TIFF se descartan)."""
    try:
        info = zf.getinfo(path)
    except KeyError:
        return None
    if info.file_size > MAX_MEDIA_BYTES:
        return None
    data = zf.read(path)
    meta = inspect_image(data)
    return (data, meta.mime) if meta else None


def is_caption_text(text: str) -> bool:
    return len(text) <= 300 and bool(_CAPTION_TEXT.match(text))


def is_caption_style(style: str) -> bool:
    return bool(_CAPTION_STYLE.match(style.replace(" ", "")))


def caption_targets_table(text: str) -> bool:
    return bool(_TABLE_CAPTION.match(text))


def _rich_text(el: ET.Element | None) -> str:
    if el is None:
        return ""
    return normalize(" ".join(t.text or "" for t in el.iter(q("a", "t"))))


def _cache_values(el: ET.Element | None) -> list[str]:
    if el is None:
        return []
    pts: dict[int, str] = {}
    for pt in el.iter(q("c", "pt")):
        v = pt.find(q("c", "v"))
        if v is not None and v.text is not None:
            pts[int(pt.get("idx", len(pts)))] = v.text.strip()
    if not pts:
        return []
    return [pts.get(i, "") for i in range(max(pts) + 1)]


def _fmt_number(raw: str) -> str:
    try:
        f = float(raw)
    except ValueError:
        return raw
    return f"{f:.15g}"


def chart_table(data: bytes, max_rows: int = 500) -> tuple[str, str] | None:
    """(título, tabla Markdown) desde la caché de un gráfico. None si no hay series con datos."""
    root = safe_xml(data)
    chart = root.find(q("c", "chart"))
    if chart is None:
        return None
    title = _rich_text(chart.find(q("c", "title")))
    series: list[tuple[str, list[str], list[str]]] = []
    for ser in chart.iter(q("c", "ser")):
        name = ""
        tx = ser.find(q("c", "tx"))
        if tx is not None:
            name = " ".join(_cache_values(tx)) or _rich_text(tx)
        cats = _cache_values(ser.find(q("c", "cat"))) or _cache_values(ser.find(q("c", "xVal")))
        vals = _cache_values(ser.find(q("c", "val"))) or _cache_values(ser.find(q("c", "yVal")))
        if vals:
            series.append((name or f"Serie {len(series) + 1}", cats, vals))
    if not series:
        return None
    cats = max((s[1] for s in series), key=len)
    n = min(max(len(cats), max(len(s[2]) for s in series)), max_rows)
    header = ["Categoría"] + [s[0].replace("|", "/") for s in series]
    rows = ["| " + " | ".join(header) + " |", "| " + " | ".join("---" for _ in header) + " |"]
    for i in range(n):
        cat = cats[i] if i < len(cats) else str(i + 1)
        cells = [cat.replace("|", "/")] + [_fmt_number(s[2][i]) if i < len(s[2]) else "" for s in series]
        rows.append("| " + " | ".join(cells) + " |")
    return title, "\n".join(rows)
