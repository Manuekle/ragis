"""PDF con ReportLab (sin dependencias del sistema: funciona igual en Docker, Lambda y el portátil).

Encabezado de portada en la primera página, cabecera con el título en las siguientes, pie con «Página n de N»,
marcadores (panel lateral del lector) por sección, citas [n] en superíndice que enlazan a la lista de fuentes.
"""

from __future__ import annotations

import io
from functools import lru_cache
from pathlib import Path
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import A4, LETTER
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.pdfmetrics import registerFontFamily
from reportlab.pdfbase.ttfonts import TTFError, TTFont
from reportlab.pdfgen import canvas as rl_canvas
from reportlab.platypus import (
    BaseDocTemplate,
    CondPageBreak,
    Frame,
    HRFlowable,
    KeepTogether,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
    XPreformatted,
)

from ..model import Code, Document, Heading, ListBlock, Quote, Rule, Run, long_date, plain, source_label
from ..model import Paragraph as MdParagraph
from ..model import Table as MdTable
from . import theme as T


def _c(hex_color: str) -> colors.Color:
    return colors.HexColor("#" + hex_color)


_FONT_DIR = Path(__file__).resolve().parent.parent / "fonts"
MONO = "Courier"


@lru_cache(maxsize=1)
def _fonts() -> tuple[str, str, str, str, set[int] | None]:
    """Noto Sans (SIL OFL 1.1, en `documents/fonts`) incrustada y subconjuntada: el PDF se ve igual en cualquier
    visor y cubre tildes, griego, cirílico y símbolos. Si faltan los archivos, Helvetica estándar (no incrustada)."""
    files = {"NotoSans": "Regular", "NotoSans-Bold": "Bold", "NotoSans-Italic": "Italic",
             "NotoSans-BoldItalic": "BoldItalic"}
    try:
        for name, style in files.items():
            if name not in pdfmetrics.getRegisteredFontNames():
                pdfmetrics.registerFont(TTFont(name, str(_FONT_DIR / f"NotoSans-{style}.ttf")))
        registerFontFamily("NotoSans", normal="NotoSans", bold="NotoSans-Bold", italic="NotoSans-Italic",
                           boldItalic="NotoSans-BoldItalic")
        glyphs = set(pdfmetrics.getFont("NotoSans").face.charToGlyph)
        return "NotoSans", "NotoSans-Bold", "NotoSans-Italic", "NotoSans-BoldItalic", glyphs
    except (OSError, TTFError):
        return "Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique", None


def _safe(text: str) -> str:
    glyphs = _fonts()[4]
    if glyphs is None:
        return T.pdf_safe(text)
    return "".join(ch if ord(ch) in glyphs or ch in "\n\t" else T.pdf_safe(ch) for ch in text)


FONT, BOLD, ITALIC, BOLD_ITALIC = _fonts()[:4]


