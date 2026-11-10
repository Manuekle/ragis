"""Acceso a Postgres con contexto de seguridad por transacción.

Toda operación sobre datos de cliente debe ejecutarse dentro de `tenant_tx`, que fija
`app.org_id`, `app.user_id` y `app.principals` con SET LOCAL. Las políticas RLS de la BD
usan esos valores; el rol de conexión nunca tiene BYPASSRLS.
"""

from __future__ import annotations

import re
import uuid
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field

import psycopg
from pgvector.psycopg import register_vector
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from .settings import get_settings

_PRINCIPAL_RE = re.compile(r"^(workspace|group|user):[0-9a-f-]{36}$")


@dataclass(frozen=True)
class SecurityContext:
    organization_id: uuid.UUID
    user_id: uuid.UUID | None = None
    principals: tuple[str, ...] = field(default_factory=tuple)

    def __post_init__(self) -> None:
        for p in self.principals:
            if not _PRINCIPAL_RE.match(p):
                raise ValueError(f"principal inválido: {p!r}")


_pool: ConnectionPool | None = None


def _configure(conn: psycopg.Connection) -> None:
    register_vector(conn)


def get_pool() -> ConnectionPool:
    global _pool
    if _pool is None:
        s = get_settings()
        _pool = ConnectionPool(
            s.database_url,
            min_size=s.db_pool_min,
            max_size=s.db_pool_max,
            configure=_configure,
            kwargs={"row_factory": dict_row, "autocommit": False},
            open=True,
        )
    return _pool


def close_pool() -> None:
    global _pool
    if _pool is not None:
        _pool.close()
        _pool = None


def apply_context(conn: psycopg.Connection, ctx: SecurityContext) -> None:
    with conn.cursor() as cur:
        cur.execute("SELECT set_config('app.org_id', %s, true)", (str(ctx.organization_id),))
        cur.execute("SELECT set_config('app.user_id', %s, true)", (str(ctx.user_id) if ctx.user_id else "",))
        cur.execute("SELECT set_config('app.principals', %s, true)", (",".join(ctx.principals),))


@contextmanager
def tenant_tx(ctx: SecurityContext, pool: ConnectionPool | None = None) -> Iterator[psycopg.Connection]:
    """Transacción con frontera de tenant. Commit al salir sin excepción, rollback si falla."""
    p = pool or get_pool()
    with p.connection() as conn:
        with conn.transaction():
            apply_context(conn, ctx)
            yield conn


def fetch_all(conn: psycopg.Connection, sql: str, params: Sequence | dict | None = None) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute(sql, params)
        return list(cur.fetchall()) if cur.description else []


def fetch_one(conn: psycopg.Connection, sql: str, params: Sequence | dict | None = None) -> dict | None:
    with conn.cursor() as cur:
        cur.execute(sql, params)
        return cur.fetchone() if cur.description else None


def execute(conn: psycopg.Connection, sql: str, params: Sequence | dict | None = None) -> int:
    with conn.cursor() as cur:
        cur.execute(sql, params)
        return cur.rowcount
