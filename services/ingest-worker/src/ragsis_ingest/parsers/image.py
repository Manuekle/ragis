"""Imagen como documento (PNG/JPEG): una figura de página completa.

El texto sale del OCR (si está habilitado y la política lo permite) y/o de la descripción del VLM.
Sin ninguno de los dos el documento no tiene texto extraíble y se rechaza.
"""

from __future__ import annotations

from ..images import inspect_image
from .model import Block, ParsedDocument


def parse_image(data: bytes) -> ParsedDocument:
    info = inspect_image(data)
    if info is None:
        raise ValueError("imagen inválida")
    block = Block("figure", "", page=1, bbox=(0.0, 0.0, 1.0, 1.0), image=data, image_mime=info.mime,
                  meta={"width": info.width, "height": info.height, "whole_page": True})
    return ParsedDocument("image", "1", [block], page_count=1, low_text_pages=[1])
