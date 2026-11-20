"""CSV (RFC 4180, UTF-8 con BOM para que Excel muestre bien las tildes).

Sale de las tablas del documento. Una columna «Fuente»/«Source» se reescribe con el nombre legible del documento
citado («Política de viajes, p. 4») en lugar de «[2]»; si la tabla no la tiene, se añade al final. Las celdas quedan
sin marcas [n]. Sin tablas, cada párrafo o viñeta es una fila (Sección, Contenido, Fuentes). Las mismas filas
alimentan el Excel (`xlsx.py`).

Seguridad: una celda que empieza con = + - @ (o tabulador / retorno) se abre en Excel como fórmula y puede ejecutar
cosas (inyección CSV). Esas celdas se prefijan con «'». Los números negativos («-5», «-3,2 %») se dejan tal cual.
"""

from __future__ import annotations

import csv
import io
import re

from ..model import Document, Heading, ListBlock, Quote, Run, Table, cites_in, plain, short_source
from ..model import Paragraph as MdParagraph

_SOURCE_HEADER = re.compile(r"^\s*(fuentes?|sources?|referencias?|references?|cita|citation)\s*$", re.I)
_NUMERIC = re.compile(r"^[-+]?\s?[$€£]?\s?\d[\d.,\s]*%?$")


def _guard(value: str) -> str:
    value = value.replace("\r\n", " ").replace("\n", " ").strip()
    if value and value[0] in "=+-@\t\r" and not _NUMERIC.match(value):
        return "'" + value
    return value


def _text(runs: list[Run]) -> str:
    """Cell text without its [n] marks (the source goes in its own column)."""
    return re.sub(r"\s+([.,;:!?])", r"\1", " ".join("".join(r.text for r in runs if r.cite is None).split()))


def _names(cites, doc: Document) -> list[str]:
    return list(dict.fromkeys(short_source(s, doc.language) for n in dict.fromkeys(cites) if (s := doc.source(n))))


def table_rows(t: Table, doc: Document) -> tuple[list[list[str]], int]:
    """Header + rows as plain text, and the index of the source column (shared by CSV and Excel).

    Citations leave the cells («150 dólares diarios [3]») and every source of the row is written by name in one
    column: the table's own «Fuente»/«Source» column if it has one, otherwise a new last column. The sheet can then be
    filtered and sorted without stray [n] marks."""
    header = [plain(h) for h in t.header]
    src = next((i for i, h in enumerate(header) if _SOURCE_HEADER.match(h)), None)
    if src is None:
        header.append(doc.labels["source_col"])
        src = len(header) - 1
    rows = [header]
    width = len(t.header)
    for row in t.rows:
        cells = (row + [[]] * width)[:width]
        cites = [r.cite for c in cells for r in c if r.cite is not None]
        out = [_text(c) for c in cells] + ([""] if src == width else [])
        out[src] = "; ".join(([out[src]] if out[src] else []) + _names(cites, doc))
        rows.append(out)
    return rows, src


def content_rows(doc: Document) -> list[list[str]]:
    """Without tables: one row per paragraph or bullet (Section, Content, Sources)."""
    lab = doc.labels
    out = [[lab["section"], lab["content"], lab["sources"]]]
    if doc.lead and _text(doc.lead):
        out.append([lab["overview"], _text(doc.lead), "; ".join(_names(cites_in(doc.lead), doc))])
    section = ""
    for b in doc.blocks:
        if isinstance(b, Heading):
            section = plain(b.runs)
            continue
        items = [b.runs] if isinstance(b, MdParagraph | Quote) else (
            [it.runs for it in b.items] if isinstance(b, ListBlock) else [])
        for runs in items:
            if text := _text(runs):
                out.append([section, text, "; ".join(_names(cites_in(runs), doc))])
    return out


def render_csv(doc: Document) -> bytes:
    tables = [b for b in doc.blocks if isinstance(b, Table)]
    out: list[list[str]] = []
    if tables:
        groups: list[list[list[str]]] = []
        for t in tables:
            rows, _ = table_rows(t, doc)
            if groups and groups[-1][0] == rows[0]:
                groups[-1].extend(rows[1:])       # misma cabecera: se fusionan
            else:
                groups.append(rows)
        for i, g in enumerate(groups):
            if i:
                out.append([])
            out.extend(g)
    else:
        out = content_rows(doc)
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\r\n", quoting=csv.QUOTE_MINIMAL)
    for row in out:
        writer.writerow([_guard(c) for c in row])
    return ("\ufeff" + buf.getvalue()).encode("utf-8")
