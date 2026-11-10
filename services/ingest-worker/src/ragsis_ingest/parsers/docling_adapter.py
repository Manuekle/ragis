"""Adaptador Docling (opcional: `uv pip install docling` en la imagen del worker): layout, estructura de tablas,
fórmulas y figuras con bbox y caption para PDF, DOCX, PPTX, XLSX, HTML e imágenes.

- El OCR de Docling es local (sin red) y está apagado por defecto (DOCLING_OCR=true lo activa): es la ruta
  de OCR offline para tenants `restricted`. Textract sigue siendo el OCR cloud gobernado por política.
- Los modelos se descargan de Hugging Face en el primer uso; en despliegues sin red se pre-descargan y se
  apunta DOCLING_ARTIFACTS_PATH a ellos.
- La conversión del DoclingDocument a bloques se hace por etiqueta (duck typing) para poder probarla sin
  instalar Docling y para tolerar cambios menores entre versiones.
"""

from __future__ import annotations

import io
from functools import lru_cache
from importlib import metadata

from .model import Block, ParsedDocument, clamp_bbox

_FORMATS = {"pdf": "pdf", "docx": "docx", "pptx": "pptx", "xlsx": "xlsx", "html": "html", "image": "png"}
_SKIP = {"page_header", "page_footer"}


class DoclingUnavailable(Exception):
    pass


def available() -> bool:
    try:
        metadata.version("docling")
        return True
    except metadata.PackageNotFoundError:
        return False


@lru_cache(maxsize=1)
def _converter(do_ocr: bool, artifacts_path: str | None):  # pragma: no cover - requiere docling instalado
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.document_converter import DocumentConverter, ImageFormatOption, PdfFormatOption

    opts = PdfPipelineOptions(artifacts_path=artifacts_path) if artifacts_path else PdfPipelineOptions()
    opts.do_ocr = do_ocr
    opts.do_table_structure = True
    opts.do_formula_enrichment = True
    opts.generate_picture_images = True
    opts.images_scale = 2.0
    return DocumentConverter(format_options={
        InputFormat.PDF: PdfFormatOption(pipeline_options=opts),
        InputFormat.IMAGE: ImageFormatOption(pipeline_options=opts),
    })


def parse_with_docling(data: bytes, kind: str, max_pages: int, *, do_ocr: bool = False,
                       artifacts_path: str | None = None) -> ParsedDocument:  # pragma: no cover - requiere docling
    if kind not in _FORMATS:
        raise DoclingUnavailable(f"docling no aplica a {kind}")
    try:
        from docling.datamodel.base_models import DocumentStream
    except ImportError as exc:
        raise DoclingUnavailable("docling no instalado") from exc
    result = _converter(do_ocr, artifacts_path).convert(
        DocumentStream(name=f"document.{_FORMATS[kind]}", stream=io.BytesIO(data)),
        max_num_pages=max_pages, raises_on_error=True)
    return convert_document(result.document, metadata.version("docling"))


def _label(item) -> str:
    label = getattr(item, "label", "")
    return str(getattr(label, "value", label))


def _bbox(doc, prov):
    try:
        size = doc.pages[prov.page_no].size
        bb = prov.bbox.to_top_left_origin(page_height=size.height)
        return clamp_bbox(bb.l / size.width, bb.t / size.height, bb.r / size.width, bb.b / size.height)
    except Exception:  # noqa: BLE001 - bbox es opcional
        return None


def _png(pil_image) -> bytes | None:
    if pil_image is None:
        return None
    buf = io.BytesIO()
    pil_image.save(buf, format="PNG")
    return buf.getvalue()


def convert_document(doc, version: str) -> ParsedDocument:
    """DoclingDocument → ParsedDocument (orden de lectura de `iterate_items`)."""
    caption_refs = {getattr(ref, "cref", None) for item in [*getattr(doc, "tables", []), *getattr(doc, "pictures", [])]
                    for ref in getattr(item, "captions", []) or []}
    blocks: list[Block] = []
    warnings: list[str] = []
    title = None
    for item, _level in doc.iterate_items():
        label = _label(item)
        if label in _SKIP or getattr(item, "self_ref", None) in caption_refs:
            continue
        prov = item.prov[0] if getattr(item, "prov", None) else None
        page = getattr(prov, "page_no", None) if prov else None
        bbox = _bbox(doc, prov) if prov else None
        if label == "table":
            md = item.export_to_markdown(doc=doc).strip()
            if md:
                blocks.append(Block("table", md, page=page, bbox=bbox, caption=item.caption_text(doc) or ""))
        elif label in ("picture", "chart"):
            try:
                image = _png(item.get_image(doc))
            except Exception:  # noqa: BLE001
                image = None
                warnings.append(f"page {page}: imagen de figura no disponible")
            blocks.append(Block("figure", "", page=page, bbox=bbox, caption=item.caption_text(doc) or "",
                                image=image, image_mime="image/png" if image else None))
        elif label == "formula":
            text = (getattr(item, "text", "") or "").strip()
            if text:
                blocks.append(Block("equation", text, page=page, bbox=bbox, meta={"format": "latex"}))
        elif label == "title":
            text = (item.text or "").strip()
            if text:
                title = title or text[:200]
                blocks.append(Block("heading", text, level=1, page=page, bbox=bbox))
        elif label == "section_header":
            text = (item.text or "").strip()
            if text:
                level = int(getattr(item, "level", 1) or 1)
                blocks.append(Block("heading", text, level=min(level + 1, 6), page=page, bbox=bbox))
        elif label == "list_item":
            text = (item.text or "").strip()
            if text:
                blocks.append(Block("list", text, page=page, bbox=bbox))
        else:
            text = (getattr(item, "text", "") or "").strip()
            if text:
                blocks.append(Block("paragraph", text, page=page, bbox=bbox))
    pages = getattr(doc, "pages", {}) or {}
    page_count = len(pages) or 1
    text_pages = {b.page for b in blocks if b.kind != "figure" and b.page}
    low_text = sorted(set(range(1, page_count + 1)) - text_pages) if pages else []
    return ParsedDocument("docling", version, blocks, page_count=page_count, title=title, warnings=warnings,
                          low_text_pages=low_text)
