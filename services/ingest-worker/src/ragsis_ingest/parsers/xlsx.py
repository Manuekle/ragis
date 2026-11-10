"""XLSX vía OOXML (zipfile + ElementTree, sin dependencias nativas).

Cada hoja visible → encabezado (nombre de hoja) + tabla Markdown con los valores cacheados.
Fechas y porcentajes se formatean según el estilo de la celda para que las cifras citables coincidan
con lo que ve el usuario. Hojas ocultas se omiten (con advertencia). Límite de celdas por documento.
"""

from __future__ import annotations

import io
import re
import zipfile
from datetime import datetime, timedelta

from ragsis_core.text import normalize

from .model import Block, ParsedDocument
from .ooxml import R_ID, q, read_part, rels_for, safe_xml

MAX_ROWS_PER_SHEET = 5000
MAX_COLS = 60
MAX_CELLS = 250_000
_DATE_BUILTIN = set(range(14, 23)) | {45, 46, 47}
_PCT_BUILTIN = {9, 10}
_CELL_REF = re.compile(r"^([A-Z]{1,3})(\d+)$")
_DATE_CODE = re.compile(r"(?<![\\\"])[dmyhs]", re.I)
_EPOCH = datetime(1899, 12, 30)


def _col_index(letters: str) -> int:
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def _shared_strings(zf: zipfile.ZipFile) -> list[str]:
    data = read_part(zf, "xl/sharedStrings.xml")
    if not data:
        return []
    return [normalize("".join(t.text or "" for t in si.iter(q("s", "t")))) for si in safe_xml(data).iter(q("s", "si"))]


def _styles(zf: zipfile.ZipFile) -> list[str]:
    """Por índice de estilo de celda: 'date' | 'pct' | ''."""
    data = read_part(zf, "xl/styles.xml")
    if not data:
        return []
    root = safe_xml(data)
    custom: dict[int, str] = {}
    fmts = root.find(q("s", "numFmts"))
    if fmts is not None:
        for f in fmts.iter(q("s", "numFmt")):
            code = re.sub(r"\[[^\]]*\]|\"[^\"]*\"", "", f.get("formatCode", ""))
            custom[int(f.get("numFmtId", 0))] = "pct" if "%" in code else ("date" if _DATE_CODE.search(code) else "")
    out = []
    xfs = root.find(q("s", "cellXfs"))
    for xf in (xfs.iter(q("s", "xf")) if xfs is not None else []):
        fid = int(xf.get("numFmtId", 0))
        out.append("date" if fid in _DATE_BUILTIN else "pct" if fid in _PCT_BUILTIN else custom.get(fid, ""))
    return out


def _fmt_number(raw: str, kind: str) -> str:
    try:
        f = float(raw)
    except ValueError:
        return raw
    if kind == "date" and 0 < f < 2_958_466:
        dt = _EPOCH + timedelta(days=f)
        return dt.strftime("%Y-%m-%d %H:%M") if f % 1 else dt.strftime("%Y-%m-%d")
    if kind == "pct":
        return f"{f * 100:.10g}%"
    return f"{f:.15g}"


def parse_xlsx(data: bytes, max_pages: int) -> ParsedDocument:
    blocks: list[Block] = []
    warnings: list[str] = []
    cells_total = 0
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        wb = safe_xml(read_part(zf, "xl/workbook.xml") or b"<x/>")
        rels = rels_for(zf, "xl/workbook.xml")
        strings = _shared_strings(zf)
        styles = _styles(zf)
        sheets = wb.findall(f"{q('s', 'sheets')}/{q('s', 'sheet')}")
        page = 0
        for sheet in sheets:
            name = normalize(sheet.get("name", "Hoja"))
            if sheet.get("state") in ("hidden", "veryHidden"):
                warnings.append(f"hoja oculta omitida: {name}")
                continue
            target = rels.get(sheet.get(R_ID, ""))
            xml = read_part(zf, target[0]) if target else None
            if not xml:
                continue
            page += 1
            if page > max_pages:
                warnings.append(f"hojas por encima del límite del plan ({max_pages}) omitidas")
                break
            grid: dict[int, dict[int, str]] = {}
            truncated = False
            for row in safe_xml(xml).iter(q("s", "row")):
                for c in row.iter(q("s", "c")):
                    m = _CELL_REF.match(c.get("r", ""))
                    if not m:
                        continue
                    col, r = _col_index(m.group(1)), int(m.group(2))
                    if col >= MAX_COLS or r > MAX_ROWS_PER_SHEET:
                        truncated = True
                        continue
                    t = c.get("t", "n")
                    v = c.find(q("s", "v"))
                    raw = v.text if v is not None and v.text is not None else None
                    if t == "inlineStr":
                        value = normalize("".join(x.text or "" for x in c.iter(q("s", "t"))))
                    elif raw is None:
                        continue
                    elif t == "s":
                        idx = int(raw)
                        value = strings[idx] if 0 <= idx < len(strings) else ""
                    elif t == "b":
                        value = "TRUE" if raw == "1" else "FALSE"
                    elif t in ("str", "e"):
                        value = normalize(raw)
                    else:
                        s_idx = int(c.get("s", 0))
                        value = _fmt_number(raw, styles[s_idx] if s_idx < len(styles) else "")
                    if value:
                        grid.setdefault(r, {})[col] = value.replace("|", "/").replace("\n", " ")
                        cells_total += 1
                if cells_total > MAX_CELLS:
                    truncated = True
                    break
            if truncated:
                warnings.append(f"hoja {name}: truncada a {MAX_ROWS_PER_SHEET} filas / {MAX_COLS} columnas")
            blocks.append(Block("heading", f"Hoja: {name}", level=1, page=page))
            if not grid:
                continue
            cols = sorted({c for r in grid.values() for c in r})
            rows = []
            for r in sorted(grid):
                rows.append("| " + " | ".join(grid[r].get(c, "") for c in cols) + " |")
            rows.insert(1, "| " + " | ".join("---" for _ in cols) + " |")
            blocks.append(Block("table", "\n".join(rows), page=page, meta={"source": "sheet", "sheet": name}))
            if cells_total > MAX_CELLS:
                warnings.append("límite de celdas por documento alcanzado")
                break
    return ParsedDocument("ooxml-xlsx", "1", blocks, page_count=max(page, 1), title=None, warnings=warnings[:20])
