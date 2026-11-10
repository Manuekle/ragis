"""Selector de parser (adaptadores).

- native (por defecto): parsers propios sin dependencias nativas para PDF digital, DOCX, PPTX, XLSX,
  HTML, Markdown, texto e imágenes.
- docling (PARSER_PREFERENCE=docling, extra opcional): layout, estructura de tablas, fórmulas y figuras
  con bbox. Si Docling no está instalado o falla en un documento, se usa el parser nativo y queda una
  advertencia en la versión (nunca se pierde la ingesta por el adaptador).
"""

from __future__ import annotations

import logging

from ragsis_core.settings import get_settings

from .docx import parse_docx
from .html import parse_html
from .image import parse_image
from .model import ParsedDocument
from .pdf import PageLimitExceeded, parse_pdf
from .pptx import parse_pptx
from .text import parse_text
from .xlsx import parse_xlsx

logger = logging.getLogger("ragsis.ingest.parsers")


def _native(data: bytes, kind: str, max_pages: int, extract_images: bool) -> ParsedDocument:
    s = get_settings()
    if kind == "pdf":
        return parse_pdf(data, max_pages, extract_images=extract_images, max_pixels=s.vision_max_image_pixels)
    if kind == "docx":
        return parse_docx(data)
    if kind == "pptx":
        return parse_pptx(data, max_pages)
    if kind == "xlsx":
        return parse_xlsx(data, max_pages)
    if kind == "image":
        return parse_image(data)
    if kind == "html":
        return parse_html(data)
    if kind == "markdown":
        return parse_text(data, markdown=True)
    return parse_text(data, markdown=False)


def parse(data: bytes, kind: str, max_pages: int, extract_images: bool = True) -> ParsedDocument:
    s = get_settings()
    note = None
    if s.parser_preference == "docling" and kind in ("pdf", "docx", "pptx", "xlsx", "html", "image"):
        from . import docling_adapter

        if not docling_adapter.available():
            note = "docling_unavailable: se usó el parser nativo"
        else:
            try:
                return docling_adapter.parse_with_docling(data, kind, max_pages, do_ocr=s.docling_ocr,
                                                          artifacts_path=s.docling_artifacts_path)
            except PageLimitExceeded:
                raise
            except Exception as exc:  # noqa: BLE001 - el adaptador nunca tumba la ingesta
                logger.warning("docling falló; parser nativo", extra={"error": type(exc).__name__})
                note = f"docling_failed ({type(exc).__name__}): se usó el parser nativo"
    parsed = _native(data, kind, max_pages, extract_images)
    if note:
        parsed.warnings.insert(0, note)
    return parsed
