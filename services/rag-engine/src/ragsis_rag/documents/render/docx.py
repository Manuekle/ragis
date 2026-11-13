"""Word (.docx) con python-docx: estilos reales de Word (Título, Título 1–3, listas), así que el panel de navegación,
el índice automático y el corrector ortográfico (idioma del documento) funcionan al abrirlo. Citas en superíndice que
enlazan a la lista de fuentes, tablas con cabecera que se repite en cada página y pie con «Página X de Y»."""

from __future__ import annotations

import io
from datetime import UTC, datetime

from docx import Document as new_docx
from docx.enum.section import WD_SECTION
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_TAB_ALIGNMENT
from docx.opc.constants import RELATIONSHIP_TYPE as RT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

from ..model import Code, Document, Heading, ListBlock, Quote, Rule, Run, long_date, plain, source_label
from ..model import Paragraph as MdParagraph
from ..model import Table as MdTable
from . import theme as T

_ALIGN = {"left": WD_ALIGN_PARAGRAPH.LEFT, "center": WD_ALIGN_PARAGRAPH.CENTER, "right": WD_ALIGN_PARAGRAPH.RIGHT}


def _color(hex_color: str) -> RGBColor:
    return RGBColor(*T.rgb(hex_color))


def _set_font(rpr_owner, name: str) -> None:
    """Fija la fuente en todos los alfabetos y quita la fuente del tema (si no, Word sigue usando la del tema)."""
    rpr = rpr_owner.get_or_add_rPr()
    fonts = rpr.find(qn("w:rFonts"))
    if fonts is None:
        fonts = OxmlElement("w:rFonts")
        rpr.insert(0, fonts)
    for attr in ("w:asciiTheme", "w:hAnsiTheme", "w:eastAsiaTheme", "w:cstheme"):
        fonts.attrib.pop(qn(attr), None)
    for attr in ("w:ascii", "w:hAnsi", "w:eastAsia", "w:cs"):
        fonts.set(qn(attr), name)


def _style(doc, name: str, *, size: float, color: str, bold: bool = False, italic: bool = False,
           before: float = 0, after: float = 6, keep_next: bool = False, font: str = T.BODY_FONT):
    st = doc.styles[name]
    st.font.size = Pt(size)
    st.font.bold = bold
    st.font.italic = italic
    st.font.color.rgb = _color(color)
    _set_font(st.element, font)
    pf = st.paragraph_format
    pf.space_before = Pt(before)
    pf.space_after = Pt(after)
    pf.keep_with_next = keep_next
    ppr = st.element.get_or_add_pPr()
    border = ppr.find(qn("w:pBdr"))
    if border is not None:
        ppr.remove(border)
    return st


_PPR = ["pStyle", "keepNext", "keepLines", "pageBreakBefore", "framePr", "widowControl", "numPr", "suppressLineNumbers",
        "pBdr", "shd", "tabs", "suppressAutoHyphens", "kinsoku", "wordWrap", "overflowPunct", "topLinePunct",
        "autoSpaceDE", "autoSpaceDN", "bidi", "adjustRightInd", "snapToGrid", "spacing", "ind", "contextualSpacing",
        "mirrorIndents", "suppressOverlap", "jc", "textDirection", "textAlignment", "textboxTightWrap", "outlineLvl",
        "divId", "cnfStyle", "rPr", "sectPr", "pPrChange"]
_TCPR = ["cnfStyle", "tcW", "gridSpan", "hMerge", "vMerge", "tcBorders", "shd", "noWrap", "tcMar", "textDirection",
         "tcFitText", "vAlign", "hideMark"]
_TBLPR = ["tblStyle", "tblpPr", "tblOverlap", "bidiVisual", "tblStyleRowBandSize", "tblStyleColBandSize", "tblW", "jc",
          "tblCellSpacing", "tblInd", "tblBorders", "shd", "tblLayout", "tblCellMar", "tblLook"]


