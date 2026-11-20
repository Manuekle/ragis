"""Colombian public holidays (festivos) as SQL rows for the public_holidays table (ADR-037).

Rules:
  - Fixed dates that never move: 1 Jan, 1 May, 20 Jul, 7 Aug, 8 Dec, 25 Dec (Ley 51 de 1983, art. 1).
  - Dates moved to the next Monday when they do not fall on a Monday (Ley 51 de 1983, "Ley Emiliani"):
    6 Jan, 19 Mar, 29 Jun, 15 Aug, 12 Oct, 1 Nov, 11 Nov.
  - Easter-based: Holy Thursday and Good Friday (never moved); Ascension, Corpus Christi and Sacred Heart moved to the
    Monday after (Easter + 43, + 64 and + 71 days).

Print the rows for a range of years (paste them into a migration to add years):

    python3 scripts/holidays/co.py 2024 2032
"""

from __future__ import annotations

import sys
from datetime import date, timedelta

FIXED = [((1, 1), "Año Nuevo"), ((5, 1), "Día del Trabajo"), ((7, 20), "Día de la Independencia"),
         ((8, 7), "Batalla de Boyacá"), ((12, 8), "Inmaculada Concepción"), ((12, 25), "Navidad")]
MOVED = [((1, 6), "Reyes Magos"), ((3, 19), "San José"), ((6, 29), "San Pedro y San Pablo"),
         ((8, 15), "Asunción de la Virgen"), ((10, 12), "Día de la Diversidad Étnica y Cultural"),
         ((11, 1), "Todos los Santos"), ((11, 11), "Independencia de Cartagena")]
BASIS = "Ley 51 de 1983"


def easter(year: int) -> date:
    """Gregorian Easter Sunday (anonymous Gregorian algorithm)."""
    a, b, c = year % 19, year // 100, year % 100
    d, e = b // 4, b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = c // 4, c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7  # noqa: E741
    m = (a + 11 * h + 22 * l) // 451
    month = (h + l - 7 * m + 114) // 31
    day = (h + l - 7 * m + 114) % 31 + 1
    return date(year, month, day)


def next_monday(d: date) -> date:
    return d + timedelta(days=(7 - d.weekday()) % 7)


def holidays(year: int) -> list[tuple[date, str]]:
    out = [(date(year, m, d), name) for (m, d), name in FIXED]
    out += [(next_monday(date(year, m, d)), name) for (m, d), name in MOVED]
    e = easter(year)
    out += [(e - timedelta(days=3), "Jueves Santo"), (e - timedelta(days=2), "Viernes Santo"),
            (e + timedelta(days=43), "Ascensión del Señor"), (e + timedelta(days=64), "Corpus Christi"),
            (e + timedelta(days=71), "Sagrado Corazón de Jesús")]
    return sorted(out)


def main(first: int, last: int) -> None:
    rows = [f"  ('co', '{d.isoformat()}', '{name}', '{BASIS}')" for y in range(first, last + 1) for d, name in holidays(y)]
    print("INSERT INTO public_holidays (country, day, name, basis) VALUES\n" + ",\n".join(rows) + ";")


if __name__ == "__main__":
    main(int(sys.argv[1]), int(sys.argv[2]))
