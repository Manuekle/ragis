"""Grafo intra-tabla (ADR-029): encabezados de fila y de columna, celdas y unidades como nodos y relaciones.

Determinista, sin modelo: lee la tabla Markdown del chunk. Cada fila y cada columna es un nodo con alcance de SU
tabla (la clave incluye el ancla de la tabla, así el "2020" de una tabla no se fusiona con el de otra); el nombre
visible es el encabezado tal cual. Relaciones:

  fila    → tabla    `fila_de`
  columna → tabla    `columna_de`
  fila    → columna  `celda`: la descripción lleva el valor ("Salarios / 2020 = 26.778 millones COP")
  unidad  → columna | tabla  `unidad_de`  (unidad entre paréntesis en el encabezado o en el caption)

Una pregunta por "salarios en 2020" coincide con la relación de esa celda y no con la fila vecina de nombre parecido.
Todo sale del texto del chunk: procedencia, ACL y citas no cambian (ADR-019).
"""

from __future__ import annotations

import re

from ragsis_core.text import normalize

MAX_ROWS = 40
MAX_COLS = 12
MAX_CELLS = 150
MAX_NAME = 200
MAX_DESCRIPTION = 1000
MAX_KEYWORDS = 300
ROW_WEIGHT = 2.0
CELL_WEIGHT = 2.0
UNIT_WEIGHT = 1.0
_SEPARATOR = set("-: ")
_HEADER_UNIT = re.compile(r"\(([^()]{1,40})\)\s*$")
_CAPTION_UNIT = re.compile(r"\((?:(?:cifras|valores|montos|amounts|figures|values)\s+)?(?:en|in)\s+([^()]{2,60})\)", re.I)


def _cells(line: str) -> list[str]:
    return [normalize(c) for c in line.strip().strip("|").split("|")]


def table_rows(text: str) -> tuple[list[str], list[list[str]]]:
    """(encabezado, filas) de la primera tabla Markdown del texto; ([], []) si no hay."""
    block: list[str] = []
    for line in text.split("\n"):
        s = line.strip()
        if s.startswith("|") and s.endswith("|") and len(s) > 1:
            block.append(s)
        elif block:
            break
    if len(block) < 2:
        return [], []
    rows = [_cells(b) for b in block[1:] if not set(b.replace("|", "")) <= _SEPARATOR]
    return _cells(block[0]), rows


_NAME_CONNECTORS = frozenset({"de", "del", "la", "las", "los", "y", "e"})


def looks_like_proper_name(label: str) -> bool:
    """Etiqueta de fila que nombra a alguien o algo concreto ("Mariana Ortiz Lozano", "Banco de Bogotá").

    Dos o más palabras con mayúscula inicial (conectores aparte) y sin cifras. "Total", "Región Caribe 2025" o
    "Gastos de viaje" no lo son: esas filas siguen siendo locales a su tabla.
    """
    words = label.split()
    if any(ch.isdigit() for ch in label):
        return False
    named = [w for w in words if w.lower() not in _NAME_CONNECTORS]
    return len(named) >= 2 and all(w[:1].isupper() and w[:1].isalpha() for w in named)


def table_graph(text: str, anchor: dict, caption: str = "", key_of=None) -> tuple[list[dict], list[dict]]:
    """Entidades y relaciones de la estructura de la tabla, ancladas a `anchor` (nodo de la tabla).

    `key_of`: normalizador de nombres del grafo (se inyecta para no depender de graph.py)."""
    header, rows = table_rows(text)
    if len(header) < 2 or not rows:
        return [], []
    label = anchor["name"].split(" · ")[0]
    entities: dict[str, dict] = {}
    relations: list[dict] = []

    def node(name: str, etype: str, description: str, nth: int = 1) -> str | None:
        name = name[:MAX_NAME - 1]
        # Etiquetas repetidas en la misma tabla (dos filas "Total") son nodos distintos: no se pisan sus celdas.
        key = key_of(f"{name} {etype}{f' {nth}' if nth > 1 else ''} {anchor['key']}")[-MAX_NAME:]
        if not name or len(key) < 2 or key == anchor["key"]:
            return None
        entities.setdefault(key, {"key": key, "name": name, "type": etype,
                                  "description": normalize(description)[:MAX_DESCRIPTION]})
        return key

    def edge(src: str, dst: str, keywords: str, description: str, weight: float) -> None:
        if src != dst:
            relations.append({"src_key": src, "dst_key": dst, "keywords": keywords[:MAX_KEYWORDS],
                              "description": normalize(description)[:MAX_DESCRIPTION], "weight": weight})

    def unit(raw: str, target: str, of: str) -> None:
        key = node(raw, "unidad", f"Unidad de {of}")
        if key:
            edge(key, target, "unidad_de", f"{of} se expresa en {raw}", UNIT_WEIGHT)

    table_unit = (m.group(1).strip() if (m := _CAPTION_UNIT.search(caption or "")) else "")
    if table_unit:
        unit(table_unit, anchor["key"], label)

    cols: list[tuple[int, str, str, str]] = []       # (índice, nombre, clave, unidad)
    for j, h in enumerate(header[1:MAX_COLS + 1], start=1):
        if not h:
            continue
        key = node(h, "columna", f"Columna de {label}")
        if not key:
            continue
        edge(key, anchor["key"], "columna_de", f"{h} es una columna de {label}", ROW_WEIGHT)
        col_unit = m.group(1).strip() if (m := _HEADER_UNIT.search(h)) else ""
        if col_unit:
            unit(col_unit, key, h)
        cols.append((j, h, key, col_unit or table_unit))

    cells = 0
    seen: dict[str, int] = {}
    for r in rows[:MAX_ROWS]:
        name = r[0] if r else ""
        if not name:
            continue
        seen[name.lower()] = seen.get(name.lower(), 0) + 1
        content = ", ".join(f"{h} = {v}" for h, v in zip(header, r, strict=False) if h and v)
        key = node(name, "fila", f"Fila de {label}: {content}", seen[name.lower()])
        if not key:
            continue
        edge(key, anchor["key"], "fila_de", f"{name} es una fila de {label}", ROW_WEIGHT)
        if looks_like_proper_name(name):
            # La fila también menciona a la entidad global del mismo nombre: así un salto del grafo llega desde
            # "Mariana Ortiz Lozano" en un acta hasta su fila en una hoja de horas. La fila sigue anclada a su tabla.
            global_key = key_of(name)[-MAX_NAME:]
            if len(global_key) >= 2 and global_key != anchor["key"]:
                entities.setdefault(global_key, {"key": global_key, "name": name, "type": "entidad",
                                                 "description": normalize(f"{name} en {label}: {content}")[:MAX_DESCRIPTION]})
                edge(key, global_key, "fila_sobre", f"La fila {name} de {label} se refiere a {name}", ROW_WEIGHT)
        for j, h, col_key, u in cols:
            value = r[j] if j < len(r) else ""
            if not value or cells >= MAX_CELLS:
                continue
            cells += 1
            shown = value if not u or u.lower() in value.lower() or u.lower() in h.lower() else f"{value} {u}"
            edge(key, col_key, f"celda {name} {h}", f"{name} / {h} = {shown} ({label})", CELL_WEIGHT)
    return list(entities.values()), relations