def _put(parent, el, order: list[str]):
    """Inserta `el` respetando el orden del esquema OOXML (Word rechaza el archivo si los hijos van desordenados)."""
    tag = el.tag.split("}")[1]
    existing = parent.find(qn(f"w:{tag}"))
    if existing is not None:
        parent.remove(existing)
    for successor in order[order.index(tag) + 1:]:
        found = parent.find(qn(f"w:{successor}"))
        if found is not None:
            found.addprevious(el)
            return el
    parent.append(el)
    return el


def _shade(element, fill: str) -> None:
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), fill)
    if hasattr(element, "get_or_add_tcPr"):
        _put(element.get_or_add_tcPr(), shd, _TCPR)
    else:
        _put(element.get_or_add_pPr(), shd, _PPR)


def _border(paragraph, side: str, color: str, size: int = 12, space: int = 8) -> None:
    ppr = paragraph._p.get_or_add_pPr()
    bdr = ppr.find(qn("w:pBdr"))
    if bdr is None:
        bdr = _put(ppr, OxmlElement("w:pBdr"), _PPR)
    el = OxmlElement(f"w:{side}")
    el.set(qn("w:val"), "single")
    el.set(qn("w:sz"), str(size))
    el.set(qn("w:space"), str(space))
    el.set(qn("w:color"), color)
    _put(bdr, el, ["top", "left", "bottom", "right", "between", "bar"])


def _field(paragraph, instr: str, size: float, color: str) -> None:
    fld = OxmlElement("w:fldSimple")
    fld.set(qn("w:instr"), instr)
    r = OxmlElement("w:r")
    rpr = OxmlElement("w:rPr")
    sz = OxmlElement("w:sz")
    sz.set(qn("w:val"), str(int(size * 2)))
    col = OxmlElement("w:color")
    col.set(qn("w:val"), color)
    rpr.extend([col, sz])
    t = OxmlElement("w:t")
    t.text = "1"
    r.extend([rpr, t])
    fld.append(r)
    paragraph._p.append(fld)


def _bookmark(paragraph, name: str, bid: int) -> None:
    start = OxmlElement("w:bookmarkStart")
    start.set(qn("w:id"), str(bid))
    start.set(qn("w:name"), name)
    end = OxmlElement("w:bookmarkEnd")
    end.set(qn("w:id"), str(bid))
    ppr = paragraph._p.pPr
    if ppr is not None:
        ppr.addnext(start)          # w:pPr siempre es el primer hijo del párrafo
    else:
        paragraph._p.insert(0, start)
    paragraph._p.append(end)


def _link_run(paragraph, text: str, *, url: str | None = None, anchor: str | None = None, color: str = T.ACCENT_TEXT,
              size: float | None = None, superscript: bool = False, underline: bool = False, bold: bool = False) -> None:
    link = OxmlElement("w:hyperlink")
    if url:
        link.set(qn("r:id"), paragraph.part.relate_to(url, RT.HYPERLINK, is_external=True))
    if anchor:
        link.set(qn("w:anchor"), anchor)
    r = OxmlElement("w:r")
    rpr = OxmlElement("w:rPr")
    if bold:
        rpr.append(OxmlElement("w:b"))
    col = OxmlElement("w:color")
    col.set(qn("w:val"), color)
    rpr.append(col)
    if size:
        sz = OxmlElement("w:sz")
        sz.set(qn("w:val"), str(int(size * 2)))
        rpr.append(sz)
    if underline:
        u = OxmlElement("w:u")
        u.set(qn("w:val"), "single")
        rpr.append(u)
    if superscript:
        va = OxmlElement("w:vertAlign")
        va.set(qn("w:val"), "superscript")
        rpr.append(va)
    t = OxmlElement("w:t")
    t.text = text
    t.set(qn("xml:space"), "preserve")
    r.extend([rpr, t])
    link.append(r)
    paragraph._p.append(link)


