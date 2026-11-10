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


_SENT_RE = re.compile(r"(?<=[.!?;:])\s+(?=[A-ZÁÉÍÓÚÑ¿¡0-9\"(])")


def split_sentences(text: str) -> list[str]:
    parts = [p.strip() for p in _SENT_RE.split(text.replace("\n", " ")) if p.strip()]
    return parts
