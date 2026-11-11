"""Mini-biblioteca para componer diagramas SVG autocontenidos con los iconos de docs/assets/icons.

Los iconos se incrustan dentro de cada diagrama (GitHub no carga recursos externos desde un SVG
mostrado con <img>), por eso no hay referencias a archivos. Solo usa la librería estándar.
"""
from __future__ import annotations

import html
import re
from pathlib import Path

ICONS = Path(__file__).resolve().parent.parent / "assets" / "icons"

THEMES = {
    "light": {
        "bg": "#ffffff", "card": "#f6f6f8", "card_stroke": "#d4d4d8", "text": "#18181b", "muted": "#52525b",
        "line": "#71717a", "accent": "#0a84ff", "accent_soft": "#e6f2ff", "group_stroke": "#a1a1aa",
        "group_fill": "#fbfbfc", "label_bg": "#ffffff", "ok": "#1a7f4b", "warn": "#b54708",
    },
    "dark": {
        "bg": "#17171a", "card": "#222227", "card_stroke": "#3b3b44", "text": "#ececef", "muted": "#aeaeb5",
        "line": "#8e8e96", "accent": "#5eb0ff", "accent_soft": "#10253f", "group_stroke": "#5a5a64",
        "group_fill": "#1c1c20", "label_bg": "#17171a", "ok": "#4ade80", "warn": "#fb923c",
    },
}

FONT = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
_uid = 0


def esc(s: str) -> str:
    return html.escape(s, quote=True)


def text_width(s: str, size: float) -> float:
    """Estimación del ancho de un texto (suficiente para ubicar etiquetas)."""
    return len(s) * size * 0.56


def _icon_file(name: str, theme: str) -> Path:
    p = ICONS / name
    if theme == "dark":
        dark = p.with_name(p.stem + "-dark" + p.suffix)
        if dark.exists():
            return dark
    return p


def inline_icon(name: str, theme: str, x: float, y: float, w: float, h: float | None = None) -> str:
    """Devuelve un <svg> anidado con el icono; ids/clases únicos para que no choquen entre iconos."""
    global _uid
    _uid += 1
    pfx = f"i{_uid}-"
    h = w if h is None else h
    raw = _icon_file(name, theme).read_text(encoding="utf-8")
    head = re.search(r"<svg\b[^>]*>", raw, re.S)
    assert head, f"{name}: sin <svg>"
    attrs = head.group(0)
    vb = re.search(r'viewBox="([^"]+)"', attrs)
    if vb:
        viewbox = vb.group(1)
    else:
        iw = float(re.search(r'width="([\d.]+)', attrs).group(1))
        ih = float(re.search(r'height="([\d.]+)', attrs).group(1))
        viewbox = f"0 0 {iw} {ih}"
    inner = raw[head.end(): raw.rfind("</svg>")]
    inner = re.sub(r"<title>.*?</title>|<desc>.*?</desc>|<!--.*?-->", "", inner, flags=re.S)
    ids = set(re.findall(r'\bid="([^"]+)"', inner))
    refs = set(re.findall(r"url\(#([^)]+)\)", inner)) | set(re.findall(r'href="#([^"]+)"', inner))
    for i in ids:
        if i in refs:
            inner = inner.replace(f'id="{i}"', f'id="{pfx}{i}"').replace(f"url(#{i})", f"url(#{pfx}{i})").replace(f'href="#{i}"', f'href="#{pfx}{i}"')
        else:
            inner = inner.replace(f' id="{i}"', "")
    if "<style" in inner:
        def pre_style(m: re.Match) -> str:
            return re.sub(r"\.([A-Za-z_][\w-]*)", lambda c: f".{pfx}{c.group(1)}", m.group(0))
        inner = re.sub(r"<style[^>]*>.*?</style>", pre_style, inner, flags=re.S)
        inner = re.sub(r'class="([^"]+)"', lambda m: 'class="' + " ".join(pfx + c for c in m.group(1).split()) + '"', inner)
    return (f'<svg x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" viewBox="{viewbox}" '
            f'preserveAspectRatio="xMidYMid meet">{inner}</svg>')