def _runs(paragraph, runs: list[Run] | None, *, size: float | None = None, color: str | None = None,
          bold: bool = False) -> None:
    for r in runs or []:
        if r.cite is not None:
            _link_run(paragraph, f"[{r.cite}]", anchor=f"src_{r.cite}", superscript=True, size=size)
            continue
        if r.href:
            _link_run(paragraph, r.text, url=r.href, underline=True, size=size)
            continue
        run = paragraph.add_run(r.text)
        run.bold = r.bold or bold or None
        run.italic = r.italic or None
        run.font.strike = r.strike or None
        if r.code:
            run.font.name = T.MONO_FONT
            _set_font(run._r, T.MONO_FONT)
        if size:
            run.font.size = Pt(size)
        if color:
            run.font.color.rgb = _color(color)


def _cell_margins(table, top=90, bottom=90, left=110, right=110) -> None:
    tblpr = table._tbl.tblPr
    mar = OxmlElement("w:tblCellMar")
    for side, val in (("top", top), ("left", left), ("bottom", bottom), ("right", right)):
        el = OxmlElement(f"w:{side}")
        el.set(qn("w:w"), str(val))
        el.set(qn("w:type"), "dxa")
        mar.append(el)
    _put(tblpr, mar, _TBLPR)


def _table_borders(table) -> None:
    tblpr = table._tbl.tblPr
    borders = OxmlElement("w:tblBorders")
    for side, color, sz in (("top", T.RULE, 4), ("bottom", T.RULE, 4), ("insideH", T.RULE, 4),
                            ("left", "auto", 0), ("right", "auto", 0), ("insideV", "auto", 0)):
        el = OxmlElement(f"w:{side}")
        el.set(qn("w:val"), "single" if sz else "nil")
        el.set(qn("w:sz"), str(sz))
        el.set(qn("w:space"), "0")
        el.set(qn("w:color"), color)
        borders.append(el)
    _put(tblpr, borders, _TBLPR)
    width = OxmlElement("w:tblW")
    width.set(qn("w:w"), "5000")
    width.set(qn("w:type"), "pct")
    _put(tblpr, width, _TBLPR)


def _add_table(doc, t: MdTable) -> None:
    cols = len(t.header)
    table = doc.add_table(rows=1 + len(t.rows), cols=cols)
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    _table_borders(table)
    _cell_margins(table)
    head = table.rows[0]
    trpr = head._tr.get_or_add_trPr()
    repeat = OxmlElement("w:tblHeader")
    trpr.append(repeat)
    for i, cell_runs in enumerate(t.header):
        cell = head.cells[i]
        _shade(cell._tc, T.ACCENT_SOFT)
        p = cell.paragraphs[0]
        p.paragraph_format.space_after = Pt(0)
        p.alignment = _ALIGN.get(t.align[i] if i < len(t.align) else "left")
        _runs(p, cell_runs, size=9.5, color=T.ACCENT_DEEP, bold=True)
        # Línea azul bajo la cabecera
        tcpr = cell._tc.get_or_add_tcPr()
        borders = OxmlElement("w:tcBorders")
        bottom = OxmlElement("w:bottom")
        for k, v in (("w:val", "single"), ("w:sz", "8"), ("w:space", "0"), ("w:color", T.ACCENT)):
            bottom.set(qn(k), v)
        borders.append(bottom)
        _put(tcpr, borders, _TCPR)
    for r_i, row in enumerate(t.rows, start=1):
        cells = (row + [[]] * cols)[:cols]
        for i, cell_runs in enumerate(cells):
            cell = table.rows[r_i].cells[i]
            if r_i % 2 == 0:
                _shade(cell._tc, T.ZEBRA)
            p = cell.paragraphs[0]
            p.paragraph_format.space_after = Pt(0)
            p.alignment = _ALIGN.get(t.align[i] if i < len(t.align) else "left")
            _runs(p, cell_runs, size=9.5)
    spacer = doc.add_paragraph()
    spacer.paragraph_format.space_after = Pt(4)


