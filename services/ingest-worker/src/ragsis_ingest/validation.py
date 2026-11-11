"""Validación de archivos en cuarentena: tamaño real, magic bytes, MIME permitido,
cifrado, macros y riesgos de ZIP (Office). Todo rechazo es definitivo (no reintentable)."""

from __future__ import annotations

import io
import zipfile
from dataclasses import dataclass

from ragsis_core.settings import get_settings

from .images import inspect_image

MAX_ZIP_ENTRIES = 2000
MAX_ZIP_UNCOMPRESSED = 300 * 1024 * 1024
MAX_ZIP_RATIO = 120
IMAGE_HEADER_BYTES = 512 * 1024   # JPEG con EXIF/ICC grandes: el SOF puede ir lejos del inicio

ALLOWED = {
    "pdf": {"application/pdf"},
    "docx": {"application/vnd.openxmlformats-officedocument.wordprocessingml.document"},
    "pptx": {"application/vnd.openxmlformats-officedocument.presentationml.presentation"},
    "xlsx": {"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"},
    "image": {"image/png", "image/jpeg"},
    "html": {"text/html"},
    "markdown": {"text/markdown", "text/x-markdown", "text/plain"},
    "text": {"text/plain", "text/csv"},
    "audio": {"audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/wave", "audio/flac", "audio/x-flac",
              "audio/ogg", "audio/mp4", "audio/x-m4a", "audio/m4a"},
}
# Contenedor detectado → MIME declarados que le corresponden (un .wav declarado como MP3 se rechaza).
AUDIO_MIME = {
    "mp3": {"audio/mpeg", "audio/mp3"},
    "wav": {"audio/wav", "audio/x-wav", "audio/wave"},
    "flac": {"audio/flac", "audio/x-flac"},
    "ogg": {"audio/ogg"},
    "m4a": {"audio/mp4", "audio/x-m4a", "audio/m4a"},
}
_M4A_BRANDS = (b"M4A ", b"M4B ", b"mp42", b"mp41", b"isom", b"iso2", b"dash")


def sniff_audio(head: bytes) -> str | None:
    """Contenedor de audio por magic bytes: mp3 | wav | flac | ogg | m4a. None si no es audio admitido."""
    if head.startswith(b"fLaC"):
        return "flac"
    if head.startswith(b"OggS"):
        return "ogg"
    if head.startswith(b"RIFF") and head[8:12] == b"WAVE":
        return "wav"
    if head[4:8] == b"ftyp":
        return "m4a" if head[8:12] in _M4A_BRANDS else None
    if head.startswith(b"ID3"):
        return "mp3"
    # Frame MPEG audio: 11 bits de sync, capa III (o II/I) y bitrate/frecuencia válidos.
    if len(head) > 3 and head[0] == 0xFF and (head[1] & 0xE0) == 0xE0 and (head[1] & 0x06) != 0 \
            and (head[2] & 0xF0) != 0xF0 and (head[2] & 0x0C) != 0x0C:
        return "mp3"
    return None


class ValidationError(Exception):
    def __init__(self, code: str, detail: str) -> None:
        super().__init__(f"{code}: {detail}")
        self.code = code
        self.detail = detail


@dataclass(frozen=True)
class FileInfo:
    kind: str           # pdf | docx | pptx | xlsx | image | html | markdown | text | audio
    size: int
    audio_format: str | None = None     # mp3 | wav | flac | ogg | m4a


def _check_zip(data: bytes) -> zipfile.ZipFile:
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise ValidationError("corrupt_archive", "ZIP/OOXML inválido") from exc
    infos = zf.infolist()
    if len(infos) > MAX_ZIP_ENTRIES:
        raise ValidationError("zip_bomb", "demasiadas entradas")
    total = 0
    for info in infos:
        if info.flag_bits & 0x1:
            raise ValidationError("encrypted_file", "archivo cifrado no admitido")
        if ".." in info.filename or info.filename.startswith("/"):
            raise ValidationError("zip_path_traversal", info.filename)
        total += info.file_size
        if info.compress_size and info.file_size / info.compress_size > MAX_ZIP_RATIO and info.file_size > 1_000_000:
            raise ValidationError("zip_bomb", "ratio de compresión sospechoso")
    if total > MAX_ZIP_UNCOMPRESSED:
        raise ValidationError("zip_bomb", "tamaño descomprimido excesivo")
    return zf


