"""Post-proceso de layout común a los parsers: asociar captions a figuras, tablas y ecuaciones."""

from __future__ import annotations

from .model import Block
from .ooxml import caption_targets_table

VISUAL = ("figure", "table", "equation")


def caption_candidate(text: str, page: int | None = None) -> Block:
    return Block("paragraph", text, page=page, meta={"caption_candidate": True})


def attach_captions(blocks: list[Block]) -> list[Block]:
    """Une cada caption candidato al elemento visual adyacente sin caption.

    Convención editorial: el epígrafe de una tabla va encima (se prueba el siguiente bloque primero) y el
    de una figura debajo (se prueba el anterior primero). Si no hay pareja, queda como párrafo normal.
    """
    used: set[int] = set()
    for i, b in enumerate(blocks):
        if not b.meta.pop("caption_candidate", False):
            continue
        wants_table = caption_targets_table(b.text)
        order = (i + 1, i - 1) if wants_table else (i - 1, i + 1)
        for j in order:
            if not 0 <= j < len(blocks) or j in used:
                continue
            t = blocks[j]
            if t.kind not in VISUAL or t.caption or (t.kind == "table") != wants_table:
                continue
            t.caption = b.text
            used.add(i)
            break
    return [b for i, b in enumerate(blocks) if i not in used]