def _header_footer(doc, d: Document) -> None:
    section = doc.sections[0]
    section.different_first_page_header_footer = True
    width = section.page_width - section.left_margin - section.right_margin
    hp = section.header.paragraphs[0]
    hp.alignment = WD_ALIGN_PARAGRAPH.LEFT
    run = hp.add_run(d.title if len(d.title) <= 90 else d.title[:89] + "…")
    run.font.size = Pt(8)
    run.font.color.rgb = _color(T.MUTED)
    _border(hp, "bottom", T.RULE, size=4, space=4)

    lab = d.labels
    for footer in (section.footer, section.first_page_footer):
        fp = footer.paragraphs[0]
        fp.paragraph_format.tab_stops.add_tab_stop(width, WD_TAB_ALIGNMENT.RIGHT)
        _border(fp, "top", T.RULE, size=4, space=4)
        left = fp.add_run(f"{lab['prepared']} · {long_date(d.created, d.language)}\t{lab['page']} ")
        left.font.size = Pt(8)
        left.font.color.rgb = _color(T.MUTED)
        _field(fp, "PAGE", 8, T.MUTED)
        mid = fp.add_run(f" {lab['of']} ")
        mid.font.size = Pt(8)
        mid.font.color.rgb = _color(T.MUTED)
        _field(fp, "NUMPAGES", 8, T.MUTED)


