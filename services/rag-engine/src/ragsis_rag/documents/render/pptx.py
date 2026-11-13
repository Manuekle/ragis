"""PowerPoint (.pptx) 16:9 con python-pptx.

Cada sección `##` del Markdown es una diapositiva. Portada oscura con el título y la entradilla, diapositivas de
contenido con viñetas (se reparten en «(cont.)» si no caben), tablas nativas editables, pie con las fuentes citadas
en esa diapositiva y número de página, notas del orador con el texto completo y una diapositiva final de fuentes.
Todo se dibuja sobre el diseño en blanco: el resultado se ve igual en PowerPoint, Keynote y Google Slides.
"""

from __future__ import annotations

import io
from dataclasses import dataclass, field

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.oxml.ns import qn
from pptx.util import Emu, Inches, Pt

from ..model import (
    Code,
    Document,
    Heading,
    ListBlock,
    Quote,
    Rule,
    Run,
    cites_in,
    long_date,
    plain,
    short_source,
    source_label,
)
from ..model import Paragraph as MdParagraph
from ..model import Table as MdTable
from . import theme as T

W, H = Inches(13.333), Inches(7.5)
MARGIN = Inches(0.75)
BODY_TOP = Inches(1.8)
BODY_H = Inches(4.75)
MAX_ITEMS = 6            # viñetas por diapositiva antes de partirla
MAX_ROWS = 7             # filas de tabla por diapositiva
MAX_SLIDES = 40


def _rgb(hex_color: str) -> RGBColor:
    return RGBColor(*T.rgb(hex_color))


@dataclass
class _Line:
    runs: list[Run]
    level: int = 0
    kind: str = "bullet"     # bullet | number | text | sub
    number: int = 1


@dataclass
class _Slide:
    title: str
    lines: list[_Line] = field(default_factory=list)
    table: MdTable | None = None


def _plan(doc: Document) -> list[_Slide]:
    """Agrupa los bloques en diapositivas: una por sección de primer nivel, partidas si no caben."""
    lab = doc.labels
    raw: list[_Slide] = []
    current: _Slide | None = None

    def ensure() -> _Slide:
        nonlocal current
        if current is None:
            current = _Slide(lab["overview"])
            raw.append(current)
        return current

    for b in doc.blocks:
        if isinstance(b, Heading) and b.level == 1:
            current = _Slide(plain([r for r in b.runs if r.cite is None]))
            raw.append(current)
        elif isinstance(b, Heading):
            ensure().lines.append(_Line([r for r in b.runs if r.cite is None], 0, "sub"))
        elif isinstance(b, MdParagraph | Quote):
            ensure().lines.append(_Line(b.runs, 0, "text"))
        elif isinstance(b, ListBlock):
            for it in b.items:
                ensure().lines.append(_Line(it.runs, min(it.level, 2), "number" if it.ordered else "bullet", it.number))
        elif isinstance(b, MdTable):
            s = ensure()
            if s.table is not None or s.lines:
                # Una tabla va en su propia diapositiva (con el mismo título) para que se lea bien.
                current = _Slide(s.title, table=b)
                raw.append(current)
            else:
                s.table = b
        elif isinstance(b, Code):
            ensure().lines.append(_Line([Run(b.text, code=True)], 0, "text"))
        elif isinstance(b, Rule):
            continue

    slides: list[_Slide] = []
    for s in raw:
        if s.table is not None:
            rows = s.table.rows or [[]]
            for i in range(0, len(rows), MAX_ROWS):
                part = MdTable(s.table.header, rows[i:i + MAX_ROWS], s.table.align)
                slides.append(_Slide(s.title if i == 0 else f"{s.title} {lab['continued']}", s.lines if i == 0 else [],
                                     part))
            continue
        if not s.lines:
            continue
        chunks: list[list[_Line]] = []
        chunk: list[_Line] = []
        weight = 0
        for line in s.lines:
            w = 1 + len(plain(line.runs)) // 110
            if chunk and (weight + w > MAX_ITEMS + 1 or len(chunk) >= MAX_ITEMS + (line.level > 0)):
                chunks.append(chunk)
                chunk, weight = [], 0
            chunk.append(line)
            weight += w
        if chunk:
            chunks.append(chunk)
        for i, c in enumerate(chunks):
            slides.append(_Slide(s.title if i == 0 else f"{s.title} {lab['continued']}", c))
    return slides[:MAX_SLIDES]


def plan_slides(doc: Document) -> int:
    """Número de diapositivas que tendrá la presentación (portada + contenido + fuentes), sin dibujarla."""
    return 1 + len(_plan(doc)) + (1 if doc.sources else 0)


