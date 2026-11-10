"""HTML con el parser de la stdlib: encabezados, párrafos, listas y tablas. Ignora script/style."""

from __future__ import annotations

from html.parser import HTMLParser

from ragsis_core.text import normalize

from .model import Block, ParsedDocument

_SKIP = {"script", "style", "noscript", "template", "svg", "head"}
_BLOCK = {"p", "div", "section", "article", "li", "br", "blockquote", "pre"}


class _Extractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.blocks: list[Block] = []
        self.buf: list[str] = []
        self.skip = 0
        self.heading: int | None = None
        self.in_li = False
        self.table: list[list[str]] | None = None
        self.cell: list[str] | None = None

    def _flush(self) -> None:
        text = normalize(" ".join(self.buf))
        self.buf = []
        if not text:
            return
        if self.heading:
            self.blocks.append(Block("heading", text, level=self.heading))
        elif self.in_li:
            self.blocks.append(Block("list", text))
        else:
            self.blocks.append(Block("paragraph", text))

    def handle_starttag(self, tag, attrs):
        if tag in _SKIP:
            self.skip += 1
            return
        if self.skip:
            return
        if tag == "table":
            self._flush()
            self.table = []
        elif tag == "tr" and self.table is not None:
            self.table.append([])
        elif tag in ("td", "th") and self.table is not None:
            self.cell = []
        elif tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self._flush()
            self.heading = int(tag[1])
        elif tag == "li":
            self._flush()
            self.in_li = True
        elif tag in _BLOCK:
            self._flush()

    def handle_endtag(self, tag):
        if tag in _SKIP:
            self.skip = max(0, self.skip - 1)
            return
        if self.skip:
            return
        if tag in ("td", "th") and self.table is not None and self.cell is not None:
            if not self.table:
                self.table.append([])
            self.table[-1].append(normalize(" ".join(self.cell)).replace("|", "/"))
            self.cell = None
        elif tag == "table" and self.table is not None:
            rows = ["| " + " | ".join(r) + " |" for r in self.table if r]
            if rows:
                self.blocks.append(Block("table", "\n".join(rows)))
            self.table = None
        elif tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self._flush()
            self.heading = None
        elif tag == "li":
            self._flush()
            self.in_li = False
        elif tag in _BLOCK:
            self._flush()

    def handle_data(self, data):
        if self.skip:
            return
        if self.cell is not None:
            self.cell.append(data)
        elif self.table is None:
            self.buf.append(data)


def parse_html(data: bytes) -> ParsedDocument:
    ex = _Extractor()
    ex.feed(data.decode("utf-8"))
    ex.close()
    ex._flush()
    title = next((b.text for b in ex.blocks if b.kind == "heading"), None)
    return ParsedDocument("html-stdlib", "1", ex.blocks, page_count=1, title=title)