def _styles() -> dict[str, ParagraphStyle]:
    base = ParagraphStyle("body", fontName=FONT, fontSize=10.5, leading=15.5, textColor=_c(T.BODY), spaceAfter=7)
    return {
        "body": base,
        "eyebrow": ParagraphStyle("eyebrow", parent=base, fontName=BOLD, fontSize=8.5, leading=11,
                                  textColor=_c(T.ACCENT_TEXT), spaceAfter=6),
        "title": ParagraphStyle("title", parent=base, fontName=BOLD, fontSize=24, leading=29, textColor=_c(T.INK),
                                spaceAfter=8),
        "lead": ParagraphStyle("lead", parent=base, fontSize=12.5, leading=18.5, textColor=_c(T.INK_2), spaceAfter=10),
        "meta": ParagraphStyle("meta", parent=base, fontSize=8.5, leading=12, textColor=_c(T.MUTED), spaceAfter=0),
        "h1": ParagraphStyle("h1", parent=base, fontName=BOLD, fontSize=15, leading=19, textColor=_c(T.ACCENT_TEXT),
                             spaceBefore=16, spaceAfter=6, keepWithNext=1),
        "h2": ParagraphStyle("h2", parent=base, fontName=BOLD, fontSize=12, leading=16, textColor=_c(T.INK),
                             spaceBefore=11, spaceAfter=4, keepWithNext=1),
        "h3": ParagraphStyle("h3", parent=base, fontName=BOLD, fontSize=10.5, leading=14.5, textColor=_c(T.INK_2),
                             spaceBefore=8, spaceAfter=3, keepWithNext=1),
        "cell": ParagraphStyle("cell", parent=base, fontSize=9, leading=12.2, spaceAfter=0),
        "head": ParagraphStyle("head", parent=base, fontName=BOLD, fontSize=9, leading=12.2, spaceAfter=0,
                               textColor=_c(T.ACCENT_DEEP)),
        "quote": ParagraphStyle("quote", parent=base, fontName=ITALIC, textColor=_c(T.INK_2), spaceAfter=0),
        "code": ParagraphStyle("code", parent=base, fontName=MONO, fontSize=8.5, leading=11.5, spaceAfter=0),
        "source": ParagraphStyle("source", parent=base, fontSize=9, leading=13, leftIndent=20, firstLineIndent=-20,
                                 spaceAfter=4),
        "note": ParagraphStyle("note", parent=base, fontSize=8.5, leading=12, textColor=_c(T.MUTED), spaceAfter=0),
    }


def _txt(text: str) -> str:
    return escape(_safe(text))


def _markup(runs: list[Run] | None, link_cites: bool = True) -> str:
    out: list[str] = []
    for r in runs or []:
        if r.cite is not None:
            mark = f'<font size="7" color="#{T.ACCENT_TEXT}">[{r.cite}]</font>'
            out.append(f'<super><a href="#src{r.cite}">{mark}</a></super>' if link_cites else f"<super>{mark}</super>")
            continue
        s = _txt(r.text)
        if r.code:
            s = f'<font face="{MONO}" size="9">{s}</font>'
        if r.bold:
            s = f"<b>{s}</b>"
        if r.italic:
            s = f"<i>{s}</i>"
        if r.strike:
            s = f"<strike>{s}</strike>"
        if r.href:
            s = f'<a href="{escape(r.href, {chr(34): "&quot;"})}" color="#{T.ACCENT_TEXT}">{s}</a>'
        out.append(s)
    return "".join(out)


class _Bookmarked(Paragraph):
    """Párrafo que registra un marcador del PDF al dibujarse."""

    def __init__(self, text, style, outline: tuple[int, str] | None = None):
        super().__init__(text, style)
        self.outline = outline


class _DocTemplate(BaseDocTemplate):
    def __init__(self, buf, **kw):
        super().__init__(buf, **kw)
        self._outline_level = -1
        self._bm = 0

    def afterFlowable(self, flowable):  # noqa: N802 (API de ReportLab)
        outline = getattr(flowable, "outline", None)
        if not outline:
            return
        level, text = outline
        level = min(level, self._outline_level + 1)
        self._outline_level = level
        self._bm += 1
        key = f"bm{self._bm}"
        self.canv.bookmarkPage(key)
        self.canv.addOutlineEntry(_safe(text)[:120], key, level=level, closed=False)


def _numbered_canvas(doc: Document, page_size):
    lab = doc.labels
    width, height = page_size
    footer_left = _safe(f"{lab['prepared']} · {long_date(doc.created, doc.language)}")
    title = _safe(doc.title)

    class NumberedCanvas(rl_canvas.Canvas):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self._pages: list[dict] = []

        def showPage(self):  # noqa: N802
            self._pages.append(dict(self.__dict__))
            self._startPage()

        def save(self):
            total = len(self._pages)
            for state in self._pages:
                self.__dict__.update(state)
                self._decorate(total)
                super().showPage()
            super().save()

        def _decorate(self, total: int) -> None:
            page = self._pageNumber
            self.saveState()
            self.setFont(FONT, 7.5)
            self.setFillColor(_c(T.MUTED))
            if page > 1:
                shown = title if len(title) <= 95 else title[:94] + "…"
                self.drawString(20 * mm, height - 13 * mm, shown)
                self.setStrokeColor(_c(T.RULE))
                self.setLineWidth(0.5)
                self.line(20 * mm, height - 15 * mm, width - 20 * mm, height - 15 * mm)
            self.setStrokeColor(_c(T.RULE))
            self.setLineWidth(0.5)
            self.line(20 * mm, 15 * mm, width - 20 * mm, 15 * mm)
            self.drawString(20 * mm, 10 * mm, footer_left)
            self.drawRightString(width - 20 * mm, 10 * mm, _safe(f"{lab['page']} {page} {lab['of']} {total}"))
            self.restoreState()

    return NumberedCanvas