def _box(slide, x, y, w, h, *, anchor=MSO_ANCHOR.TOP):
    tb = slide.shapes.add_textbox(x, y, w, h)
    tf = tb.text_frame
    tf.word_wrap = True
    tf.auto_size = None
    tf.vertical_anchor = anchor
    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    return tb, tf


def _font(run, size: float, color: str, bold: bool = False, italic: bool = False, name: str = T.BODY_FONT) -> None:
    run.font.size = Pt(size)
    run.font.color.rgb = _rgb(color)
    run.font.bold = bold
    run.font.italic = italic
    run.font.name = name


def _write_runs(paragraph, runs: list[Run], size: float, color: str, *, bold: bool = False) -> None:
    for r in runs:
        run = paragraph.add_run()
        if r.cite is not None:
            run.text = f"[{r.cite}]"
            _font(run, size * 0.62, T.ACCENT_TEXT, bold=False)
            run.font._rPr.set("baseline", "30000")
            continue
        run.text = r.text
        _font(run, size, color, bold=bold or r.bold, italic=r.italic,
              name=T.MONO_FONT if r.code else T.BODY_FONT)
        if r.href:
            run.hyperlink.address = r.href


def _bullet(paragraph, level: int, char: str | None, color: str, size: float) -> None:
    ppr = paragraph._p.get_or_add_pPr()
    indent = Emu(Inches(0.32))
    ppr.set("marL", str(int(indent * (level + 1))))
    ppr.set("indent", str(-int(indent)))
    for tag in ("a:buNone", "a:buChar", "a:buAutoNum", "a:buClr", "a:buSzPct", "a:buFont"):
        for el in ppr.findall(qn(tag)):
            ppr.remove(el)
    if char is None:
        ppr.set("marL", "0")
        ppr.set("indent", "0")
        ppr.append(ppr.makeelement(qn("a:buNone"), {}))
        return
    clr = ppr.makeelement(qn("a:buClr"), {})
    srgb = clr.makeelement(qn("a:srgbClr"), {"val": color})
    clr.append(srgb)
    ppr.append(clr)
    ppr.append(ppr.makeelement(qn("a:buSzPct"), {"val": "100000"}))
    ppr.append(ppr.makeelement(qn("a:buFont"), {"typeface": "Arial"}))
    ppr.append(ppr.makeelement(qn("a:buChar"), {"char": char}))


def _number(paragraph, level: int, number: int, color: str) -> None:
    ppr = paragraph._p.get_or_add_pPr()
    indent = int(Emu(Inches(0.42)))
    ppr.set("marL", str(indent * (level + 1)))
    ppr.set("indent", str(-indent))
    clr = ppr.makeelement(qn("a:buClr"), {})
    clr.append(clr.makeelement(qn("a:srgbClr"), {"val": color}))
    ppr.append(clr)
    ppr.append(ppr.makeelement(qn("a:buFont"), {"typeface": "+mj-lt"}))
    ppr.append(ppr.makeelement(qn("a:buAutoNum"), {"type": "arabicPeriod", "startAt": str(number)}))


def _rect(slide, x, y, w, h, color: str):
    shape = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, x, y, w, h)
    shape.fill.solid()
    shape.fill.fore_color.rgb = _rgb(color)
    shape.line.fill.background()
    shape.shadow.inherit = False
    return shape


def _footer(slide, doc: Document, number: int, total: int, cited: list[int]) -> None:
    lab = doc.labels
    # Passages of the same document and page share one entry: «[2][3][5] Política de viáticos, p. 1».
    groups: dict[str, list[int]] = {}
    for src in (x for x in doc.sources if x.n in cited):
        groups.setdefault(short_source(src, doc.language), []).append(src.n)
    if groups:
        items = list(groups.items())
        text = f"{lab['sources']}: " + "  ·  ".join("".join(f"[{n}]" for n in ns) + f" {name}" for name, ns in items[:3])
        if len(items) > 3:
            text += "  ·  …"
        _, tf = _box(slide, MARGIN, Inches(6.88), Inches(10.6), Inches(0.3), anchor=MSO_ANCHOR.MIDDLE)
        p = tf.paragraphs[0]
        run = p.add_run()
        run.text = text if len(text) <= 170 else text[:169] + "…"
        _font(run, 9.5, T.MUTED)
    _, tf = _box(slide, W - MARGIN - Inches(1.2), Inches(6.88), Inches(1.2), Inches(0.3), anchor=MSO_ANCHOR.MIDDLE)
    p = tf.paragraphs[0]
    p.alignment = PP_ALIGN.RIGHT
    run = p.add_run()
    run.text = f"{number} / {total}"
    _font(run, 9.5, T.MUTED)


