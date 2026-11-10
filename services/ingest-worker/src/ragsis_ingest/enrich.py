"""Enriquecimiento con política de datos: detección de PII por patrones (etiquetas, no redacción)."""

from __future__ import annotations

import re

_EMAIL = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b")
_PHONE = re.compile(r"(?<!\d)(?:\+?57\s?)?3\d{2}[\s-]?\d{3}[\s-]?\d{4}(?!\d)")
_CEDULA = re.compile(
    r"\b(?:C\.?\s?C\.?|c[ée]dula(?: de ciudadan[íi]a)?|NIT)\s*(?:No\.?|n[úu]mero|#)?\s*[:.]?\s*\d[\d.\s-]{5,13}\d", re.I
)
_CARD = re.compile(r"(?<!\d)(?:\d[ -]?){13,19}(?!\d)")


def _luhn(number: str) -> bool:
    digits = [int(d) for d in number if d.isdigit()]
    if not 13 <= len(digits) <= 19:
        return False
    checksum = 0
    for i, d in enumerate(reversed(digits)):
        if i % 2:
            d *= 2
            if d > 9:
                d -= 9
        checksum += d
    return checksum % 10 == 0


def detect_pii(text: str) -> list[str]:
    flags = []
    if _EMAIL.search(text):
        flags.append("email")
    if _PHONE.search(text):
        flags.append("phone")
    if _CEDULA.search(text):
        flags.append("national_id")
    if any(_luhn(m.group(0)) for m in _CARD.finditer(text)):
        flags.append("payment_card")
    return flags
