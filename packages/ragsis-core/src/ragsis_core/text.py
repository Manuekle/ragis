"""Utilidades de texto sin dependencias de red (apto para despliegue offline)."""

from __future__ import annotations

import re
import unicodedata

_WORD_RE = re.compile(r"\w+", re.UNICODE)

# Stopwords españolas frecuentes (subset) para scoring lexical local.
SPANISH_STOPWORDS = frozenset(
    """a al algo algunas algunos ante antes como con contra cual cuales cuando de del desde donde dos
    el ella ellas ellos en entre era es esa esas ese eso esos esta estas este esto estos fue fueron ha
    han hasta hay la las le les lo los mas me mi mucho muy nada ni no nos o otra otro para pero poco por
    porque que quien se sea segun ser si sin sobre son su sus tambien tiene tienen todo todos tu un una
    uno unos y ya cual cuál qué cómo dónde cuándo quién cuanto cuantos cuanta cuantas cuales quienes
    hacer hace dice dicen explica explicar dime indica puedo debo the of and to in is""".split()
)


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKC", text)
    return re.sub(r"[ \t ]+", " ", text).strip()


def fold(text: str) -> str:
    """Minúsculas sin tildes (para comparación lexical)."""
    nfkd = unicodedata.normalize("NFKD", text.lower())
    return "".join(c for c in nfkd if not unicodedata.combining(c))


def words(text: str) -> list[str]:
    return _WORD_RE.findall(fold(text))


def content_terms(text: str) -> list[str]:
    return [w for w in words(text) if w not in SPANISH_STOPWORDS and (len(w) > 2 or w.isdigit())]


def estimate_tokens(text: str) -> int:
    """Estimación conservadora (~1.3 tokens por palabra en español, mínimo por caracteres).

    Evita depender de la caché de tiktoken en entornos desconectados; el conteo exacto
    lo reporta el proveedor del modelo cuando está disponible.
    """
    if not text:
        return 0
    n_words = len(text.split())
    return max(int(n_words * 1.3) + 1, len(text) // 4)


# Candidatos a fin de oración. Los dos puntos no cierran oración: introducen el valor de una etiqueta
# («Magistrado ponente: Carlos Camargo Assis») o una enumeración, y partir ahí separaba la etiqueta de su valor.
_SENT_RE = re.compile(r"(?<=[.!?;])\s+(?=[A-ZÁÉÍÓÚÑ¿¡0-9\"(])")
_LAST_TOKEN = re.compile(r"(\S+)$")
# Abreviaturas (sin tildes ni punto final) tras las que un punto no termina la oración, frecuentes en textos jurídicos
# y administrativos en español: «el num. 4 del art. 93», «el Dr. Pérez», «fls. 12 a 14», «Cía. Ltda.».
_ABBREVIATIONS = frozenset(
    """art arts num nums nro nros inc incs lit lits par parag pag pags fl fls cap caps tit tits vol vols exp rad
    sent dto res mag dr dra drs dras sr sra sres sras srta lic ing prof abg arq gral cia ltda av cra cl ej cfr cf
    vid vs aprox ibid op cit pp ss ed eds trad coord ord""".split()
)
# Solo son abreviatura delante de un número («No. 4»); delante de otra cosa pueden ser la palabra que cierra la oración.
_NUMBER_ABBREVIATIONS = frozenset({"no", "n"})


def _ends_in_abbreviation(before: str, after: str) -> bool:
    match = _LAST_TOKEN.search(before)
    if not match or not match.group(1).endswith("."):
        return False
    raw = match.group(1)[:-1].lstrip("(«\"'¿¡[")
    core = fold(raw)
    if not core:
        return False
    if core in _ABBREVIATIONS:
        return True
    if core in _NUMBER_ABBREVIATIONS and after[:1].isdigit():
        return True
    pieces = raw.split(".")
    if len(pieces) == 1:
        # Inicial de un nombre («J. Calderón»). Una minúscula suelta cierra la oración («… los meses t. La tasa …»).
        return len(raw) == 1 and raw.isalpha() and raw.isupper()
    # Siglas con puntos: «C.P.», «M.P.», «S.A.S.», «a.m.».
    return all(len(p) == 1 and p.isalpha() for p in pieces)


def split_sentences(text: str) -> list[str]:
    text = text.replace("\n", " ")
    parts: list[str] = []
    start = 0
    for m in _SENT_RE.finditer(text):
        if _ends_in_abbreviation(text[start:m.start()], text[m.end():]):
            continue
        parts.append(text[start:m.start()])
        start = m.end()
    parts.append(text[start:])
    return [p.strip() for p in parts if p.strip()]
