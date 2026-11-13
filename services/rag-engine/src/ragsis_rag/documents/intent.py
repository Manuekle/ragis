"""¿La persona pide un archivo? Detección de intención de documento en el chat (ADR-034).

Una pregunta como «Hazme una presentación en PowerPoint sobre la política de teletrabajo» no es una consulta: pide un
archivo. Se detecta con una regla deliberadamente conservadora: verbo de creación + formato o pieza documental
("un informe", "en PDF", "a CSV"). «¿Qué dice el PDF de la póliza?» sigue siendo una consulta normal (no hay verbo
de creación) y «dame el PDF del contrato» también (artículo definido: pide un archivo existente).

`topic` es la pregunta sin las palabras de instrucción: es lo que se usa para buscar. Si se buscara con «hazme una
presentación en PowerPoint», esas palabras no están en los documentos y bajarían la cobertura léxica de la evidencia.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from ragsis_core.text import content_terms, fold

FORMATS = ("pdf", "docx", "pptx", "xlsx", "csv", "md")
# Valores aceptados en `output`: "answer" = respuesta de chat sin detección (contrato anterior), "auto" = detectar.
OUTPUTS = ("answer", "auto", *FORMATS)

KIND_BY_FORMAT = {"pdf": "report", "docx": "report", "md": "report", "pptx": "presentation", "xlsx": "table",
                  "csv": "table"}


@dataclass(frozen=True)
class DocumentRequest:
    format: str      # pdf | docx | pptx | xlsx | csv | md
    kind: str        # report | presentation | table
    topic: str       # texto para la búsqueda (sin las palabras de instrucción)
    explicit: bool   # elegido en la interfaz, no detectado


# Todo se compara sobre `fold()` (minúsculas, sin tildes).
_VERB = (r"(?:genera(?:r|me)?|crea(?:r|me)?|haz(?:me)?|hacer(?:me)?|elabora(?:r|me)?|redacta(?:r|me)?|"
         r"prepara(?:r|me)?|arma(?:r|me)?|exporta(?:r|me)?|convierte(?:me)?|convertir|pasa(?:r|me)?|monta(?:r|me)?|"
         r"construye(?:me)?|disena(?:r|me)?|make|create|generate|draft|write|prepare|export|build|produce|"
         r"turn|convert|put together|design)")
_FORMAT_WORDS: tuple[tuple[str, str], ...] = (
    ("pptx", r"power ?points?|pptx?|presentaci(?:on|ones)|diapositivas?|slides?|slide deck|deck|keynote"),
    ("docx", r"word|docx|\.doc|documento(?: de)? word|documento editable"),
    ("xlsx", r"excel|xlsx|hojas? de calculo|spreadsheets?|planillas?|libro de excel|workbook"),
    ("csv", r"csv"),
    ("pdf", r"pdf"),
    ("md", r"markdown|\.md"),
)
# Piezas documentales sin formato explícito y el formato que se usa por defecto.
_ARTIFACTS: tuple[tuple[str, str], ...] = (
    ("pdf", r"informes?|reportes?|reports?|memos?|memorandos?|memorandums?|resumen ejecutivo|executive summary|"
            r"briefs?|one[- ]pager|minutas?|dossier"),
    ("docx", r"documentos?|documents?|cartas?|letters?"),
    ("xlsx", r"tablas?|tables?|listados? descargables?"),
)
_INDEF = r"(?:un|una|unos|unas|a|an|el siguiente|this|nuevo|nueva|new)"
_ALL_FORMATS = "|".join(rx for _, rx in _FORMAT_WORDS)
_ALL_ARTIFACTS = "|".join(rx for _, rx in _ARTIFACTS)

_VERB_RX = re.compile(rf"\b{_VERB}\b")
# "en PDF", "en formato Word", "a CSV", "as a PowerPoint", "into slides", "como presentación"
_TARGET_RX = re.compile(rf"\b(?:en|a|como|as|in|into|to)\s+(?:(?:un|una|a|an)\s+)?(?:formato\s+|format\s+)?"
                        rf"(?:{_ALL_FORMATS})\b")
_INDEF_RX = re.compile(rf"\b{_INDEF}\s+(?:\w+\s+)?(?:{_ALL_FORMATS}|{_ALL_ARTIFACTS})\b")
# «¿Quién debe crear un informe de incidentes?» o «How do I export to PDF?» preguntan por los documentos, no
# piden un archivo: una pregunta que empieza con interrogativo nunca se detecta (la interfaz puede forzar formato).
_QUESTION_RX = re.compile(r"^\W*(?:que|cual(?:es)?|quien(?:es)?|cuando|donde|como|cuant[oa]s?|por que|what|which|"
                          r"who|whom|whose|when|where|why|how|is|are|does|do|did|should|must|was|were)\b")
_FORMAT_RX = [(fmt, re.compile(rf"\b(?:{rx})\b")) for fmt, rx in _FORMAT_WORDS]
_ARTIFACT_RX = [(fmt, re.compile(rf"\b(?:{rx})\b")) for fmt, rx in _ARTIFACTS]

# Lo que se quita de la pregunta para obtener el tema de búsqueda.
_STRIP_RX = re.compile(
    rf"\b(?:{_VERB}|{_ALL_FORMATS}|{_ALL_ARTIFACTS}|formato|format|archivo|file|descargable|downloadable|"
    r"profesional(?:es)?|professional|breve|corto|corta|short|detallad[oa]s?|detailed|completo|completa|"
    r"por favor|please|quiero|necesito|dame|give me|i need|i want|can you|could you|puedes|podrias|"
    r"resumen|resume|resumiendo|resumir|summari[sz]e|summari[sz]ing|summary|overview|explica(?:ndo)?|explain(?:ing)?|"
    r"con|with|que|that|which|y|and)\b")
_LEAD_RX = re.compile(r"^(?:(?:un|una|unos|unas|el|la|los|las|a|an|the|en|a|as|in|into|to|de|del|sobre|acerca de|"
                      r"about|on|for|of|para|mi|my|me|nos|us)\s+)+")
_TRAIL_RX = re.compile(r"(?:\s+(?:a|al|en|de|del|para|por|como|y|o|to|in|into|as|of|for|on|and|or|the|un|una|a))+$")
_WS = re.compile(r"\s+")


def _format_of(text: str) -> str | None:
    for fmt, rx in _FORMAT_RX:
        if rx.search(text):
            return fmt
    for fmt, rx in _ARTIFACT_RX:
        if rx.search(text):
            return fmt
    return None


def topic_of(question: str) -> str:
    """La pregunta sin verbo de creación, formato ni relleno («hazme una presentación sobre X» → «X»)."""
    folded = fold(question)
    # Se trabaja sobre el texto plegado para que coincidan las reglas; la búsqueda también pliega, no se pierde nada.
    stripped = _STRIP_RX.sub(" ", re.sub(r"[¿?¡!,;:()\"“”]", " ", folded))
    stripped = _WS.sub(" ", stripped).strip()
    stripped = _TRAIL_RX.sub("", _LEAD_RX.sub("", stripped)).strip(" .")
    return stripped if content_terms(stripped) else question


def detect(question: str) -> DocumentRequest | None:
    """Pedido de archivo detectado en el texto; None si es una consulta normal."""
    text = fold(question)
    if _QUESTION_RX.search(text) or not _VERB_RX.search(text):
        return None
    if not (_TARGET_RX.search(text) or _INDEF_RX.search(text)):
        return None
    fmt = _format_of(text)
    if fmt is None:
        return None
    return DocumentRequest(fmt, KIND_BY_FORMAT[fmt], topic_of(question), explicit=False)


def resolve(output: str, question: str) -> DocumentRequest | None:
    """`output` del cliente: "answer" nunca genera archivo, "auto" detecta, un formato lo fuerza."""
    if output == "answer":
        return None
    if output == "auto":
        return detect(question)
    if output not in FORMATS:
        raise ValueError(f"formato no soportado: {output}")
    return DocumentRequest(output, KIND_BY_FORMAT[output], topic_of(question), explicit=True)