def sniff(data: bytes, filename: str) -> str:
    head = data[:2048]
    lower = filename.lower()
    if head.startswith(b"%PDF-"):
        return "pdf"
    if head.startswith(b"PK\x03\x04"):
        zf = _check_zip(data)
        names = set(zf.namelist())
        ooxml = {"word/document.xml": "docx", "ppt/presentation.xml": "pptx", "xl/workbook.xml": "xlsx"}
        kind = next((k for part, k in ooxml.items() if part in names), None)
        if kind is None:
            raise ValidationError("unsupported_type", "archivo ZIP no soportado")
        if any(n.lower().endswith("vbaproject.bin") for n in names):
            raise ValidationError("macro_document", "documentos con macros no admitidos")
        if any(n.lower().startswith(("word/embeddings/", "ppt/embeddings/", "xl/embeddings/"))
               and n.lower().endswith((".exe", ".dll", ".js", ".vbs", ".bat", ".cmd", ".ps1")) for n in names):
            raise ValidationError("embedded_executable", "objeto embebido ejecutable no admitido")
        return kind
    image = inspect_image(data[:IMAGE_HEADER_BYTES])
    if image is not None:
        if image.mime not in ("image/png", "image/jpeg"):
            raise ValidationError("unsupported_type", f"imagen {image.mime} no admitida (PNG/JPEG)")
        return "image"
    if sniff_audio(head) is not None:
        return "audio"
    if head.startswith((b"\xd0\xcf\x11\xe0", b"MZ", b"\x7fELF", b"\xca\xfe\xba\xbe")):
        raise ValidationError("unsupported_type", "binario/OLE no admitido")
    if b"\x00" in head:
        raise ValidationError("unsupported_type", "binario desconocido")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValidationError("bad_encoding", "texto no UTF-8") from exc
    stripped = text.lstrip().lower()
    if lower.endswith((".html", ".htm")) or stripped.startswith(("<!doctype html", "<html")):
        return "html"
    if lower.endswith((".md", ".markdown")):
        return "markdown"
    return "text"


def validate(data: bytes, filename: str, declared_type: str, declared_size: int, max_bytes: int) -> FileInfo:
    size = len(data)
    if size == 0:
        raise ValidationError("empty_file", "archivo vacío")
    if size > max_bytes:
        raise ValidationError("too_large", f"{size} > {max_bytes} bytes")
    if size != declared_size:
        raise ValidationError("size_mismatch", f"declarado {declared_size}, real {size}")
    kind = sniff(data, filename)
    declared = declared_type.split(";")[0].strip().lower()
    if declared not in ALLOWED[kind]:
        raise ValidationError("mime_mismatch", f"declarado {declared}, detectado {kind}")
    if kind == "audio":
        fmt = sniff_audio(data[:2048])
        if declared not in AUDIO_MIME[fmt]:
            raise ValidationError("mime_mismatch", f"declarado {declared}, detectado audio {fmt}")
        return FileInfo(kind, size, fmt)
    if kind == "image":
        info = inspect_image(data[:IMAGE_HEADER_BYTES])
        if info is None:
            raise ValidationError("corrupt_image", "cabecera de imagen inválida")
        if declared != info.mime:
            raise ValidationError("mime_mismatch", f"declarado {declared}, detectado {info.mime}")
        if info.pixels > get_settings().vision_max_image_pixels:
            raise ValidationError("image_too_large", f"{info.width}x{info.height} px excede el límite")
    if kind == "pdf":
        from pypdf import PdfReader
        from pypdf.errors import PdfReadError

        try:
            reader = PdfReader(io.BytesIO(data))
            if reader.is_encrypted:
                raise ValidationError("encrypted_file", "PDF cifrado no admitido")
        except PdfReadError as exc:
            raise ValidationError("corrupt_pdf", str(exc)[:200]) from exc
    return FileInfo(kind, size)
