"""Verificador de citas y grounding.

- Solo se aceptan citas [n] que apuntan a evidencia autorizada entregada al modelo.
- Cada oración citada debe compartir contenido con su fuente (overlap lexical mínimo).
- Toda cifra de una oración debe aparecer literalmente en alguna de sus fuentes citadas.
- Oraciones sustantivas sin cita válida se eliminan; si no queda respaldo, se abstiene.
- Citas incompletas se completan: si una oración encadena hechos de dos fuentes (multi-hop) pero el modelo cita solo
  una, y otra fuente entregada cubre los términos que la citada no tiene, se agrega su [n]. Los modelos pequeños
  suelen citar una sola fuente aunque la respuesta use dos.
- Las oraciones no se parten en abreviaturas («el num. 4 del art. 93», «M.P. Carlos Camargo Assis») ni entre una
  etiqueta y su valor («Ponente: …»): partirlas dejaba un trozo sin cita que se descartaba y cambiaba lo afirmado.
- Una negrita que abría o cerraba en una oración descartada no queda como «**» suelto (se revisa en cada línea).
- Se verifica línea por línea y se conservan los saltos de línea y los marcadores Markdown (viñetas, listas
  numeradas, títulos, citas en bloque): la web muestra la respuesta como Markdown.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from ragsis_ai.types import Evidence
from ragsis_core.text import content_terms, split_sentences

from .prompting import is_abstention

_CITE = re.compile(r"\[(\d{1,2})\]")
_NUMBER = re.compile(r"\d+(?:[.,]\d+)*")
_AFTER_CITE = re.compile(r"(?<=\])\s+(?=[A-ZÁÉÍÓÚÑ¿¡])")
# Sangría y marcador Markdown de la línea (título, viñeta, lista numerada, cita en bloque): se conserva tal cual y
# solo se verifica el texto que sigue.
_BLOCK = re.compile(r"^(\s*(?:#{1,6}\s+(?:\d{1,3}[.)]\s+)?|[-*+]\s+|\d{1,3}[.)]\s+|>\s*)?)(.*)$")
# Una línea que no cierra la oración seguida de otra que empieza en minúscula es la misma oración partida en dos.
_OPEN_END = re.compile(r"[^.!?;:\]*_]$")
_LOWER_START = re.compile(r"^\s*[a-záéíóúñü]")
MIN_OVERLAP = 0.2
# Términos de la oración ausentes en sus fuentes citadas que otra fuente debe cubrir para agregarla como cita.
MIN_COMPLETION_TERMS = 2


@dataclass
class Verification:
    answer: str
    cited: list[int]
    abstained: bool
    reason: str | None = None
    dropped_sentences: int = 0
    invalid_citations: list[int] = field(default_factory=list)


def _norm_num(s: str) -> str:
    return s.replace(".", "").replace(",", "")


def _supported(sentence: str, sources: list[Evidence]) -> bool:
    claim = set(content_terms(_CITE.sub("", sentence)))
    if not claim:
        return True
    src_terms: set[str] = set()
    src_text = ""
    for s in sources:
        src_terms.update(content_terms(s.text))
        src_text += " " + s.text
    overlap = len(claim & src_terms) / len(claim)
    if overlap < MIN_OVERLAP:
        return False
    src_nums = {_norm_num(n) for n in _NUMBER.findall(src_text)}
    for num in _NUMBER.findall(_CITE.sub("", sentence)):
        if len(_norm_num(num)) >= 2 and _norm_num(num) not in src_nums:
            return False
    return True


def _completion(sentence: str, valid: list[int], terms: dict[int, set[str]]) -> list[int]:
    """Fuentes no citadas que cubren lo que la oración afirma y sus fuentes citadas no contienen."""
    missing = set(content_terms(_CITE.sub("", sentence))) - set().union(*(terms[n] for n in valid))
    extra: list[int] = []
    while len(missing) >= MIN_COMPLETION_TERMS:
        gain, n = max(((len(missing & t), n) for n, t in terms.items() if n not in valid and n not in extra),
                      default=(0, 0))
        if gain < MIN_COMPLETION_TERMS:
            break
        extra.append(n)
        missing -= terms[n]
    return extra


_STRONG = re.compile(r"\*\*")


def balance_strong(text: str) -> str:
    """Quita los «**» sin pareja. Al descartar una oración sin respaldo puede quedar suelta la negrita que abría o
    cerraba en ella («Ponente: Carlos Camargo Assis [2].**»), y la web la mostraría como asteriscos literales.

    Un «**» con texto pegado a la izquierda cierra la negrita abierta; con texto pegado a la derecha abre una nueva.
    """
    orphans: list[int] = []
    opened: list[int] = []
    for m in _STRONG.finditer(text):
        before = text[m.start() - 1] if m.start() else " "
        after = text[m.end()] if m.end() < len(text) else " "
        if not before.isspace() and opened:
            opened.pop()
        elif not after.isspace():
            opened.append(m.start())
        else:
            orphans.append(m.start())
    for i in sorted(orphans + opened, reverse=True):
        left, right = text[:i], text[i + 2:]
        text = left.rstrip(" ") + " " + right.lstrip(" ") if left.endswith(" ") and right.startswith(" ") else left + right
    return text.strip()


def renumber_citations(text: str, cited: list[int]) -> tuple[str, dict[int, int]]:
    """Numera las citas 1, 2, 3… por orden de primera aparición en `text` y devuelve el texto y {n anterior: nuevo}.

    El modelo cita con el número del fragmento dentro de la evidencia que recibió; mostrado tal cual, una respuesta con
    siete fuentes salía como [8], [4], [3]… Las citas válidas que no aparecen en el texto van al final, en su orden.
    Un corchete que no es una cita válida no se toca."""
    valid = set(cited)
    order: list[int] = []
    for m in _CITE.finditer(text):
        n = int(m.group(1))
        if n in valid and n not in order:
            order.append(n)
    order += [n for n in cited if n not in order]
    mapping = {old: i + 1 for i, old in enumerate(order)}
    renumbered = _CITE.sub(lambda m: f"[{mapping[int(m.group(1))]}]" if int(m.group(1)) in mapping else m.group(0),
                           text)
    return renumbered, mapping


def _add_citations(sentence: str, extra: list[int]) -> str:
    last = list(_CITE.finditer(sentence))[-1]
    marks = "".join(f"[{n}]" for n in extra)
    return sentence[:last.end()] + marks + sentence[last.end():]


def _lines(text: str) -> list[str]:
    """Líneas de la respuesta, uniendo las que solo parten una oración en dos."""
    out: list[str] = []
    for raw in text.replace("\r\n", "\n").split("\n"):
        line = raw.rstrip()
        if out and out[-1].strip() and line.strip() and _OPEN_END.search(out[-1]) and _LOWER_START.match(line):
            out[-1] += " " + line.strip()
        else:
            out.append(line)
    return out


def verify(answer: str, evidence: list[Evidence]) -> Verification:
    by_n = {e.n: e for e in evidence}
    terms = {e.n: set(content_terms(e.text)) for e in evidence}
    text = answer.strip()
    if not text or is_abstention(text):
        return Verification(text or "", [], True, "model_abstained")

    lines: list[str] = []
    cited: list[int] = []
    invalid: list[int] = []
    dropped = 0
    for line in _lines(text):
        if not line.strip():
            if lines and lines[-1]:
                lines.append("")
            continue
        prefix, body = _BLOCK.match(line).groups()
        kept: list[str] = []
        for sent in (s for part in _AFTER_CITE.split(body) for s in split_sentences(part)):
            refs = [int(n) for n in _CITE.findall(sent)]
            valid = [n for n in refs if n in by_n]
            invalid.extend(n for n in refs if n not in by_n)
            clean = _CITE.sub(lambda m: m.group(0) if int(m.group(1)) in by_n else "", sent).strip()
            if not valid:
                # Conectores cortos sin contenido verificable se conservan; afirmaciones no.
                if len(content_terms(clean)) <= 3 and not _NUMBER.search(clean):
                    kept.append(clean)
                else:
                    dropped += 1
                continue
            if not _supported(clean, [by_n[n] for n in valid]):
                dropped += 1
                continue
            extra = _completion(clean, valid, terms)
            if extra:
                clean = _add_citations(clean, extra)
                valid = valid + extra
            kept.append(clean)
            cited.extend(n for n in valid if n not in cited)
        body = balance_strong(" ".join(s for s in kept if s))
        if body:
            lines.append(f"{prefix}{body}")

    if not cited:
        return Verification("", [], True, "no_verified_citations", dropped, invalid)
    return Verification("\n".join(lines).strip(), cited, False, None, dropped, invalid)
