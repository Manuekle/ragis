"""Chunking estructural: respeta secciones, nunca parte una tabla salvo que exceda el máximo
(en cuyo caso divide por filas repitiendo el encabezado y el caption). Solapamiento bajo: última oración.
Figuras y ecuaciones son chunks propios (kind figure/equation) con bbox, activo S3 y metadatos.
Los tramos de audio (kind audio) son chunks propios con su rango de tiempo (meta.t_start / meta.t_end)."""

from __future__ import annotations

from dataclasses import dataclass, field

from ragsis_core.text import estimate_tokens, split_sentences

from .parsers.model import BBox, Block

TARGET_TOKENS = 600
MAX_TOKENS = 900
MIN_TOKENS = 60


@dataclass
class Chunk:
    ordinal: int
    text: str
    section_path: str
    page_start: int | None
    page_end: int | None
    char_start: int
    char_end: int
    kind: str
    token_count: int
    bbox: BBox | None = None
    asset_key: str | None = None
    meta: dict = field(default_factory=dict)


class Chunker:
    def __init__(self, target: int = TARGET_TOKENS, maximum: int = MAX_TOKENS) -> None:
        self.target = target
        self.maximum = maximum

    def chunk(self, blocks: list[Block]) -> list[Chunk]:
        out: list[Chunk] = []
        path: list[tuple[int, str]] = []
        buf: list[str] = []
        pages: list[int] = []
        cursor = 0          # offset de caracteres en el texto lineal del documento
        buf_start = 0
        overlap = ""

        def section() -> str:
            return " > ".join(t for _, t in path)

        def emit(text: str, kind: str, start: int, end: int, pgs: list[int], bbox: BBox | None = None,
                 asset_key: str | None = None, meta: dict | None = None) -> None:
            text = text.strip()
            if not text:
                return
            out.append(Chunk(len(out), text, section(), min(pgs) if pgs else None, max(pgs) if pgs else None,
                             start, end, kind, estimate_tokens(text), bbox, asset_key, dict(meta or {})))

        def flush() -> None:
            nonlocal buf, pages, overlap
            if not buf:
                return
            body = "\n".join(buf)
            # Tokens del overlap no cuentan para decidir; se antepone para contexto.
            text = f"{overlap} {body}".strip() if overlap else body
            emit(text, "text", buf_start, cursor, pages)
            sents = split_sentences(buf[-1])
            overlap = sents[-1] if sents and estimate_tokens(sents[-1]) < 60 else ""
            buf, pages = [], []

        for b in blocks:
            length = len(b.text) + 1
            if b.kind == "heading":
                flush()
                overlap = ""
                while path and path[-1][0] >= b.level:
                    path.pop()
                path.append((b.level, b.text[:120]))
                cursor += length
                continue
            if b.kind == "table":
                flush()
                overlap = ""
                parts = self._split_table(b.text)
                meta = {**b.meta, **({"caption": b.caption} if b.caption else {})}
                summary = b.meta.get("summary")
                for k, part in enumerate(parts):
                    head = [b.caption] if b.caption else []
                    if summary and k == 0:
                        head.append(f"Resumen de la tabla (generado por IA): {summary}")
                    body = "\n".join([*head, part])
                    emit(body, "table", cursor, cursor + length, [b.page] if b.page else [],
                         b.bbox if len(parts) == 1 else None, None, meta)
                cursor += length
                continue
            if b.kind == "audio":
                # Tramo de una grabación: ya viene acotado por tokens y con su rango de tiempo en meta.
                flush()
                overlap = ""
                emit(b.text, "audio", cursor, cursor + length, [], None, None, b.meta)
                cursor += length
                continue
            if b.kind in ("figure", "equation"):
                # La figura llega con su texto indexable final (caption + descripción) desde el enriquecedor;
                # sin texto (sin VLM ni caption) no se indexa.
                flush()
                overlap = ""
                body = b.text if b.kind == "figure" or not b.caption else f"{b.caption}\n{b.text}"
                if b.kind == "equation" and b.meta.get("analysis"):
                    body = f"{body}\nAnálisis de la ecuación (generado por IA): {b.meta['analysis']}"
                meta = {**b.meta, **({"caption": b.caption} if b.caption else {})}
                emit(body, b.kind, cursor, cursor + length, [b.page] if b.page else [], b.bbox, b.asset_key, meta)
                cursor += length
                continue
            # párrafo / lista
            for piece in self._split_long(b.text):
                tokens = estimate_tokens(piece)
                current = estimate_tokens("\n".join(buf))
                if buf and current + tokens > self.target:
                    flush()
                if not buf:
                    buf_start = cursor
                buf.append(piece)
                if b.page:
                    pages.append(b.page)
            cursor += length
        flush()
        return self._merge_tiny(out)

    def _split_long(self, text: str) -> list[str]:
        if estimate_tokens(text) <= self.maximum:
            return [text]
        parts, cur = [], []
        for s in split_sentences(text):
            if cur and estimate_tokens(" ".join(cur + [s])) > self.target:
                parts.append(" ".join(cur))
                cur = []
            cur.append(s)
        if cur:
            parts.append(" ".join(cur))
        # oraciones gigantes (sin puntuación): corte duro por palabras
        final = []
        for p in parts:
            if estimate_tokens(p) <= self.maximum:
                final.append(p)
                continue
            words = p.split()
            step = int(self.target / 1.3)
            final.extend(" ".join(words[i:i + step]) for i in range(0, len(words), step))
        return final

    def _split_table(self, table: str) -> list[str]:
        if estimate_tokens(table) <= self.maximum:
            return [table]
        rows = table.split("\n")
        header = rows[:2] if len(rows) > 1 and set(rows[1].replace("|", "").strip()) <= {"-", ":", " "} else rows[:1]
        body = rows[len(header):]
        parts, cur = [], []
        for r in body:
            if cur and estimate_tokens("\n".join(header + cur + [r])) > self.target:
                parts.append("\n".join(header + cur))
                cur = []
            cur.append(r)
        if cur:
            parts.append("\n".join(header + cur))
        return parts

    def _merge_tiny(self, chunks: list[Chunk]) -> list[Chunk]:
        merged: list[Chunk] = []
        for c in chunks:
            prev = merged[-1] if merged else None
            if (prev and c.kind == "text" and prev.kind == "text" and prev.section_path == c.section_path
                    and (c.token_count < MIN_TOKENS or prev.token_count < MIN_TOKENS)
                    and prev.token_count + c.token_count <= self.maximum):
                prev.text = f"{prev.text}\n{c.text}"
                prev.token_count = estimate_tokens(prev.text)
                prev.char_end = c.char_end
                prev.page_end = c.page_end if c.page_end is not None else prev.page_end
                if prev.page_start is None:
                    prev.page_start = c.page_start
                continue
            merged.append(c)
        for i, c in enumerate(merged):
            c.ordinal = i
        return merged
