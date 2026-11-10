"""Texto plano y Markdown: encabezados '#', tablas pipe y párrafos."""

from __future__ import annotations

import re

from ragsis_core.text import normalize

from .model import Block, ParsedDocument

_HEADING = re.compile(r"^(#{1,6})\s+(.*)$")
_NUMBERED_HEADING = re.compile(r"^((?:\d+\.)+\d*|[IVXLC]+\.|ART[IÍ]CULO\s+\d+|CAP[IÍ]TULO\s+\w+)\s*[.:-]?\s+(.{3,90})$", re.I)
_TABLE_ROW = re.compile(r"^\s*\|.*\|\s*$")


def _flush(par: list[str], blocks: list[Block], page: int | None) -> None:
    if par:
        text = normalize(" ".join(par))
        if text:
            blocks.append(Block("paragraph", text, page=page))
        par.clear()


def parse_lines(lines: list[str], page: int | None = None, markdown: bool = True) -> list[Block]:
    blocks: list[Block] = []
    par: list[str] = []
    table: list[str] = []
    for raw in lines:
        line = raw.rstrip()
        if _TABLE_ROW.match(line):
            _flush(par, blocks, page)
            table.append(line.strip())
            continue
        if table:
            blocks.append(Block("table", "\n".join(table), page=page))
            table = []
        if not line.strip():
            _flush(par, blocks, page)
            continue
        m = _HEADING.match(line) if markdown else None
        if m:
            _flush(par, blocks, page)
            blocks.append(Block("heading", normalize(m.group(2)), level=len(m.group(1)), page=page))
            continue
        m2 = _NUMBERED_HEADING.match(line.strip())
        if m2 and len(line) < 100 and not line.strip().endswith((".", ",")):
            _flush(par, blocks, page)
            depth = m2.group(1).count(".") or 1
            blocks.append(Block("heading", normalize(line.strip()), level=min(depth + 1, 6), page=page))
            continue
        if line.lstrip().startswith(("- ", "* ", "• ")):
            _flush(par, blocks, page)
            blocks.append(Block("list", normalize(line.lstrip()[2:]), page=page))
            continue
        par.append(line.strip())
    if table:
        blocks.append(Block("table", "\n".join(table), page=page))
    _flush(par, blocks, page)
    return blocks


def parse_text(data: bytes, markdown: bool) -> ParsedDocument:
    text = data.decode("utf-8").replace("\r\n", "\n")
    blocks = parse_lines(text.split("\n"), page=1, markdown=markdown)
    title = next((b.text for b in blocks if b.kind == "heading"), None)
    return ParsedDocument("markdown" if markdown else "text", "1", blocks, page_count=1, title=title)
