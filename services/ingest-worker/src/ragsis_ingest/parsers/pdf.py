"""PDF digital con pypdf (texto por página + imágenes embebidas JPEG/PNG).

PDFs escaneados → páginas candidatas a OCR (Textract) o ruta Docling. Las figuras se emiten al final
de su página; un caption "Figura N…" de la misma página se asocia por orden de aparición.
"""

from __future__ import annotations

import io
import re

import pypdf

from .model import Block, ParsedDocument
from .ooxml import is_caption_text
from .pdf_images import page_images
from .text import parse_lines

MIN_CHARS_PER_PAGE = 40
_FIGURE_CAPTION = re.compile(r"^(figura|fig\.|gr[aá]fico|imagen|ilustraci[oó]n|diagrama|figure|chart)\b", re.I)


class PageLimitExceeded(Exception):
    pass


def parse_pdf(data: bytes, max_pages: int, extract_images: bool = False, max_pixels: int = 40_000_000) -> ParsedDocument:
    reader = pypdf.PdfReader(io.BytesIO(data))
    n = len(reader.pages)
    if n > max_pages:
        raise PageLimitExceeded(f"{n} páginas > límite del plan {max_pages}")
    blocks = []
    warnings: list[str] = []
    low_text_pages: list[int] = []
    for i, page in enumerate(reader.pages, start=1):
        try:
            text = page.extract_text() or ""
        except Exception as exc:  # noqa: BLE001 - pypdf lanza errores heterogéneos por página
            warnings.append(f"page {i}: extracción fallida ({type(exc).__name__})")
            continue
        if len(text.strip()) < MIN_CHARS_PER_PAGE:
            low_text_pages.append(i)
        lines = text.split("\n")
        blocks.extend(parse_lines(lines, page=i, markdown=False))
        # Páginas escaneadas (sin texto digital) son una imagen de página completa: van por OCR, no por VLM.
        if extract_images and i not in low_text_pages:
            captions = [ln.strip() for ln in lines if is_caption_text(ln.strip()) and _FIGURE_CAPTION.match(ln.strip())]
            for k, (img, mime) in enumerate(page_images(page, max_pixels)):
                blocks.append(Block("figure", "", page=i, image=img, image_mime=mime,
                                    caption=captions[k] if k < len(captions) else ""))
    if n and len(low_text_pages) / n > 0.5:
        warnings.append("ocr_required: más de la mitad de las páginas sin texto digital")
    title = None
    meta = reader.metadata
    if meta and meta.title:
        title = str(meta.title)[:200]
    return ParsedDocument("pypdf", pypdf.__version__, blocks, page_count=n, title=title, warnings=warnings,
                          low_text_pages=low_text_pages)
