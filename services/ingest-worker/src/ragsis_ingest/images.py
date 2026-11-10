"""Inspección de imágenes por cabecera (sin decodificar píxeles ni dependencias nativas).

Se usa para: aceptar imágenes como documento, decidir qué figuras extraídas merecen un VLM
(descarta iconos/viñetas) y rechazar bombas de descompresión antes de que nada las decodifique.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass


@dataclass(frozen=True)
class ImageInfo:
    mime: str
    width: int
    height: int

    @property
    def pixels(self) -> int:
        return self.width * self.height


def _png(data: bytes) -> ImageInfo | None:
    if len(data) < 24 or data[12:16] != b"IHDR":
        return None
    w, h = struct.unpack(">II", data[16:24])
    return ImageInfo("image/png", w, h)


_SOF = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}


def _jpeg(data: bytes) -> ImageInfo | None:
    i, n = 2, len(data)
    while i + 9 < n:
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:   # sin longitud
            i += 2
            continue
        if marker == 0xFF:
            i += 1
            continue
        length = struct.unpack(">H", data[i + 2:i + 4])[0]
        if marker in _SOF:
            h, w = struct.unpack(">HH", data[i + 5:i + 9])
            return ImageInfo("image/jpeg", w, h)
        if length < 2:
            return None
        i += 2 + length
    return None


def _gif(data: bytes) -> ImageInfo | None:
    if len(data) < 10:
        return None
    w, h = struct.unpack("<HH", data[6:10])
    return ImageInfo("image/gif", w, h)


def _webp(data: bytes) -> ImageInfo | None:
    if len(data) < 30:
        return None
    chunk = data[12:16]
    if chunk == b"VP8X":
        w = int.from_bytes(data[24:27], "little") + 1
        h = int.from_bytes(data[27:30], "little") + 1
        return ImageInfo("image/webp", w, h)
    if chunk == b"VP8L":
        b = data[21:25]
        w = 1 + (((b[1] & 0x3F) << 8) | b[0])
        h = 1 + (((b[3] & 0x0F) << 10) | (b[2] << 2) | ((b[1] & 0xC0) >> 6))
        return ImageInfo("image/webp", w, h)
    if chunk == b"VP8 ":
        w, h = struct.unpack("<HH", data[26:30])
        return ImageInfo("image/webp", w & 0x3FFF, h & 0x3FFF)
    return None


def inspect_image(data: bytes) -> ImageInfo | None:
    """Tipo y dimensiones por magic bytes. None si no es PNG/JPEG/GIF/WebP o la cabecera es inválida."""
    try:
        if data.startswith(b"\x89PNG\r\n\x1a\n"):
            info = _png(data)
        elif data.startswith(b"\xff\xd8\xff"):
            info = _jpeg(data)
        elif data.startswith((b"GIF87a", b"GIF89a")):
            info = _gif(data)
        elif data[:4] == b"RIFF" and data[8:12] == b"WEBP":
            info = _webp(data)
        else:
            return None
    except (struct.error, IndexError):
        return None
    if info is None or info.width <= 0 or info.height <= 0:
        return None
    return info
