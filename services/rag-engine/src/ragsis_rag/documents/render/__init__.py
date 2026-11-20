"""Conversor de documentos: Markdown verificado → PDF, Word, PowerPoint, Excel, CSV o Markdown (ADR-034)."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

from ..model import Document, build_document, slug, source_label

MIME = {
    "pdf": "application/pdf",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "csv": "text/csv; charset=utf-8",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "md": "text/markdown; charset=utf-8",
}


@dataclass(frozen=True)
class Rendered:
    data: bytes
    mime: str
    filename: str


def _markdown(doc: Document, markdown: str) -> bytes:
    """El Markdown tal cual se guardó, con la lista de fuentes añadida (igual que en los demás formatos)."""
    text = markdown.rstrip() + "\n"
    if doc.sources:
        lab = doc.labels
        text += f"\n## {lab['sources']}\n\n" + "\n".join(f"[{s.n}] {source_label(s, doc.language)}  "
                                                       for s in doc.sources) + "\n"
        text += f"\n> {lab['ai_note']}\n"
    return text.encode("utf-8")


def render(markdown: str, fmt: str, citations: list[dict], *, kind: str = "report", title: str = "Document",
           created: date | None = None, page: str = "A4") -> Rendered:
    doc = build_document(markdown, citations, kind=kind, fallback_title=title, created=created)
    name = slug(doc.title)
    if fmt == "pdf":
        from .pdf import render_pdf
        data = render_pdf(doc, page)
    elif fmt == "docx":
        from .docx import render_docx
        data = render_docx(doc, page)
    elif fmt == "pptx":
        from .pptx import render_pptx
        data = render_pptx(doc)
    elif fmt == "csv":
        from .csv import render_csv
        data = render_csv(doc)
    elif fmt == "xlsx":
        from .xlsx import render_xlsx
        data = render_xlsx(doc, page)
    elif fmt == "md":
        data = _markdown(doc, markdown)
    else:
        raise ValueError(f"formato no soportado: {fmt}")
    return Rendered(data, MIME[fmt], f"{name}.{fmt}")