def render_docx(d: Document, page: str = "A4") -> bytes:
    doc = new_docx()
    lab = d.labels
    section = doc.sections[0]
    if page.upper() == "LETTER":
        section.page_width, section.page_height = Cm(21.59), Cm(27.94)
    else:
        section.page_width, section.page_height = Cm(21.0), Cm(29.7)
    section.start_type = WD_SECTION.NEW_PAGE
    for side in ("left_margin", "right_margin"):
        setattr(section, side, Cm(2.3))
    section.top_margin, section.bottom_margin = Cm(2.2), Cm(2.2)
    section.header_distance = section.footer_distance = Cm(1.1)

    normal = _style(doc, "Normal", size=11, color=T.BODY, after=6)
    normal.paragraph_format.line_spacing = 1.15
    rpr = normal.element.get_or_add_rPr()
    lang = rpr.find(qn("w:lang"))
    if lang is None:
        lang = OxmlElement("w:lang")
        rpr.append(lang)
    lang.set(qn("w:val"), "es-ES" if d.language == "es" else "en-US")
    _style(doc, "Title", size=26, color=T.INK, bold=True, after=6)
    _style(doc, "Subtitle", size=13, color=T.INK_2, after=8)
    _style(doc, "Heading 1", size=16, color=T.ACCENT_TEXT, bold=True, before=18, after=6, keep_next=True)
    _style(doc, "Heading 2", size=13, color=T.INK, bold=True, before=12, after=4, keep_next=True)
    _style(doc, "Heading 3", size=11.5, color=T.INK_2, bold=True, before=10, after=3, keep_next=True)
    for name in ("List Bullet", "List Bullet 2", "List Bullet 3"):
        _style(doc, name, size=11, color=T.BODY, after=3)

    eyebrow = doc.add_paragraph()
    er = eyebrow.add_run(lab[d.kind].upper())
    er.bold = True
    er.font.size = Pt(9)
    er.font.color.rgb = _color(T.ACCENT_TEXT)
    eyebrow.paragraph_format.space_after = Pt(4)
    doc.add_paragraph(d.title, style="Title")
    if d.lead:
        lead = doc.add_paragraph(style="Subtitle")
        _runs(lead, d.lead)
    n = len(d.sources)
    meta = doc.add_paragraph()
    mr = meta.add_run(f"{lab['prepared']} · {long_date(d.created, d.language)} · {n} "
                      + (lab["sources"].lower() if n != 1 else lab["sources"].lower().rstrip("s")))
    mr.font.size = Pt(9)
    mr.font.color.rgb = _color(T.MUTED)
    meta.paragraph_format.space_after = Pt(14)
    _border(meta, "bottom", T.ACCENT, size=12, space=10)

    for b in d.blocks:
        if isinstance(b, Heading):
            h = doc.add_paragraph(style=f"Heading {b.level}")
            _runs(h, [r for r in b.runs if r.cite is None])
        elif isinstance(b, MdParagraph):
            _runs(doc.add_paragraph(), b.runs)
        elif isinstance(b, ListBlock):
            for it in b.items:
                if it.ordered:
                    p = doc.add_paragraph()
                    pf = p.paragraph_format
                    pf.left_indent = Cm(0.75 + 0.6 * it.level)
                    pf.first_line_indent = Cm(-0.55)
                    pf.space_after = Pt(3)
                    pf.tab_stops.add_tab_stop(Cm(0.75 + 0.6 * it.level))
                    num = p.add_run(f"{it.number}.\t")
                    num.bold = True
                    num.font.color.rgb = _color(T.ACCENT_TEXT)
                else:
                    p = doc.add_paragraph(style="List Bullet" if it.level == 0 else f"List Bullet {min(3, it.level + 1)}")
                _runs(p, it.runs)
            doc.paragraphs[-1].paragraph_format.space_after = Pt(8)
        elif isinstance(b, MdTable):
            _add_table(doc, b)
        elif isinstance(b, Quote):
            p = doc.add_paragraph()
            p.paragraph_format.left_indent = Cm(0.5)
            _border(p, "left", T.ACCENT, size=18, space=10)
            _runs(p, [Run(r.text, r.bold, True, r.code, r.strike, r.href, r.cite) for r in b.runs], color=T.INK_2)
        elif isinstance(b, Code):
            p = doc.add_paragraph()
            _shade(p._p, T.ZEBRA)
            run = p.add_run(b.text)
            run.font.size = Pt(9)
            _set_font(run._r, T.MONO_FONT)
        elif isinstance(b, Rule):
            p = doc.add_paragraph()
            _border(p, "bottom", T.RULE, size=4, space=1)

    if d.sources:
        doc.add_paragraph(lab["sources"], style="Heading 1")
        note = doc.add_paragraph()
        nr = note.add_run(lab["sources_note"])
        nr.font.size = Pt(9)
        nr.font.color.rgb = _color(T.MUTED)
        for i, s in enumerate(d.sources):
            p = doc.add_paragraph()
            pf = p.paragraph_format
            pf.left_indent = Cm(0.9)
            pf.first_line_indent = Cm(-0.9)
            pf.space_after = Pt(3)
            pf.tab_stops.add_tab_stop(Cm(0.9))
            num = p.add_run(f"[{s.n}]\t")
            num.bold = True
            num.font.size = Pt(9.5)
            num.font.color.rgb = _color(T.ACCENT_TEXT)
            body = p.add_run(source_label(s, d.language))
            body.font.size = Pt(9.5)
            _bookmark(p, f"src_{s.n}", 100 + i)
    ai = doc.add_paragraph()
    ai.paragraph_format.space_before = Pt(14)
    _shade(ai._p, T.ZEBRA)
    ar = ai.add_run(lab["ai_note"])
    ar.italic = True
    ar.font.size = Pt(8.5)
    ar.font.color.rgb = _color(T.MUTED)

    _header_footer(doc, d)
    props = doc.core_properties
    props.title = d.title
    props.subject = lab[d.kind]
    props.author = "Ragis"
    props.last_modified_by = "Ragis"
    props.comments = lab["generated"]
    props.language = "es-ES" if d.language == "es" else "en-US"
    props.created = props.modified = datetime.now(UTC).replace(microsecond=0)
    props.keywords = ", ".join(plain([r for r in b.runs if r.cite is None]) for b in d.blocks
                               if isinstance(b, Heading) and b.level == 1)[:250]
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()
