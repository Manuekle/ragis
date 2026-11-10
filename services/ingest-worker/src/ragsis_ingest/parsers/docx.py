"""DOCX vía OOXML (zipfile + ElementTree, sin dependencias nativas).

Conserva encabezados (estilos Heading/Título), tablas completas como bloque, figuras embebidas
(bytes + texto alternativo), gráficos nativos (caché de datos → tabla con cifras exactas),
ecuaciones OMML en display y captions (estilo Caption/Descripción o texto "Figura N…").
"""

from __future__ import annotations

import io
import re
import zipfile
from xml.etree import ElementTree as ET  # noqa: S405 - entrada validada; sin DTD/entidades en OOXML

from ragsis_core.text import normalize

from .layout import attach_captions, caption_candidate
from .model import Block, ParsedDocument
from .ooxml import (
    R_EMBED,
    R_ID,
    chart_table,
    is_caption_style,
    is_caption_text,
    media_image,
    q,
    read_part,
    rels_for,
    safe_xml,
)

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
_HEADING_STYLE = re.compile(r"^(heading|t[ií]tulo|ttulo)\s*(\d)?$", re.I)
_CHART_URI = "http://schemas.openxmlformats.org/drawingml/2006/chart"


def _para_text(p: ET.Element) -> str:
    parts = []
    for node in p.iter():
        if node.tag in (f"{W}t", q("m", "t")) and node.text:
            parts.append(node.text)
        elif node.tag in (f"{W}tab",):
            parts.append(" ")
        elif node.tag in (f"{W}br", f"{W}cr"):
            parts.append("\n")
    return "".join(parts)


def _text_without_math_paras(p: ET.Element) -> str:
    parts = []

    def walk(el: ET.Element) -> None:
        for child in el:
            if child.tag == q("m", "oMathPara"):
                continue
            if child.tag in (f"{W}t", q("m", "t")) and child.text:
                parts.append(child.text)
            elif child.tag == f"{W}tab":
                parts.append(" ")
            elif child.tag in (f"{W}br", f"{W}cr"):
                parts.append("\n")
            walk(child)

    walk(p)
    return "".join(parts)


def _style(p: ET.Element) -> str:
    ppr = p.find(f"{W}pPr")
    if ppr is None:
        return ""
    st = ppr.find(f"{W}pStyle")
    return st.get(f"{W}val", "") if st is not None else ""


class _Docx:
    def __init__(self, zf: zipfile.ZipFile) -> None:
        self.zf = zf
        self.rels = rels_for(zf, "word/document.xml")
        self.warnings: list[str] = []

    def drawings(self, p: ET.Element) -> list[Block]:
        """Figuras y gráficos anclados en el párrafo, en orden de aparición."""
        out: list[Block] = []
        for drawing in p.iter(f"{W}drawing"):
            doc_pr = drawing.find(f".//{q('wp', 'docPr')}")
            alt = normalize(" ".join(filter(None, [doc_pr.get("title"), doc_pr.get("descr")]))) if doc_pr is not None else ""
            gdata = drawing.find(f".//{q('a', 'graphicData')}")
            if gdata is not None and gdata.get("uri") == _CHART_URI:
                chart_ref = gdata.find(q("c", "chart"))
                block = self._chart(chart_ref.get(R_ID) if chart_ref is not None else None)
                if block is not None:
                    out.append(block)
                continue
            blip = drawing.find(f".//{q('a', 'blip')}")
            if blip is not None:
                out.extend(self._image(blip.get(R_EMBED), alt))
        for imagedata in p.iter(q("v", "imagedata")):   # VML heredado (documentos antiguos)
            out.extend(self._image(imagedata.get(R_ID), ""))
        return out

    def _image(self, rid: str | None, alt: str) -> list[Block]:
        target = self.rels.get(rid or "")
        if not target:
            return []
        img = media_image(self.zf, target[0])
        if img is None:
            if alt:
                return [Block("figure", "", meta={"alt_text": alt})]
            self.warnings.append(f"figura no soportada para VLM: {target[0].rsplit('/', 1)[-1]}")
            return []
        return [Block("figure", "", image=img[0], image_mime=img[1], meta={"alt_text": alt} if alt else {})]

    def _chart(self, rid: str | None) -> Block | None:
        target = self.rels.get(rid or "")
        data = read_part(self.zf, target[0]) if target else None
        parsed = chart_table(data) if data else None
        if not parsed:
            return None
        title, table = parsed
        return Block("table", table, caption=f"Gráfico: {title}" if title else "Gráfico",
                     meta={"source": "chart"})


def parse_docx(data: bytes) -> ParsedDocument:
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        xml = read_part(zf, "word/document.xml") or b""
        root = safe_xml(xml)
        body = root.find(f"{W}body")
        blocks: list[Block] = []
        if body is None:
            return ParsedDocument("ooxml", "2", blocks, page_count=1)
        doc = _Docx(zf)
        for el in body:
            if el.tag == f"{W}p":
                style = _style(el).replace(" ", "")
                for math in el.iter(q("m", "oMathPara")):
                    eq = normalize(_para_text(math))
                    if eq:
                        blocks.append(Block("equation", eq, meta={"format": "omml-linear"}))
                text = normalize(_text_without_math_paras(el))
                figures = doc.drawings(el)
                if text:
                    m = _HEADING_STYLE.match(style)
                    if m or style.lower() == "title":
                        level = int(m.group(2)) if m and m.group(2) else 1
                        blocks.append(Block("heading", text, level=level, page=None))
                    elif is_caption_style(style) or (is_caption_text(text) and not figures):
                        blocks.append(caption_candidate(text))
                    elif style.lower().startswith("list"):
                        blocks.append(Block("list", text))
                    else:
                        blocks.append(Block("paragraph", text))
                blocks.extend(figures)
            elif el.tag == f"{W}tbl":
                rows = []
                for tr in el.iter(f"{W}tr"):
                    cells = [normalize(_para_text(tc)).replace("|", "/") for tc in tr.iter(f"{W}tc")]
                    rows.append("| " + " | ".join(cells) + " |")
                if rows:
                    blocks.append(Block("table", "\n".join(rows)))
    blocks = attach_captions(blocks)
    title = next((b.text for b in blocks if b.kind == "heading"), None)
    return ParsedDocument("ooxml", "2", blocks, page_count=1, title=title, warnings=doc.warnings[:20])