def _col_widths(table: MdTable, avail: float) -> list[float]:
    cols = max(len(table.header), *(len(r) for r in table.rows)) if table.rows else len(table.header)
    lengths = []
    for i in range(cols):
        cells = [table.header[i] if i < len(table.header) else []] + [r[i] if i < len(r) else [] for r in table.rows]
        longest = max((len(plain(c)) for c in cells), default=4)
        lengths.append(min(max(longest, 4), 60))
    total = sum(lengths) or 1
    widths = [avail * n / total for n in lengths]
    floor = avail * 0.11
    short = [i for i, w in enumerate(widths) if w < floor]
    if short and len(short) < cols:
        missing = sum(floor - widths[i] for i in short)
        wide = [i for i in range(cols) if i not in short]
        wide_total = sum(widths[i] for i in wide)
        for i in short:
            widths[i] = floor
        for i in wide:
            widths[i] -= missing * widths[i] / wide_total
    return widths


def _table(table: MdTable, st: dict, avail: float) -> Table:
    cols = len(table.header)
    align = {"center": TA_CENTER, "right": TA_RIGHT}

    def style_for(i: int, base: ParagraphStyle) -> ParagraphStyle:
        a = table.align[i] if i < len(table.align) else "left"
        return ParagraphStyle(f"{base.name}{a}", parent=base, alignment=align.get(a, TA_LEFT)) if a != "left" else base

    data = [[Paragraph(_markup(c), style_for(i, st["head"])) for i, c in enumerate(table.header)]]
    for row in table.rows:
        cells = (row + [[]] * cols)[:cols]
        data.append([Paragraph(_markup(c), style_for(i, st["cell"])) for i, c in enumerate(cells)])
    t = Table(data, colWidths=_col_widths(table, avail), repeatRows=1, hAlign="LEFT")
    cmds = [
        ("BACKGROUND", (0, 0), (-1, 0), _c(T.ACCENT_SOFT)),
        ("LINEBELOW", (0, 0), (-1, 0), 1, _c(T.ACCENT)),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("LINEBELOW", (0, 1), (-1, -1), 0.4, _c(T.RULE)),
    ]
    for r in range(1, len(data)):
        if r % 2 == 0:
            cmds.append(("BACKGROUND", (0, r), (-1, r), _c(T.ZEBRA)))
    t.setStyle(TableStyle(cmds))
    return t


def _boxed(flowable, avail: float, *, background: str | None = None, bar: str | None = None) -> Table:
    t = Table([[flowable]], colWidths=[avail], hAlign="LEFT")
    cmds = [("LEFTPADDING", (0, 0), (-1, -1), 10), ("RIGHTPADDING", (0, 0), (-1, -1), 10),
            ("TOPPADDING", (0, 0), (-1, -1), 7), ("BOTTOMPADDING", (0, 0), (-1, -1), 7)]
    if background:
        cmds.append(("BACKGROUND", (0, 0), (-1, -1), _c(background)))
    if bar:
        cmds.append(("LINEBEFORE", (0, 0), (0, -1), 2.2, _c(bar)))
    t.setStyle(TableStyle(cmds))
    return t