class Canvas:
    def __init__(self, w: int, h: int, theme: str, title: str, desc: str):
        self.w, self.h, self.theme, self.t = w, h, theme, THEMES[theme]
        self.title, self.desc = title, desc
        self.parts: list[str] = []
        self.anchors: dict[str, tuple[float, float, float, float]] = {}

    # --- primitivas -------------------------------------------------------------------------
    def add(self, s: str) -> None:
        self.parts.append(s)

    def text(self, x: float, y: float, s: str, size: float = 12, weight: int = 400, fill: str | None = None,
             anchor: str = "start") -> None:
        lines = s.split("\n")
        for i, line in enumerate(lines):
            self.add(f'<text x="{x:.1f}" y="{y + i * size * 1.3:.1f}" font-size="{size}" font-weight="{weight}" '
                     f'fill="{fill or self.t["text"]}" text-anchor="{anchor}">{esc(line)}</text>')

    def icon(self, name: str, x: float, y: float, w: float, h: float | None = None) -> None:
        self.add(inline_icon(name, self.theme, x, y, w, h))

    def group(self, x: float, y: float, w: float, h: float, title: str, icon: str | None = None,
              dashed: bool = False, stroke: str | None = None) -> None:
        t = self.t
        dash = ' stroke-dasharray="6 4"' if dashed else ""
        self.add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="8" fill="{t["group_fill"]}" '
                 f'stroke="{stroke or t["group_stroke"]}" stroke-width="1.4"{dash}/>')
        tx = x + 12
        if icon:
            self.icon(icon, x, y, 28)
            tx = x + 36
        self.text(tx, y + 19, title, 12.5, 600, self.t["muted"] if not icon else self.t["text"])

    def node(self, key: str, x: float, y: float, w: float, h: float, title: str, sub: str = "",
             icon: str | None = None, accent: bool = False, icon_size: float = 34) -> None:
        t = self.t
        fill = t["accent_soft"] if accent else t["card"]
        stroke = t["accent"] if accent else t["card_stroke"]
        self.add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="10" fill="{fill}" stroke="{stroke}" stroke-width="1.3"/>')
        tx = x + 14
        if icon:
            self.icon(icon, x + 12, y + (h - icon_size) / 2, icon_size)
            tx = x + 12 + icon_size + 10
        lines_sub = sub.split("\n") if sub else []
        block = 14 + 13 * len(lines_sub)
        ty = y + (h - block) / 2 + 12
        self.text(tx, ty, title, 13, 600)
        if sub:
            self.text(tx, ty + 15, sub, 11, 400, t["muted"])
        self.anchors[key] = (x, y, w, h)

    def pill(self, x: float, y: float, label: str, fill: str | None = None, color: str | None = None) -> None:
        wd = text_width(label, 11) + 16
        self.add(f'<rect x="{x}" y="{y}" width="{wd:.1f}" height="20" rx="10" fill="{fill or self.t["accent_soft"]}" '
                 f'stroke="{self.t["accent"]}" stroke-width="1"/>')
        self.text(x + wd / 2, y + 14, label, 11, 600, color or self.t["accent"], "middle")

    def edge(self, pts: list[tuple[float, float]], label: str = "", dashed: bool = False, both: bool = False,
             label_at: tuple[float, float] | None = None, color: str | None = None) -> None:
        t = self.t
        col = color or t["line"]
        d = ' stroke-dasharray="5 4"' if dashed else ""
        start = ' marker-start="url(#arrow-s)"' if both else ""
        poly = " ".join(f"{x:.1f},{y:.1f}" for x, y in pts)
        self.add(f'<polyline points="{poly}" fill="none" stroke="{col}" stroke-width="1.5"{d} '
                 f'stroke-linejoin="round" marker-end="url(#arrow)"{start}/>')
        if label:
            if label_at is None:
                # punto medio del segmento más largo
                segs = list(zip(pts, pts[1:]))
                a, b = max(segs, key=lambda s: abs(s[1][0] - s[0][0]) + abs(s[1][1] - s[0][1]))
                label_at = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
            lines = label.split("\n")
            wd = max(text_width(l, 10.5) for l in lines) + 10
            hh = 14 * len(lines) + 4
            lx, ly = label_at
            self.add(f'<rect x="{lx - wd / 2:.1f}" y="{ly - hh / 2:.1f}" width="{wd:.1f}" height="{hh}" rx="4" '
                     f'fill="{t["label_bg"]}" fill-opacity="0.92"/>')
            self.text(lx, ly - hh / 2 + 13, label, 10.5, 500, t["muted"], "middle")

    def step(self, x: float, y: float, n: int) -> None:
        self.add(f'<circle cx="{x}" cy="{y}" r="10" fill="{self.t["accent"]}"/>')
        self.text(x, y + 4, str(n), 11, 700, "#ffffff", "middle")

    # --- anchors ----------------------------------------------------------------------------
    def pt(self, key: str, side: str, k: float = 0.5) -> tuple[float, float]:
        x, y, w, h = self.anchors[key]
        if side == "l": return (x, y + h * k)
        if side == "r": return (x + w, y + h * k)
        if side == "t": return (x + w * k, y)
        return (x + w * k, y + h)

    # --- salida -----------------------------------------------------------------------------
    def render(self) -> str:
        t = self.t
        return (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {self.w} {self.h}" width="{self.w}" height="{self.h}" '
            f'font-family="{esc(FONT)}" role="img" aria-labelledby="t d">\n'
            f'<title id="t">{esc(self.title)}</title><desc id="d">{esc(self.desc)}</desc>\n'
            f'<defs>'
            f'<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">'
            f'<path d="M0,0 L10,5 L0,10 z" fill="{t["line"]}"/></marker>'
            f'<marker id="arrow-s" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">'
            f'<path d="M0,0 L10,5 L0,10 z" fill="{t["line"]}"/></marker>'
            f'</defs>\n'
            f'<rect width="{self.w}" height="{self.h}" rx="12" fill="{t["bg"]}"/>\n'
            + "\n".join(self.parts) + "\n</svg>\n"
        )
