"""Identidad visual común a PDF, Word y PowerPoint (los tokens de la app: azul Ragis y grises neutros)."""

from __future__ import annotations

import unicodedata

ACCENT = "0A84FF"         # --accent
ACCENT_TEXT = "0068D6"    # --accent-text: azul legible sobre blanco (títulos, citas)
ACCENT_DEEP = "0B3D91"    # cabeceras de tabla sobre fondo azul claro
ACCENT_SOFT = "E6F2FF"    # --accent-soft
INK = "18181B"            # --text
INK_2 = "3F3F46"          # --text-2
BODY = "27272A"
MUTED = "71717A"
RULE = "E4E4E7"
ZEBRA = "F7F7F8"
NIGHT = "0B1220"          # fondo de la portada de la presentación
NIGHT_TEXT = "A1A1AA"

BODY_FONT = "Calibri"     # Word / PowerPoint: disponible en Office (Windows y Mac); LibreOffice usa Carlito
MONO_FONT = "Consolas"


def rgb(hex_color: str) -> tuple[int, int, int]:
    return int(hex_color[0:2], 16), int(hex_color[2:4], 16), int(hex_color[4:6], 16)


# Las fuentes estándar del PDF (Helvetica) usan WinAnsi: lo que no cabe se reemplaza por un equivalente legible en
# lugar de dibujar un cuadro negro.
_PDF_REPLACE = {
    "≥": ">=", "≤": "<=", "≠": "!=", "≈": "~", "→": "->", "←": "<-", "↔": "<->", "⇒": "=>", "−": "-", "‐": "-",
    "‑": "-", "‒": "-", "√": "sqrt", "∑": "Sum", "∆": "Delta", "Δ": "Delta", "π": "pi", "µ": "µ", "α": "alpha",
    "β": "beta", "γ": "gamma", "σ": "sigma", "λ": "lambda", "✓": "v", "✔": "v", "✗": "x", "✘": "x", "★": "*",
    "☆": "*", "▪": "•", "■": "•", "●": "•", "◦": "-", " ": " ", " ": " ", " ": " ", "​": "",
    "″": '"', "′": "'", "∞": "inf", "⁄": "/", "№": "No.",
}


def pdf_safe(text: str) -> str:
    out = []
    for ch in text:
        if ch in _PDF_REPLACE:
            out.append(_PDF_REPLACE[ch])
            continue
        try:
            ch.encode("cp1252")
            out.append(ch)
        except UnicodeEncodeError:
            folded = unicodedata.normalize("NFKD", ch).encode("ascii", "ignore").decode()
            out.append(folded or "?")
    return "".join(out)
