"""Migrador SQL mínimo (mismo contrato que apps/api/src/db/migrate.ts).

Aplica db/migrations/*.sql en orden, registrando cada versión en schema_migrations.
Debe ejecutarse con el rol propietario del esquema, nunca con ragsis_app/ragsis_worker.
"""

from __future__ import annotations

import sys
from pathlib import Path

import psycopg


def migrate(database_url: str, migrations_dir: Path) -> list[str]:
    applied: list[str] = []
    with psycopg.connect(database_url, autocommit=False) as conn:
        with conn.transaction():
            conn.execute("SELECT pg_advisory_xact_lock(hashtext('ragsis:migrations'))")
            conn.execute(
                "CREATE TABLE IF NOT EXISTS schema_migrations "
                "(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
            )
            done = {r[0] for r in conn.execute("SELECT version FROM schema_migrations").fetchall()}
            for path in sorted(migrations_dir.glob("*.sql")):
                if path.stem in done:
                    continue
                conn.execute(path.read_text(encoding="utf-8"))
                conn.execute("INSERT INTO schema_migrations (version) VALUES (%s)", (path.stem,))
                applied.append(path.stem)
    return applied


if __name__ == "__main__":
    url, directory = sys.argv[1], Path(sys.argv[2])
    for v in migrate(url, directory):
        print(f"applied {v}")
