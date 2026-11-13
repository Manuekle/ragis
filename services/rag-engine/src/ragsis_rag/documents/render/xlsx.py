"""Excel (.xlsx) con openpyxl.

Una hoja por tabla del documento, como tabla nativa de Excel (filtros y orden, encabezado fijo al desplazarse y
repetido al imprimir; cebra y líneas con los colores de la marca), con el título arriba y una columna «Fuente» con
el nombre legible de cada documento citado. Si el documento tiene texto además de tablas, una hoja «Contenido» lo
recoge (sección, texto, fuentes); al final, la hoja «Fuentes» con la lista completa y el aviso de IA.

Las celdas que son claramente números («$120.000», «45», «12,5 %») se guardan como números con su formato, para que
se puedan sumar y ordenar; la lectura sigue el idioma del documento (en español «1.234» es mil doscientos treinta y
cuatro). Códigos con ceros a la izquierda, identificadores largos y cualquier cosa con texto quedan como texto.

Seguridad: todo el texto se escribe con tipo cadena, así que «=HYPERLINK(…)» o «@SUM(…)» se ven como texto y Excel
nunca los evalúa como fórmula. No hay enlaces externos, imágenes ni conexiones de datos.
"""

from __future__ import annotations

import io
import re

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.table import Table as XlTable
from openpyxl.worksheet.table import TableStyleInfo

from ..model import Document, Heading, ListBlock, Quote, long_date, plain
from ..model import Paragraph as MdParagraph
from ..model import Table as MdTable
from . import theme as T
from .csv import _text, content_rows, table_rows

HEADER_ROW = 4            # filas 1-2: título y contexto; 3: aire; 4: encabezado de la tabla
MAX_SHEETS = 30
MAX_WIDTH = 60
_INVALID_SHEET = re.compile(r"[\[\]:*?/\\]")
_NUM = {
    "es": re.compile(r"^(?P<sign>[-+])?\s?(?P<cur>[$€£])?\s?(?P<int>\d{1,3}(?:\.\d{3})+|\d+)(?:,(?P<dec>\d+))?\s?(?P<pct>%)?$"),
    "en": re.compile(r"^(?P<sign>[-+])?\s?(?P<cur>[$€£])?\s?(?P<int>\d{1,3}(?:,\d{3})+|\d+)(?:\.(?P<dec>\d+))?\s?(?P<pct>%)?$"),
}

_TITLE = Font(name=T.BODY_FONT, size=15, bold=True, color=T.INK)
_SUBTITLE = Font(name=T.BODY_FONT, size=10, color=T.MUTED)
_HEADER = Font(name=T.BODY_FONT, size=11, bold=True, color=T.ACCENT_DEEP)
_BODY = Font(name=T.BODY_FONT, size=11, color=T.BODY)
_SOURCE = Font(name=T.BODY_FONT, size=10, color=T.MUTED)
_CITE = Font(name=T.BODY_FONT, size=11, bold=True, color=T.ACCENT_TEXT)
_NOTE = Font(name=T.BODY_FONT, size=9, italic=True, color=T.MUTED)
_HEADER_FILL = PatternFill("solid", fgColor=T.ACCENT_SOFT)
_HEADER_BORDER = Border(bottom=Side(style="medium", color=T.ACCENT))
_ROW_BORDER = Border(bottom=Side(style="thin", color=T.RULE))
_ZEBRA = PatternFill("solid", fgColor=T.ZEBRA)
_TOP = Alignment(vertical="top", wrap_text=True)
_TOP_RIGHT = Alignment(vertical="top", horizontal="right")


def number(text: str, language: str) -> tuple[float | int, str] | None:
    """(valor, formato de Excel) si la celda es claramente un número; None si debe quedar como texto."""
    m = _NUM["es" if language == "es" else "en"].match(text.strip())
    if not m:
        return None
    digits = re.sub(r"[.,]", "", m["int"])
    grouped = digits != m["int"]
    if (len(digits) > 1 and digits.startswith("0") and not m["dec"]) or len(digits) > 15:
        return None                      # «007», NIT, teléfonos: son códigos, no cantidades
    value: float | int = float(f"{digits}.{m['dec']}") if m["dec"] else int(digits)
    if m["sign"] == "-":
        value = -value
    decimals = "." + "0" * min(len(m["dec"]), 4) if m["dec"] else ""
    fmt = ("#,##0" if grouped or m["cur"] else "0") + decimals
    if m["pct"]:
        return value / 100, "0" + decimals + "%"
    if m["cur"]:
        fmt = f'"{m["cur"]}"{fmt}'
    return value, fmt


