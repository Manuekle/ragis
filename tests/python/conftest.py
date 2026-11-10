"""Fixtures de integración: BD efímera `ragsis_test` en el Postgres de compose + S3 local (SeaweedFS).

Requiere `docker compose -f infra/docker/compose.yml --env-file .env up -d postgres seaweedfs`.
"""

from __future__ import annotations

import os
import uuid
from pathlib import Path

import psycopg
import pytest

ROOT = Path(__file__).resolve().parents[2]


def _load_env() -> dict[str, str]:
    env = {}
    path = ROOT / ".env"
    if path.exists():
        for line in path.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    return env


ENV = _load_env()
PG_PORT = os.environ.get("POSTGRES_HOST_PORT", "55432")
OWNER_PW = ENV.get("POSTGRES_PASSWORD", "")
APP_PW = ENV.get("RAGSIS_APP_DB_PASSWORD", "")
WORKER_PW = ENV.get("RAGSIS_WORKER_DB_PASSWORD", "")
TEST_DB = "ragsis_test"


def owner_url(db: str = TEST_DB) -> str:
    return f"postgresql://ragsis_owner:{OWNER_PW}@127.0.0.1:{PG_PORT}/{db}"


@pytest.fixture(scope="session", autouse=True)
def settings_env():
    os.environ.update({
        "RAGSIS_ENV": "test",
        "DATABASE_URL": f"postgresql://ragsis_app:{APP_PW}@127.0.0.1:{PG_PORT}/{TEST_DB}",
        "S3_ENDPOINT": "http://127.0.0.1:8333",
        "S3_BUCKET": "ragsis-test",
        "AWS_ACCESS_KEY_ID": ENV.get("S3_ACCESS_KEY", "ragsis-dev-access"),
        "AWS_SECRET_ACCESS_KEY": ENV.get("S3_SECRET_KEY", "ragsis-dev-secret-change-me"),
        "AWS_REGION": "us-east-1",
        "INTERNAL_SERVICE_SECRET": "test-internal-secret-" + "x" * 32,
        "AI_EMBEDDING_MODEL": "local-hash-1024@v1",
        "AI_GENERATION_MODEL": "local-extractive@v1",
        "AI_RERANK_MODEL": "local-lexical-rerank@v1",
        "AI_GRAPH_MODEL": "local-graph-heuristic@v1",
        "MALWARE_SCANNER": "none",
    })
    from ragsis_core.settings import get_settings

    get_settings.cache_clear()
    yield


@pytest.fixture(scope="session")
def database(settings_env):
    if not OWNER_PW:
        pytest.skip("falta .env con POSTGRES_PASSWORD")
    try:
        admin = psycopg.connect(owner_url("ragsis"), autocommit=True, connect_timeout=3)
    except psycopg.OperationalError:
        pytest.skip("Postgres de compose no disponible en 127.0.0.1:%s" % PG_PORT)
    with admin:
        admin.execute(f"DROP DATABASE IF EXISTS {TEST_DB} WITH (FORCE)")
        admin.execute(f"CREATE DATABASE {TEST_DB}")
    from ragsis_core.migrate import migrate

    migrate(owner_url(), ROOT / "db" / "migrations")
    yield


def _pool(url: str):
    from pgvector.psycopg import register_vector
    from psycopg.rows import dict_row
    from psycopg_pool import ConnectionPool

    return ConnectionPool(url, min_size=1, max_size=4, configure=register_vector,
                          kwargs={"row_factory": dict_row}, open=True)


@pytest.fixture(scope="session")
def app_pool(database):
    p = _pool(f"postgresql://ragsis_app:{APP_PW}@127.0.0.1:{PG_PORT}/{TEST_DB}")
    yield p
    p.close()


@pytest.fixture(scope="session")
def worker_pool(database):
    p = _pool(f"postgresql://ragsis_worker:{WORKER_PW}@127.0.0.1:{PG_PORT}/{TEST_DB}")
    yield p
    p.close()


@pytest.fixture(scope="session")
def owner(database):
    from psycopg.rows import dict_row

    conn = psycopg.connect(owner_url(), autocommit=True, row_factory=dict_row)
    yield conn
    conn.close()