def render_pdf(doc: Document, page: str = "A4") -> bytes:
    page_size = LETTER if page.upper() == "LETTER" else A4
    width, height = page_size
    margin = 20 * mm
    avail = width - 2 * margin
    st = _styles()
    lab = doc.labels
    buf = io.BytesIO()
    tpl = _DocTemplate(buf, pagesize=page_size, leftMargin=margin, rightMargin=margin, topMargin=22 * mm,
                       bottomMargin=22 * mm, title=_safe(doc.title), author="Ragis",
                       subject=_safe(lab[doc.kind]), creator="Ragis", lang="es-ES" if doc.language == "es" else "en-US")
    frame = Frame(margin, 22 * mm, avail, height - 44 * mm, id="body", leftPadding=0, rightPadding=0, topPadding=0,
                  bottomPadding=0)
    tpl.addPageTemplates([PageTemplate(id="page", frames=[frame])])

    story: list = [
        Paragraph(_txt(lab[doc.kind].upper()), st["eyebrow"]),
        _Bookmarked(_txt(doc.title), st["title"], outline=(0, doc.title)),
    ]
    if doc.lead:
        story.append(Paragraph(_markup(doc.lead), st["lead"]))
    n_sources = len(doc.sources)
    meta = f"{lab['prepared']} · {long_date(doc.created, doc.language)} · {n_sources} " + (
        lab["sources"].lower() if n_sources != 1 else lab["sources"].lower().rstrip("s"))
    story += [Paragraph(_txt(meta), st["meta"]),
              HRFlowable(width="100%", thickness=1.2, color=_c(T.ACCENT), spaceBefore=10, spaceAfter=14)]

    for b in doc.blocks:
        if isinstance(b, Heading):
            style = st[f"h{b.level}"]
            story.append(_Bookmarked(_markup(b.runs, link_cites=False), style, outline=(b.level, plain(b.runs))))
        elif isinstance(b, MdParagraph):
            story.append(Paragraph(_markup(b.runs), st["body"]))
        elif isinstance(b, ListBlock):
            for it in b.items:
                indent = 14 + it.level * 14
                style = ParagraphStyle(f"li{it.level}", parent=st["body"], leftIndent=indent, bulletIndent=indent - 11,
                                       spaceAfter=3.5)
                bullet = (f'<font color="#{T.ACCENT_TEXT}">{it.number}.</font>' if it.ordered
                          else f'<font color="#{T.ACCENT}">{"•" if it.level == 0 else "–"}</font>')
                story.append(Paragraph(f"<bullet>{bullet}</bullet>{_markup(it.runs)}", style))
            story.append(Spacer(1, 4))
        elif isinstance(b, MdTable):
            story += [Spacer(1, 3), _table(b, st, avail), Spacer(1, 9)]
        elif isinstance(b, Quote):
            story += [_boxed(Paragraph(_markup(b.runs), st["quote"]), avail, bar=T.ACCENT), Spacer(1, 8)]
        elif isinstance(b, Code):
            story += [_boxed(XPreformatted(_txt(b.text), st["code"]), avail, background=T.ZEBRA), Spacer(1, 8)]
        elif isinstance(b, Rule):
            story.append(HRFlowable(width="100%", thickness=0.5, color=_c(T.RULE), spaceBefore=6, spaceAfter=10))

    if doc.sources:
        story += [CondPageBreak(32 * mm), Spacer(1, 6),
                  _Bookmarked(_txt(lab["sources"]), st["h1"], outline=(1, lab["sources"])),
                  Paragraph(_txt(lab["sources_note"]), st["note"]), Spacer(1, 6)]
        for s in doc.sources:
            story.append(Paragraph(f'<a name="src{s.n}"/><b><font color="#{T.ACCENT_TEXT}">[{s.n}]</font></b>&nbsp;&nbsp;'
                                   f"{_txt(source_label(s, doc.language))}", st["source"]))
    note = [Spacer(1, 8), _boxed(Paragraph(_txt(lab["ai_note"]), st["note"]), avail, background=T.ZEBRA)]
    # The note travels with the last source: alone at the top of a new page it would add a page with nothing else.
    story += [KeepTogether([story.pop(), *note])] if doc.sources else [KeepTogether(note)]
    tpl.build(story, canvasmaker=_numbered_canvas(doc, page_size))
    return buf.getvalue()