def _title(slide, text: str) -> None:
    _, tf = _box(slide, MARGIN, Inches(0.55), W - 2 * MARGIN, Inches(0.9), anchor=MSO_ANCHOR.BOTTOM)
    p = tf.paragraphs[0]
    run = p.add_run()
    run.text = text
    _font(run, 30 if len(text) <= 48 else 26 if len(text) <= 70 else 22, T.INK, bold=True)
    _rect(slide, MARGIN, Inches(1.52), Inches(0.9), Inches(0.06), T.ACCENT)


def _notes(slide, s: _Slide, doc: Document, cited: list[int]) -> None:
    lines = [s.title]
    lines += [("  " * ln.level) + ("• " if ln.kind == "bullet" else "") + plain(ln.runs) for ln in s.lines]
    if s.table:
        lines.append(" | ".join(plain(c) for c in s.table.header))
        lines += [" | ".join(plain(c) for c in row) for row in s.table.rows]
    srcs = [src for src in doc.sources if src.n in cited]
    if srcs:
        lines += ["", f"{doc.labels['sources']}:"] + [f"[{x.n}] {source_label(x, doc.language)}" for x in srcs]
    slide.notes_slide.notes_text_frame.text = "\n".join(lines)


def _content(slide, s: _Slide) -> None:
    total_chars = sum(len(plain(ln.runs)) for ln in s.lines)
    size = 20 if total_chars <= 380 and len(s.lines) <= 5 else 18 if total_chars <= 620 else 16
    top = BODY_TOP
    height = BODY_H if not s.table else Inches(1.1)
    _, tf = _box(slide, MARGIN, top, W - 2 * MARGIN, height)
    first = True
    for ln in s.lines:
        p = tf.paragraphs[0] if first else tf.add_paragraph()
        first = False
        p.space_after = Pt(10 if ln.level == 0 else 6)
        p.line_spacing = 1.1
        if ln.kind == "sub":
            _bullet(p, 0, None, T.ACCENT, size)
            _write_runs(p, ln.runs, size, T.ACCENT_TEXT, bold=True)
        elif ln.kind == "text":
            _bullet(p, 0, None, T.ACCENT, size)
            _write_runs(p, ln.runs, size, T.INK_2)
        elif ln.kind == "number":
            _number(p, ln.level, ln.number, T.ACCENT_TEXT)
            _write_runs(p, ln.runs, size - 2 * ln.level, T.BODY)
        else:
            _bullet(p, ln.level, "•" if ln.level == 0 else "–", T.ACCENT, size)
            _write_runs(p, ln.runs, size - 2 * ln.level, T.BODY)


def _table(slide, t: MdTable, top) -> None:
    cols = len(t.header)
    rows = len(t.rows) + 1
    width = W - 2 * MARGIN
    avail_h = Inches(6.6) - top
    row_h = min(Inches(0.62), int(avail_h / rows))
    gf = slide.shapes.add_table(rows, cols, MARGIN, top, width, row_h * rows)
    table = gf.table
    # Sin el estilo con bandas por defecto de PowerPoint: colores propios.
    tbl_pr = gf._element.graphic.graphicData.tbl.tblPr
    tbl_pr.set("bandRow", "0")
    tbl_pr.set("firstRow", "1")
    lengths = []
    for i in range(cols):
        cells = [t.header[i]] + [r[i] if i < len(r) else [] for r in t.rows]
        lengths.append(min(max((len(plain(c)) for c in cells), default=4), 50) + 6)
    total = sum(lengths)
    for i, n in enumerate(lengths):
        table.columns[i].width = int(width * n / total)
    size = 14 if rows <= 5 and cols <= 3 else 12 if rows <= 7 else 11
    for r in range(rows):
        table.rows[r].height = row_h
        for c in range(cols):
            cell = table.cell(r, c)
            runs = t.header[c] if r == 0 else ((t.rows[r - 1] + [[]] * cols)[:cols][c])
            cell.fill.solid()
            cell.fill.fore_color.rgb = _rgb(T.ACCENT_SOFT if r == 0 else (T.ZEBRA if r % 2 == 0 else "FFFFFF"))
            cell.margin_left = cell.margin_right = Inches(0.1)
            cell.margin_top = cell.margin_bottom = Inches(0.05)
            cell.vertical_anchor = MSO_ANCHOR.MIDDLE
            tf = cell.text_frame
            tf.word_wrap = True
            p = tf.paragraphs[0]
            align = t.align[c] if c < len(t.align) else "left"
            p.alignment = {"center": PP_ALIGN.CENTER, "right": PP_ALIGN.RIGHT}.get(align, PP_ALIGN.LEFT)
            _write_runs(p, runs, size, T.ACCENT_DEEP if r == 0 else T.BODY, bold=r == 0)


