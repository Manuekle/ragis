"""Extracción de imágenes de PDF sin Pillow.

- DCTDecode (JPEG): se toman los bytes tal cual.
- FlateDecode/sin filtro con DeviceRGB/DeviceGray de 8 bits: se re-empaquetan como PNG (zlib + chunks).
- Otros (JPX, CCITT, JBIG2, indexados, CMYK crudo, máscaras): se omiten.

Antes de inflar un stream se verifica ancho×alto contra el límite de píxeles (bomba de descompresión).
Solo XObjects de imagen a nivel de página; sin bbox (requiere interpretar el content stream: ruta Docling).
"""

from __future__ import annotations

import struct
import zlib

from ..images import inspect_image

_CHANNELS = {"/DeviceRGB": 3, "/DeviceGray": 1}


def _png(width: int, height: int, channels: int, raw: bytes) -> bytes:
    stride = width * channels
    rows = b"".join(b"\x00" + raw[y * stride:(y + 1) * stride] for y in range(height))

    def chunk(tag: bytes, body: bytes) -> bytes:
        return struct.pack(">I", len(body)) + tag + body + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF)

    color_type = 2 if channels == 3 else 0
    ihdr = struct.pack(">IIBBBBB", width, height, 8, color_type, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(rows, 6)) + chunk(b"IEND", b"")


def _filters(xobj) -> list[str]:
    f = xobj.get("/Filter")
    if f is None:
        return []
    return [str(x) for x in f] if isinstance(f, list) else [str(f)]


def page_images(page, max_pixels: int, max_images: int = 20) -> list[tuple[bytes, str]]:
    """[(bytes, mime)] de las imágenes de la página en el orden de /XObject."""
    out: list[tuple[bytes, str]] = []
    try:
        resources = page.get("/Resources")
        xobjects = resources.get_object().get("/XObject") if resources is not None else None
        if xobjects is None:
            return out
        xobjects = xobjects.get_object()
    except Exception:  # noqa: BLE001 - recursos malformados: se ignoran las imágenes de la página
        return out
    for name in list(xobjects.keys())[:200]:
        if len(out) >= max_images:
            break
        try:
            xobj = xobjects[name].get_object()
            if xobj.get("/Subtype") != "/Image" or xobj.get("/ImageMask"):
                continue
            width, height = int(xobj.get("/Width", 0)), int(xobj.get("/Height", 0))
            if width <= 0 or height <= 0 or width * height > max_pixels:
                continue
            filters = _filters(xobj)
            if filters and filters[-1] == "/DCTDecode":
                data = xobj.get_data()
                info = inspect_image(data)
                if info and info.mime == "image/jpeg":
                    out.append((data, "image/jpeg"))
                continue
            if any(f not in ("/FlateDecode", "/Fl") for f in filters):
                continue
            cs = xobj.get("/ColorSpace")
            cs = str(cs.get_object() if hasattr(cs, "get_object") else cs) if cs is not None else ""
            channels = _CHANNELS.get(cs)
            if channels is None or int(xobj.get("/BitsPerComponent", 8)) != 8:
                continue
            raw = xobj.get_data()
            if len(raw) < width * height * channels:
                continue
            out.append((_png(width, height, channels, raw), "image/png"))
        except Exception:  # noqa: BLE001, S112 - una imagen corrupta no debe tumbar la página
            continue
    return out