@pytest.fixture(scope="session")
def s3(settings_env):
    from botocore.exceptions import ClientError, EndpointConnectionError
    from ragsis_core.aws import s3_client

    s3_client.cache_clear()
    c = s3_client()
    try:
        c.create_bucket(Bucket="ragsis-test")
    except ClientError as exc:
        if exc.response["Error"]["Code"] not in ("BucketAlreadyOwnedByYou", "BucketAlreadyExists"):
            raise
    except EndpointConnectionError:
        pytest.skip("S3 local no disponible")
    return c


class Tenant:
    def __init__(self, owner_conn, name: str, plan: str = "team", data_class: str = "internal") -> None:
        self.org = uuid.uuid4()
        self.ws = uuid.uuid4()
        self.user = uuid.uuid4()
        self.conn = owner_conn
        slug = f"{name}-{self.org.hex[:6]}"
        owner_conn.execute("INSERT INTO organizations (id, name, slug, plan_id, data_class) VALUES (%s,%s,%s,%s,%s)",
                           (self.org, name, slug, plan, data_class))
        owner_conn.execute("INSERT INTO users (id, identity_provider, external_subject, email) VALUES (%s,'test',%s,%s)",
                           (self.user, str(self.user), f"{slug}@example.test"))
        owner_conn.execute("INSERT INTO memberships (organization_id, user_id, role) VALUES (%s,%s,'owner')",
                           (self.org, self.user))
        owner_conn.execute("INSERT INTO workspaces (id, organization_id, name) VALUES (%s,%s,'General')",
                           (self.ws, self.org))
        owner_conn.execute("INSERT INTO workspace_members (workspace_id, organization_id, user_id, role) "
                           "VALUES (%s,%s,%s,'editor')", (self.ws, self.org, self.user))

    @property
    def principals(self) -> tuple[str, ...]:
        return (f"user:{self.user}", f"workspace:{self.ws}")

    def claims(self, rerank: bool = False, principals: tuple[str, ...] | None = None, user=None,
               graph: bool = False):
        from ragsis_core.internal_auth import InternalClaims

        return InternalClaims(self.org, user or self.user, self.ws, principals or self.principals, "team",
                              "internal", (), 6000, rerank, graph)

    def set_graph(self, mode: str) -> None:
        self.conn.execute("UPDATE organizations SET graph_mode=%s WHERE id=%s", (mode, self.org))

    def add_document(self, s3c, filename: str, content: bytes, content_type: str, *, title: str = "",
                     acl: list[str] | None = None, document_id: uuid.UUID | None = None, version_no: int = 1,
                     effective_from=None):
        doc = document_id or uuid.uuid4()
        ver = uuid.uuid4()
        key = f"tenants/{self.org}/raw/{doc}/{ver}/{filename}"
        s3c.put_object(Bucket="ragsis-test", Key=key, Body=content)
        if document_id is None:
            self.conn.execute("INSERT INTO documents (id, organization_id, workspace_id, title, owner_id) "
                              "VALUES (%s,%s,%s,%s,%s)", (doc, self.org, self.ws, title or filename, self.user))
            for p in acl or [f"workspace:{self.ws}"]:
                self.conn.execute("INSERT INTO document_acl (document_id, organization_id, principal) VALUES (%s,%s,%s)",
                                  (doc, self.org, p))
        self.conn.execute(
            "INSERT INTO document_versions (id, organization_id, document_id, version_no, filename, content_type,"
            " declared_size, s3_key, status, created_by, effective_from) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,'uploaded',%s,%s)",
            (ver, self.org, doc, version_no, filename, content_type, len(content), key, self.user, effective_from))
        job = uuid.uuid4()
        self.conn.execute("INSERT INTO ingestion_jobs (id, organization_id, kind, document_id, version_id, idempotency_key)"
                          " VALUES (%s,%s,'ingest',%s,%s,%s)", (job, self.org, doc, ver, f"ingest:{ver}"))
        from ragsis_ingest.pipeline import JobMessage

        return doc, ver, JobMessage("ingest", self.org, doc, ver, job)


@pytest.fixture
def make_tenant(owner):
    def _make(name: str, **kw) -> Tenant:
        return Tenant(owner, name, **kw)
    return _make