def render_pptx(doc: Document) -> bytes:
    prs = Presentation()
    prs.slide_width, prs.slide_height = W, H
    blank = prs.slide_layouts[6]
    lab = doc.labels
    plan = _plan(doc)
    total = len(plan) + 1 + (1 if doc.sources else 0)

    # Portada
    cover = prs.slides.add_slide(blank)
    cover.background.fill.solid()
    cover.background.fill.fore_color.rgb = _rgb(T.NIGHT)
    _rect(cover, 0, 0, Inches(0.22), H, T.ACCENT)
    _, tf = _box(cover, Inches(1.1), Inches(1.55), Inches(10.6), Inches(0.4))
    run = tf.paragraphs[0].add_run()
    run.text = lab[doc.kind].upper()
    _font(run, 13, T.ACCENT, bold=True)
    run.font._rPr.set("spc", "300")
    _, tf = _box(cover, Inches(1.1), Inches(2.05), Inches(10.8), Inches(2.3), anchor=MSO_ANCHOR.TOP)
    run = tf.paragraphs[0].add_run()
    run.text = doc.title
    size = 44 if len(doc.title) <= 45 else 36 if len(doc.title) <= 80 else 30
    _font(run, size, "FFFFFF", bold=True)
    tf.paragraphs[0].line_spacing = 0.95
    if doc.lead:
        # The subtitle sits under the title's last line (about 0.55 em per character on a 10.8" line), not at a fixed
        # height that leaves a gap under a one-line title.
        lines = min(3, -(-len(doc.title) * size * 0.55 // (10.8 * 72)))
        lead_top = Inches(2.05) + Pt(size * 1.05 * lines) + Inches(0.45)
        _, tf = _box(cover, Inches(1.1), lead_top, Inches(10.2), Inches(1.3))
        _write_runs(tf.paragraphs[0], doc.lead, 18, T.NIGHT_TEXT)
    _, tf = _box(cover, Inches(1.1), Inches(6.55), Inches(10), Inches(0.4), anchor=MSO_ANCHOR.MIDDLE)
    run = tf.paragraphs[0].add_run()
    run.text = f"{lab['prepared']}  ·  {long_date(doc.created, doc.language)}"
    _font(run, 12, T.NIGHT_TEXT)
    cover.notes_slide.notes_text_frame.text = doc.title + ("\n" + plain(doc.lead) if doc.lead else "")

    for i, s in enumerate(plan, start=2):
        slide = prs.slides.add_slide(blank)
        _title(slide, s.title)
        cited = [n for ln in s.lines for n in cites_in(ln.runs)]
        if s.lines:
            _content(slide, s)
        if s.table is not None:
            _table(slide, s.table, BODY_TOP + (Inches(1.25) if s.lines else 0))
            cited += [n for row in s.table.rows for cell in row for n in cites_in(cell)]
        cited = list(dict.fromkeys(cited))
        _footer(slide, doc, i, total, cited)
        _notes(slide, s, doc, cited)

    if doc.sources:
        slide = prs.slides.add_slide(blank)
        _title(slide, lab["sources"])
        two_cols = len(doc.sources) > 7
        per_col = (len(doc.sources) + 1) // 2 if two_cols else len(doc.sources)
        col_w = (W - 2 * MARGIN - Inches(0.4)) / (2 if two_cols else 1)
        for col in range(2 if two_cols else 1):
            part = doc.sources[col * per_col:(col + 1) * per_col]
            if not part:
                continue
            _, tf = _box(slide, MARGIN + col * (col_w + Inches(0.4)), BODY_TOP, col_w, BODY_H)
            for j, src in enumerate(part):
                p = tf.paragraphs[0] if j == 0 else tf.add_paragraph()
                p.space_after = Pt(8)
                r1 = p.add_run()
                r1.text = f"[{src.n}]  "
                _font(r1, 13 if two_cols else 15, T.ACCENT_TEXT, bold=True)
                r2 = p.add_run()
                r2.text = source_label(src, doc.language)
                _font(r2, 13 if two_cols else 15, T.BODY)
        _, tf = _box(slide, MARGIN, Inches(6.4), W - 2 * MARGIN, Inches(0.4))
        run = tf.paragraphs[0].add_run()
        run.text = lab["ai_note"]
        _font(run, 10, T.MUTED, italic=True)
        _footer(slide, doc, total, total, [])

    props = prs.core_properties
    props.title = doc.title
    props.author = "Ragis"
    props.subject = lab[doc.kind]
    props.comments = lab["generated"]
    props.language = "es-ES" if doc.language == "es" else "en-US"
    buf = io.BytesIO()
    prs.save(buf)
    return buf.getvalue()

