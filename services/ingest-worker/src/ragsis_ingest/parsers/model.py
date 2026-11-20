from __future__ import annotations

from dataclasses import dataclass, field

BBox = tuple[float, float, float, float]   # [x0, y0, x1, y1] normalizado 0..1, origen arriba-izquierda


def clamp_bbox(x0: float, y0: float, x1: float, y1: float) -> BBox | None:
    """Normaliza y valida una caja (ya dividida por el tamaño de página). None si es degenerada."""
    vals = [min(max(float(v), 0.0), 1.0) for v in (x0, y0, x1, y1)]
    a, b, c, d = min(vals[0], vals[2]), min(vals[1], vals[3]), max(vals[0], vals[2]), max(vals[1], vals[3])
    if c - a <= 0 or d - b <= 0:
        return None
    return (round(a, 4), round(b, 4), round(c, 4), round(d, 4))


@dataclass
class Block:
    kind: str                 # heading | paragraph | list | table | figure | equation | audio
    text: str                 # figura: descripción/caption; ecuación: LaTeX o texto lineal
    level: int = 0            # nivel de heading
    page: int | None = None
    bbox: BBox | None = None
    caption: str = ""         # caption/epígrafe asociado (tablas, figuras, ecuaciones)
    image: bytes | None = None        # bytes crudos de la figura (se suben a S3 y se descartan)
    image_mime: str | None = None
    asset_key: str | None = None      # clave S3 del activo derivado (la fija el enriquecedor)
    meta: dict = field(default_factory=dict)


@dataclass
class ParsedDocument:
    parser: str
    parser_version: str
    blocks: list[Block]
    page_count: int
    title: str | None = None
    warnings: list[str] = field(default_factory=list)
    low_text_pages: list[int] = field(default_factory=list)   # candidatas a OCR
