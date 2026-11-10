"""PPTX vía OOXML (zipfile + ElementTree, sin dependencias nativas).

Cada diapositiva es una "página": su título abre una sección; cuadros de texto → párrafos;
tablas → tabla Markdown; imágenes → figura con bbox normalizado al tamaño de la diapositiva;
gráficos nativos → tabla con los valores de su caché; notas del orador → párrafo final.
"""

from __future__ import annotations

import io
import zipfile
from xml.etree import ElementTree as ET  # noqa: S405 - se rechaza DTD/entidades antes de parsear

from ragsis_core.text import normalize

from .layout import attach_captions, caption_candidate
from .model import Block, ParsedDocument, clamp_bbox
from .ooxml import R_EMBED, R_ID, chart_table, is_caption_text, media_image, q, read_part, rels_for, safe_xml

_TITLE_TYPES = {"title", "ctrTitle"}
_SKIP_PH = {"sldNum", "dt", "ftr", "hdr"}
_CHART_URI = "http://schemas.openxmlformats.org/drawingml/2006/chart"
MAX_SLIDES = 2000


def _paragraphs(tx_body: ET.Element | None) -> list[str]:
    if tx_body is None:
        return []
    out = []
    for p in tx_body.iter(q("a", "p")):
        parts = []
        for node in p.iter():
            if node.tag == q("a", "t") and node.text:
                parts.append(node.text)
            elif node.tag == q("a", "br"):
                parts.append(" ")
        text = normalize("".join(parts))
        if text:
            out.append(text)
    return out


class _Slide:
    def __init__(self, zf: zipfile.ZipFile, part: str, number: int, size: tuple[int, int]) -> None:
        self.zf = zf
        self.part = part
        self.page = number
        self.cx, self.cy = size
        self.rels = rels_for(zf, part)
        self.title = ""
        self.blocks: list[Block] = []
        self.warnings: list[str] = []

    def bbox(self, xfrm: ET.Element | None):
        """Caja desde un xfrm (a:xfrm de spPr o p:xfrm de graphicFrame; ambos usan a:off / a:ext)."""
        if xfrm is None or not self.cx or not self.cy:
            return None
        off, ext = xfrm.find(q("a", "off")), xfrm.find(q("a", "ext"))
        if off is None or ext is None:
            return None
        x, y = int(off.get("x", 0)), int(off.get("y", 0))
        w, h = int(ext.get("cx", 0)), int(ext.get("cy", 0))
        return clamp_bbox(x / self.cx, y / self.cy, (x + w) / self.cx, (y + h) / self.cy)

    def walk(self, tree: ET.Element, grouped: bool = False) -> None:
        for el in tree:
            tag = el.tag
            if tag == q("p", "sp"):
                self._shape(el, grouped)
            elif tag == q("p", "pic"):
                self._picture(el, grouped)
            elif tag == q("p", "graphicFrame"):
                self._frame(el, grouped)
            elif tag == q("p", "grpSp"):
                # Las transformaciones de grupo cambian el sistema de coordenadas: los hijos van sin bbox.
                self.walk(el, grouped=True)

    def _shape(self, sp: ET.Element, grouped: bool) -> None:
        ph = sp.find(f"{q('p', 'nvSpPr')}/{q('p', 'nvPr')}/{q('p', 'ph')}")
        ph_type = ph.get("type", "body") if ph is not None else None
        if ph_type in _SKIP_PH:
            return
        paras = _paragraphs(sp.find(q("p", "txBody")))
        if not paras:
            return
        if ph_type in _TITLE_TYPES and not self.title:
            self.title = " ".join(paras)[:200]
            return
        for text in paras:
            if is_caption_text(text):
                self.blocks.append(caption_candidate(text, page=self.page))
            else:
                self.blocks.append(Block("list" if ph_type == "body" else "paragraph", text, page=self.page))

    def _picture(self, pic: ET.Element, grouped: bool) -> None:
        c_nv = pic.find(f"{q('p', 'nvPicPr')}/{q('p', 'cNvPr')}")
        alt = normalize(" ".join(filter(None, [c_nv.get("title"), c_nv.get("descr")]))) if c_nv is not None else ""
        blip = pic.find(f".//{q('a', 'blip')}")
        target = self.rels.get(blip.get(R_EMBED, "") if blip is not None else "")
        img = media_image(self.zf, target[0]) if target else None
        bbox = None if grouped else self.bbox(pic.find(f"{q('p', 'spPr')}/{q('a', 'xfrm')}"))
        meta = {"alt_text": alt} if alt else {}
        if img is None:
            if alt:
                self.blocks.append(Block("figure", "", page=self.page, bbox=bbox, meta=meta))
            elif target:
                self.warnings.append(f"diapositiva {self.page}: imagen no soportada para VLM")
            return
        self.blocks.append(Block("figure", "", page=self.page, bbox=bbox, image=img[0], image_mime=img[1], meta=meta))

    def _frame(self, frame: ET.Element, grouped: bool) -> None:
        bbox = None if grouped else self.bbox(frame.find(q("p", "xfrm")))
        gdata = frame.find(f".//{q('a', 'graphicData')}")
        if gdata is None:
            return
        tbl = gdata.find(q("a", "tbl"))
        if tbl is not None:
            rows = []
            for tr in tbl.iter(q("a", "tr")):
                cells = [" ".join(_paragraphs(tc.find(q("a", "txBody")))).replace("|", "/") for tc in tr.iter(q("a", "tc"))]
                rows.append("| " + " | ".join(cells) + " |")
            if rows:
                self.blocks.append(Block("table", "\n".join(rows), page=self.page, bbox=bbox))
            return
        if gdata.get("uri") == _CHART_URI:
            chart = gdata.find(q("c", "chart"))
            target = self.rels.get(chart.get(R_ID, "") if chart is not None else "")
            data = read_part(self.zf, target[0]) if target else None
            parsed = chart_table(data) if data else None
            if parsed:
                title, table = parsed
                self.blocks.append(Block("table", table, page=self.page, bbox=bbox,
                                         caption=f"Gráfico: {title}" if title else "Gráfico", meta={"source": "chart"}))

    def notes(self) -> None:
        note_part = next((p for p, t in self.rels.values() if t == "notesSlide"), None)
        data = read_part(self.zf, note_part) if note_part else None
        if not data:
            return
        texts = []
        for sp in safe_xml(data).iter(q("p", "sp")):
            ph = sp.find(f"{q('p', 'nvSpPr')}/{q('p', 'nvPr')}/{q('p', 'ph')}")
            if ph is not None and ph.get("type") == "body":
                texts.extend(_paragraphs(sp.find(q("p", "txBody"))))
        if texts:
            self.blocks.append(Block("paragraph", "Notas del orador: " + " ".join(texts), page=self.page))


