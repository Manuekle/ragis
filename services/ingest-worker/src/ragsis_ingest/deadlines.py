"""Candidate procedural deadlines ("términos") found in an indexed document (ADR-038).

Deterministic patterns, no model: every candidate carries the literal sentence it came from and the page of the block
that holds it, so the citation is exact by construction. A candidate is only a suggestion; a person confirms it in the
web (and fills the date the term starts from and who is responsible) before it becomes a deadline.

What it recognises, in Spanish legal prose:
  - "término de diez (10) días", "plazo de seis meses", "dentro de los cinco días hábiles siguientes a la notificación",
    "traslado por el término de tres días": a duration with a unit.
  - "a más tardar el 5 de diciembre de 2026", "hasta el día 30 de noviembre de 2026": a fixed date.

Days without a qualifier are business days ("hábiles"): art. 62 of Ley 4 de 1913 and art. 118 of the Código General del
Proceso leave out holidays and court vacancy in terms of days unless the text says otherwise. The web shows that
assumption next to the candidate so the lawyer can change it.

It only runs on documents that read like court documents (two or more judicial markers), so contracts and memos with
"plazo de 30 días" do not flood the review queue.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from dataclasses import dataclass
from datetime import date

from ragsis_core.text import fold

MAX_QUOTE = 600
MAX_PER_DOCUMENT = 60

UNITS = ("business_days", "calendar_days", "months", "years", "fixed")

_UNITS_ONES = {
    "un": 1, "uno": 1, "una": 1, "dos": 2, "tres": 3, "cuatro": 4, "cinco": 5, "seis": 6, "siete": 7, "ocho": 8,
    "nueve": 9, "diez": 10, "once": 11, "doce": 12, "trece": 13, "catorce": 14, "quince": 15, "dieciseis": 16,
    "diecisiete": 17, "dieciocho": 18, "diecinueve": 19, "veinte": 20, "veintiun": 21, "veintiuno": 21, "veintiuna": 21,
    "veintidos": 22, "veintitres": 23, "veinticuatro": 24, "veinticinco": 25, "veintiseis": 26, "veintisiete": 27,
    "veintiocho": 28, "veintinueve": 29,
}
_TENS = {"treinta": 30, "cuarenta": 40, "cincuenta": 50, "sesenta": 60, "setenta": 70, "ochenta": 80, "noventa": 90}
_HUNDREDS = {"cien": 100, "ciento": 100, "doscientos": 200, "trescientos": 300}

_MONTHS = {
    "enero": 1, "febrero": 2, "marzo": 3, "abril": 4, "mayo": 5, "junio": 6, "julio": 7, "agosto": 8,
    "septiembre": 9, "setiembre": 9, "octubre": 10, "noviembre": 11, "diciembre": 12,
}

# A unit, optionally preceded by "(10)" and followed by a qualifier. Matched on folded text (no accents, lowercase).
_UNIT_RE = re.compile(
    r"(?:\((?P<digits>\d{1,4})\)\s*)?\b(?P<unit>dias?|mes(?:es)?|anos?)\b"
    r"(?:\s+(?P<qual>habiles?|calendarios?|calendario|corridos|comunes|naturales|calendarios))?")
_NUM_TOKEN_RE = re.compile(r"[a-z]+|\d{1,4}")
# Words that make a duration a term to act on, not a date in a narrative ("hace tres dias") or a fact ("doce meses
# despues del registro").
_DEADLINE_CUES = re.compile(
    r"\b(termino|plazo|lapso|dentro de|traslado|so pena|contados|contado|siguientes|a partir de|a mas tardar|"
    r"para que|vencimiento|vence|ejecutoria)\b")
_DATE_RE = re.compile(
    r"\b(?P<d>\d{1,2})(?:\s*\([^)]{1,20}\))?\s+de\s+(?P<m>" + "|".join(_MONTHS) + r")\s+(?:de|del)\s+(?P<y>\d{4})\b"
    r"|\b(?P<d2>\d{1,2})/(?P<m2>\d{1,2})/(?P<y2>\d{4})\b")
_FIXED_RE = re.compile(r"\b(?:a mas tardar|hasta)\s+(?:el\s+)?(?:dia\s+)?(?=\d)")
_BASIS_RE = re.compile(
    r"\b(?:art(?:iculo|\.)?s?)\s*(?P<num>\d{1,4}(?:\s*[-.]\s*\d{1,3})?)(?:\s*[°ºo]\b)?"
    r"(?P<rest>(?:\s*,?\s*(?:inciso|numeral|literal|paragrafo)\s+[\w°º]+)*"
    r"\s+(?:del?|de la)\s+(?:codigo general del proceso|c\.?\s?g\.?\s?p\.?|cpaca|codigo de procedimiento administrativo"
    r"(?: y de lo contencioso administrativo)?|codigo procesal del trabajo(?: y de la seguridad social)?|"
    r"codigo de procedimiento penal|decreto(?: ley)?\s+\d{1,5}\s+de\s+\d{4}|ley\s+\d{1,5}\s+de\s+\d{4}|"
    r"constitucion(?: politica)?))?")
_JUDICIAL_MARKERS = (
    "juzgado", "tribunal", "corte constitucional", "corte suprema", "consejo de estado", "magistrad", "despacho",
    "notifiquese", "resuelve", "radicado", "radicacion", "expediente", "auto ", "sentencia", "demandante",
    "demandado", "accionante", "secretaria",
)
# Verb or noun in the sentence -> what the term is for (suggested title; the lawyer edits it).
_PURPOSES = (
    ("subsan", "Subsanar la demanda"),
    ("corrija", "Corregir la demanda"),
    ("correccion de la demanda", "Corregir la demanda"),
    ("contest", "Contestar la demanda"),
    ("reposicion", "Recurso de reposición"),
    ("apelacion", "Recurso de apelación"),
    ("alegatos", "Alegatos de conclusión"),
    ("alegar", "Alegatos de conclusión"),
    ("fijar en lista", "Fijación en lista"),
    ("fijacion en lista", "Fijación en lista"),
    ("intervenir", "Intervención ciudadana"),
    ("traslado", "Traslado"),
    ("pruebas", "Aportar pruebas"),
    ("reglament", "Reglamentación ordenada"),
    ("informe", "Rendir informe"),
    ("cumpl", "Cumplimiento de la orden"),
    ("pague", "Pago ordenado"),
    ("pago", "Pago ordenado"),
)


@dataclass(frozen=True)
class Candidate:
    page: int | None
    quote: str              # literal text of the source, never rewritten
    amount: int | None      # None for a fixed date
    unit: str               # one of UNITS
    unit_assumed: bool      # "días" without "hábiles"/"calendario": business days by default
    trigger_hint: str       # notification | ejecutoria | filing | hearing | other
    trigger_date: date | None   # a date stated in the same sentence (date of the auto, or the fixed due date)
    legal_basis: str
    title: str
    block: int              # index of the block (or chunk) it came from

    @property
    def fingerprint(self) -> str:
        raw = f"{self.page}|{self.quote}|{self.amount}|{self.unit}|{self.trigger_date}"
        return hashlib.sha256(raw.encode()).hexdigest()[:32]


def parse_number(tokens: list[str]) -> int | None:
    """Spanish number words or digits -> int ("tres" 3, "treinta y cinco" 35, "ciento veinte" 120). None if not a number."""
    if not tokens:
        return None
    if len(tokens) == 1 and tokens[0].isdigit():
        return int(tokens[0])
    total, seen = 0, False
    for t in tokens:
        if t == "y" and seen:
            continue
        if t in _HUNDREDS:
            total += _HUNDREDS[t]
        elif t in _TENS:
            total += _TENS[t]
        elif t in _UNITS_ONES:
            total += _UNITS_ONES[t]
        else:
            return None
        seen = True
    return total or None


def _number_before(folded: str, end: int) -> int | None:
    """The number written right before position `end` (up to four words back), longest reading first."""
    window = folded[max(0, end - 60):end]
    toks = _NUM_TOKEN_RE.findall(window)[-4:]
    for k in range(len(toks), 0, -1):
        n = parse_number(toks[-k:])
        if n is not None:
            return n
    return None


def _parse_date(m: re.Match) -> date | None:
    try:
        if m.group("d"):
            return date(int(m.group("y")), _MONTHS[m.group("m")], int(m.group("d")))
        return date(int(m.group("y2")), int(m.group("m2")), int(m.group("d2")))
    except ValueError:
        return None


def _unit(word: str, qual: str | None) -> tuple[str, bool]:
    if word.startswith("mes"):
        return "months", False
    if word.startswith("ano"):
        return "years", False
    if qual and qual.startswith("habil"):
        return "business_days", False
    if qual:
        return "calendar_days", False
    return "business_days", True


def _trigger(folded: str) -> str:
    if "ejecutoria" in folded:
        return "ejecutoria"
    if "notific" in folded:
        return "notification"
    if "radicac" in folded or "presentacion de la demanda" in folded:
        return "filing"
    if "audiencia" in folded:
        return "hearing"
    return "other"


def _fold_map(text: str) -> tuple[str, list[int]]:
    """fold() plus, for every folded character, the index of the original character it came from (and len(text) at the
    end), so a match in the folded text maps back to the literal span ("…" folds to three characters)."""
    out: list[str] = []
    index: list[int] = []
    for i, ch in enumerate(text):
        for c in unicodedata.normalize("NFKD", ch.lower()):
            if not unicodedata.combining(c):
                out.append(c)
                index.append(i)
    index.append(len(text))
    return "".join(out), index


def _basis(sentence: str, folded: str, index: list[int]) -> str:
    m = _BASIS_RE.search(folded)
    if not m:
        return ""
    # Same span in the original text keeps accents and capitals ("art. 118 del Código General del Proceso").
    return sentence[index[m.start()]:index[m.end()]].strip(" ,.;")[:300]


def _title(folded: str, amount: int | None, unit: str) -> str:
    for cue, title in _PURPOSES:
        if cue in folded:
            return title
    if unit == "fixed":
        return "Fecha límite"
    label = {"business_days": "días hábiles", "calendar_days": "días calendario", "months": "meses", "years": "años"}[unit]
    return f"Término de {amount} {label}"


# Sentence ends that are not ends: "art. 369", "num. 2", "C.G.P.", "S.A.S.", "Dr. Ortiz".
_ABBREVIATIONS = frozenset((
    "art", "arts", "num", "nums", "no", "nos", "inc", "lit", "par", "paragr", "ord", "num", "pag", "pags", "fl", "fls",
    "exp", "rad", "cfr", "dr", "dra", "sr", "sra", "mp", "ss", "lit", "cap", "tit", "dec", "res", "cir", "vr", "cc", "ce",
))
_BOUNDARY = re.compile(r"[.!?;:]\s+(?=[A-ZÁÉÍÓÚÑ¿¡0-9\"(«])")
_LAST_WORD = re.compile(r"(\w+)\W*$")


def split_sentences(text: str) -> list[str]:
    """Sentences of a block, without breaking on legal abbreviations or single initials."""
    text = text.replace("\n", " ")
    out, start = [], 0
    for m in _BOUNDARY.finditer(text):
        if text[m.start()] == ".":
            last = _LAST_WORD.search(text[start:m.start()])
            word = fold(last.group(1)) if last else ""
            if len(word) == 1 or word in _ABBREVIATIONS:
                continue
        piece = text[start:m.start() + 1].strip()
        if piece:
            out.append(piece)
        start = m.end()
    tail = text[start:].strip()
    if tail:
        out.append(tail)
    return out


def _quote(sentence: str) -> str:
    """The sentence itself; a long one is cut at a word boundary (still a literal prefix of the source)."""
    if len(sentence) <= MAX_QUOTE:
        return sentence
    cut = sentence[:MAX_QUOTE]
    return cut[: cut.rfind(" ")] if " " in cut else cut


def looks_judicial(texts: list[str]) -> bool:
    """Two or more distinct court markers in the first part of the document."""
    head = fold(" ".join(texts)[:20000])
    return sum(1 for m in _JUDICIAL_MARKERS if m in head) >= 2


_DATE_ANCHOR = re.compile(r"(?:auto|providencia|sentencia|notificad[oa]|notificacion|ejecutoriad[oa])\b[^.;]{0,25}$")


def _stated_date(folded: str, dates: list[tuple[re.Match, date]], unit: re.Match) -> date | None:
    """A date in the same sentence offered as the start date: the one named right after "auto", "providencia" or
    "notificación" if there is one ("…concedido en el auto inadmisorio del 22 de septiembre de 2025"), else the first."""
    usable = [(dm, d) for dm, d in dates if dm.end() <= unit.start() or dm.start() >= unit.end()]
    for dm, d in usable:
        if _DATE_ANCHOR.search(folded[max(0, dm.start() - 60):dm.start()]):
            return d
    return usable[0][1] if usable else None


def candidates_in_sentence(sentence: str, page: int | None, block: int) -> list[Candidate]:
    folded, index = _fold_map(sentence)
    if not _DEADLINE_CUES.search(folded):
        return []
    trigger, basis, quote = _trigger(folded), _basis(sentence, folded, index), _quote(sentence)
    out: list[Candidate] = []
    dates = [(m, d) for m in _DATE_RE.finditer(folded) if (d := _parse_date(m))]
    fixed = _FIXED_RE.search(folded)
    if fixed:
        for m, d in dates:
            if m.start() == fixed.end():
                out.append(Candidate(page, quote, None, "fixed", False, trigger, d, basis, _title(folded, None, "fixed"), block))
                break
    for m in _UNIT_RE.finditer(folded):
        amount = int(m.group("digits")) if m.group("digits") else _number_before(folded, m.start())
        if amount is None or not 1 <= amount <= 3650:
            continue
        unit, assumed = _unit(m.group("unit"), m.group("qual"))
        if unit == "years" and amount > 30:
            continue
        stated = _stated_date(folded, dates, m)
        out.append(Candidate(page, quote, amount, unit, assumed, trigger, stated, basis, _title(folded, amount, unit), block))
    return out


def find_candidates(blocks: list[tuple[str, int | None]], *, require_judicial: bool = True) -> list[Candidate]:
    """Candidates in a document given as (text, page) blocks in reading order. Deduplicated, capped per document."""
    texts = [t for t, _ in blocks if t]
    if not texts or (require_judicial and not looks_judicial(texts)):
        return []
    seen: set[str] = set()
    out: list[Candidate] = []
    for i, (text, page) in enumerate(blocks):
        folded = fold(text or "")
        if not _UNIT_RE.search(folded) and "tardar" not in folded and "hasta" not in folded:
            continue
        for sentence in split_sentences(text):
            for c in candidates_in_sentence(sentence, page, i):
                if c.fingerprint in seen:
                    continue
                seen.add(c.fingerprint)
                out.append(c)
                if len(out) >= MAX_PER_DOCUMENT:
                    return out
    return out