def _sheet_name(raw: str, used: set[str], fallback: str) -> str:
    name = re.sub(r"\s+", " ", _INVALID_SHEET.sub(" ", raw)).strip(" '") or fallback
    if len(name) > 31:
        # Excel allows 31 characters: cut at a word boundary, not in the middle of one («…viáticos, ho»).
        cut = name[:32].rsplit(" ", 1)[0] if " " in name[:32] else name[:31]
        name = cut.rstrip(" ,;:-·") or name[:31]
    base, i = name, 2
    while name.lower() in used:
        suffix = f" ({i})"
        name = base[:31 - len(suffix)].rstrip() + suffix
        i += 1
    used.add(name.lower())
    return name


def _text_cell(ws, row: int, col: int, value: str, font: Font, align: Alignment = _TOP):
    cell = ws.cell(row=row, column=col)
    cell.value = value
    # Siempre cadena: un texto que empieza con «=» o «@» nunca se convierte en fórmula.
    cell.data_type = "s"
    cell.font = font
    cell.alignment = align
    return cell


def _unique_headers(header: list[str], fallback: str) -> list[str]:
    """Una tabla de Excel exige encabezados distintos y no vacíos."""
    out: list[str] = []
    seen: set[str] = set()
    for i, h in enumerate(header, start=1):
        name = h.strip() or f"{fallback} {i}"
        base, n = name, 2
        while name.lower() in seen:
            name, n = f"{base} {n}", n + 1
        seen.add(name.lower())
        out.append(name)
    return out


def _header_block(ws, title: str, subtitle: str) -> None:
    _text_cell(ws, 1, 1, title, _TITLE, Alignment(vertical="center"))
    ws.row_dimensions[1].height = 24
    _text_cell(ws, 2, 1, subtitle, _SUBTITLE, Alignment(vertical="center"))


def _grid(ws, rows: list[list[str]], *, doc: Document, table_id: int, source_cols: set[int],
          wide_cols: set[int] = frozenset(), numbers: bool = True) -> None:
    """Encabezado + filas desde HEADER_ROW, como tabla nativa de Excel, con anchos y formato."""
    header = _unique_headers(rows[0], doc.labels["content"])
    body = rows[1:]
    ncols = len(header)
    for c, h in enumerate(header, start=1):
        cell = _text_cell(ws, HEADER_ROW, c, h, _HEADER, Alignment(vertical="center", wrap_text=True))
        cell.fill = _HEADER_FILL
        cell.border = _HEADER_BORDER
    ws.row_dimensions[HEADER_ROW].height = 22
    widths = [len(h) for h in header]
    for r, row in enumerate(body, start=HEADER_ROW + 1):
        for c, value in enumerate((row + [""] * ncols)[:ncols], start=1):
            widths[c - 1] = max(widths[c - 1], max((len(line) for line in value.split("\n")), default=0))
            parsed = number(value, doc.language) if numbers and c - 1 not in source_cols else None
            if parsed:
                cell = ws.cell(row=r, column=c, value=parsed[0])
                cell.number_format = parsed[1]
                cell.font = _BODY
                cell.alignment = _TOP_RIGHT
            else:
                cell = _text_cell(ws, r, c, value, _SOURCE if c - 1 in source_cols else _BODY)
            # Same look as the PDF: soft zebra and hairlines, drawn on the cells (the table itself has no style, so
            # Excel's default blue/gray bands and black rules don't override the brand).
            cell.border = _ROW_BORDER
            if (r - HEADER_ROW) % 2 == 0:
                cell.fill = _ZEBRA
    for c, w in enumerate(widths, start=1):
        limit = MAX_WIDTH if (c - 1) in wide_cols else 45
        ws.column_dimensions[get_column_letter(c)].width = max(10, min(limit, round(w * 1.1) + 3))
    last = get_column_letter(ncols)
    if body:
        tab = XlTable(displayName=f"Ragis{table_id}", ref=f"A{HEADER_ROW}:{last}{HEADER_ROW + len(body)}")
        tab.tableStyleInfo = TableStyleInfo(name=None, showRowStripes=False, showColumnStripes=False,
                                            showFirstColumn=False, showLastColumn=False)
        ws.add_table(tab)
    ws.freeze_panes = f"A{HEADER_ROW + 1}"
    ws.print_title_rows = f"{HEADER_ROW}:{HEADER_ROW}"