def parse_pptx(data: bytes, max_pages: int) -> ParsedDocument:
    from .pdf import PageLimitExceeded

    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        pres = safe_xml(read_part(zf, "ppt/presentation.xml") or b"<x/>")
        size_el = pres.find(q("p", "sldSz"))
        size = (int(size_el.get("cx", 0)), int(size_el.get("cy", 0))) if size_el is not None else (0, 0)
        rels = rels_for(zf, "ppt/presentation.xml")
        slide_ids = pres.findall(f"{q('p', 'sldIdLst')}/{q('p', 'sldId')}")
        if len(slide_ids) > min(max_pages, MAX_SLIDES):
            raise PageLimitExceeded(f"{len(slide_ids)} diapositivas > límite del plan {max_pages}")
        blocks: list[Block] = []
        warnings: list[str] = []
        for n, sid in enumerate(slide_ids, start=1):
            target = rels.get(sid.get(R_ID, ""))
            xml = read_part(zf, target[0]) if target else None
            if not xml:
                warnings.append(f"diapositiva {n}: parte no encontrada")
                continue
            slide = _Slide(zf, target[0], n, size)
            tree = safe_xml(xml).find(f"{q('p', 'cSld')}/{q('p', 'spTree')}")
            if tree is not None:
                slide.walk(tree)
            slide.notes()
            heading = f"Diapositiva {n}: {slide.title}" if slide.title else f"Diapositiva {n}"
            blocks.append(Block("heading", heading, level=1, page=n))
            blocks.extend(attach_captions(slide.blocks))
            warnings.extend(slide.warnings)
    title = next((b.text.split(": ", 1)[1] for b in blocks if b.kind == "heading" and ": " in b.text), None)
    return ParsedDocument("ooxml-pptx", "1", blocks, page_count=len(slide_ids), title=title, warnings=warnings[:20])