def _page(ws, doc: Document, ncols: int, page: str) -> None:
    ws.sheet_view.showGridLines = False
    ws.page_setup.orientation = "landscape" if ncols > 4 else "portrait"
    ws.page_setup.paperSize = ws.PAPERSIZE_LETTER if page.upper() == "LETTER" else ws.PAPERSIZE_A4
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 0
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.oddFooter.left.text = f"{doc.labels['prepared']} · {long_date(doc.created, doc.language)}"
    ws.oddFooter.left.size = 8
    ws.oddFooter.right.text = f"{doc.labels['page']} &P {doc.labels['of']} &N"
    ws.oddFooter.right.size = 8


def _tables_with_titles(doc: Document) -> list[tuple[str, MdTable]]:
    """Cada tabla con el título de la sección en la que aparece."""
    out: list[tuple[str, MdTable]] = []
    section = ""
    for b in doc.blocks:
        if isinstance(b, Heading):
            section = plain([r for r in b.runs if r.cite is None])
        elif isinstance(b, MdTable):
            out.append((section, b))
    return out


def render_xlsx(doc: Document, page: str = "A4") -> bytes:
    lab = doc.labels
    wb = Workbook()
    wb.remove(wb.active)
    used: set[str] = set()
    subtitle = f"{doc.title} · {lab['prepared']} · {long_date(doc.created, doc.language)}"
    table_id = 0

    tables = _tables_with_titles(doc)
    # Text besides the lead gets its own sheet; a lone lead (the usual one-line description of a table) goes under
    # the first table's title instead of filling a sheet with one row.
    has_text = any(isinstance(b, MdParagraph | ListBlock | Quote) for b in doc.blocks) or (doc.lead and not tables)
    lead = _text(doc.lead) if doc.lead and not has_text else ""
    for i, (section, t) in enumerate(tables[:MAX_SHEETS], start=1):
        rows, src = table_rows(t, doc)
        title = section or (doc.title if len(tables) == 1 else f"{lab['table']} {i}")
        ws = wb.create_sheet(_sheet_name(title, used, f"{lab['table']} {i}"))
        ws.sheet_properties.tabColor = T.ACCENT
        context = subtitle if section else f"{lab['prepared']} · {long_date(doc.created, doc.language)}"
        _header_block(ws, title, lead if i == 1 and lead else context)
        table_id += 1
        _grid(ws, rows, doc=doc, table_id=table_id, source_cols={src})
        _page(ws, doc, len(rows[0]), page)

    if has_text or not tables:
        rows = content_rows(doc)
        ws = wb.create_sheet(_sheet_name(lab["content"], used, "Content"), 0 if not tables else None)
        _header_block(ws, doc.title, f"{lab['prepared']} · {long_date(doc.created, doc.language)}")
        table_id += 1
        _grid(ws, rows, doc=doc, table_id=table_id, source_cols={2}, wide_cols={1}, numbers=False)
        _page(ws, doc, 3, page)

    if doc.sources:
        ws = wb.create_sheet(_sheet_name(lab["sources"], used, "Sources"))
        ws.sheet_properties.tabColor = T.MUTED
        _header_block(ws, lab["sources"], doc.title)
        heads = ["#", lab["document"], lab["version_col"], lab["page"], lab["section"], lab["effective_col"]]
        if any(s.t_start is not None for s in doc.sources):
            heads.append(lab["time_col"])
        rows = [heads]
        for s in doc.sources:
            row = [f"[{s.n}]", s.title, str(s.version_no or ""), str(s.page or ""), s.section, s.effective_from or ""]
            if len(heads) > 6:
                m, sec = divmod(int(s.t_start or 0), 60)
                row.append(f"{m:02d}:{sec:02d}" if s.t_start is not None else "")
            rows.append(row)
        table_id += 1
        _grid(ws, rows, doc=doc, table_id=table_id, source_cols=set(range(len(heads))), wide_cols={1, 4},
              numbers=False)
        for r in range(HEADER_ROW + 1, HEADER_ROW + 1 + len(doc.sources)):
            ws.cell(row=r, column=1).font = _CITE
            ws.cell(row=r, column=2).font = _BODY
        ws.column_dimensions["A"].width = 7
        note_row = HEADER_ROW + len(doc.sources) + 2
        _text_cell(ws, note_row, 1, lab["ai_note"], _NOTE, Alignment(vertical="top"))
        _page(ws, doc, len(heads), page)

    if not wb.worksheets:               # documento vacío: el verificador lo impide, pero el libro nunca sale sin hojas
        wb.create_sheet(_sheet_name(doc.title, used, "Document"))
    wb.active = 0
    props = wb.properties
    props.title = doc.title
    props.creator = "Ragis"
    props.subject = lab[doc.kind]
    props.description = lab["generated"]
    props.language = "es-ES" if doc.language == "es" else "en-US"
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
