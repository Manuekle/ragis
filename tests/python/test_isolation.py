"""SEC-01: aislamiento de tenants y ACL a nivel de base de datos (RLS forzada)."""

import uuid

import psycopg
import pytest
from ragsis_core.db import SecurityContext, fetch_all, tenant_tx


def _seed_chunk(owner, t, doc, text):
    ver = uuid.uuid4()
    owner.execute("INSERT INTO document_versions (id, organization_id, document_id, version_no, filename, content_type,"
                  " declared_size, s3_key, status, is_current) VALUES (%s,%s,%s,1,'f.txt','text/plain',1,%s,'indexed',true)",
                  (ver, t.org, doc, f"tenants/{t.org}/raw/{doc}/{ver}/f.txt"))
    owner.execute("INSERT INTO chunks (id, organization_id, workspace_id, document_id, version_id, ordinal, text, "
                  "token_count, index_state) VALUES (%s,%s,%s,%s,%s,0,%s,10,'active')",
                  (uuid.uuid4(), t.org, t.ws, doc, ver, text))


def _doc(owner, t, title, acl):
    doc = uuid.uuid4()
    owner.execute("INSERT INTO documents (id, organization_id, workspace_id, title) VALUES (%s,%s,%s,%s)",
                  (doc, t.org, t.ws, title))
    for p in acl:
        owner.execute("INSERT INTO document_acl (document_id, organization_id, principal) VALUES (%s,%s,%s)",
                      (doc, t.org, p))
    return doc


def test_cross_tenant_rows_invisible(make_tenant, owner, app_pool, worker_pool):
    a, b = make_tenant("acme"), make_tenant("globex")
    da = _doc(owner, a, "Política de viáticos", [f"workspace:{a.ws}"])
    db_ = _doc(owner, b, "Política de viáticos", [f"workspace:{b.ws}"])
    _seed_chunk(owner, a, da, "Viáticos ACME: 100 USD diarios")
    _seed_chunk(owner, b, db_, "Viáticos GLOBEX: 300 USD diarios")

    with tenant_tx(SecurityContext(a.org, a.user, a.principals), app_pool) as conn:
        texts = [r["text"] for r in fetch_all(conn, "SELECT text FROM chunks")]
        docs = fetch_all(conn, "SELECT id FROM documents")
        orgs = fetch_all(conn, "SELECT id FROM organizations")
        assert texts == ["Viáticos ACME: 100 USD diarios"]
        assert [d["id"] for d in docs] == [da]
        assert [o["id"] for o in orgs] == [a.org]
        # Aunque se pida explícitamente el tenant ajeno, RLS lo oculta.
        assert fetch_all(conn, "SELECT * FROM chunks WHERE organization_id=%s", (b.org,)) == []
        assert fetch_all(conn, "SELECT * FROM users WHERE id=%s", (b.user,)) == []

    # Worker con contexto de B tampoco ve A.
    with tenant_tx(SecurityContext(b.org), worker_pool) as conn:
        assert [r["text"] for r in fetch_all(conn, "SELECT text FROM chunks")] == ["Viáticos GLOBEX: 300 USD diarios"]


def test_no_context_means_no_rows(app_pool, make_tenant, owner):
    t = make_tenant("nocontext")
    d = _doc(owner, t, "x", [f"workspace:{t.ws}"])
    _seed_chunk(owner, t, d, "secreto")
    with app_pool.connection() as conn:
        assert conn.execute("SELECT count(*) AS n FROM chunks").fetchone()["n"] == 0
        assert conn.execute("SELECT count(*) AS n FROM documents").fetchone()["n"] == 0


def test_document_acl_restricts_within_tenant(make_tenant, owner, app_pool):
    t = make_tenant("acl")
    group = uuid.uuid4()
    other_user = uuid.uuid4()
    owner.execute("INSERT INTO users (id, identity_provider, external_subject, email) VALUES (%s,'test',%s,'o@x.test')",
                  (other_user, str(other_user)))
    owner.execute("INSERT INTO memberships (organization_id, user_id, role) VALUES (%s,%s,'member')", (t.org, other_user))
    owner.execute("INSERT INTO groups (id, organization_id, name) VALUES (%s,%s,'Legal')", (group, t.org))
    public = _doc(owner, t, "Manual general", [f"workspace:{t.ws}"])
    legal = _doc(owner, t, "Contrato confidencial", [f"group:{group}"])
    _seed_chunk(owner, t, public, "manual general")
    _seed_chunk(owner, t, legal, "cláusula confidencial")

    member = SecurityContext(t.org, other_user, (f"user:{other_user}", f"workspace:{t.ws}"))
    with tenant_tx(member, app_pool) as conn:
        titles = {r["title"] for r in fetch_all(conn, "SELECT title FROM documents")}
        assert titles == {"Manual general"}
        assert {r["text"] for r in fetch_all(conn, "SELECT text FROM chunks")} == {"manual general"}
        # No revela existencia ni metadatos del documento restringido.
        assert fetch_all(conn, "SELECT * FROM document_versions WHERE document_id=%s", (legal,)) == []

    legal_member = SecurityContext(t.org, other_user, (f"user:{other_user}", f"workspace:{t.ws}", f"group:{group}"))
    with tenant_tx(legal_member, app_pool) as conn:
        assert {r["title"] for r in fetch_all(conn, "SELECT title FROM documents")} == {"Manual general",
                                                                                          "Contrato confidencial"}


def test_cannot_write_into_other_tenant(make_tenant, app_pool):
    a, b = make_tenant("w1"), make_tenant("w2")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with tenant_tx(SecurityContext(a.org, a.user, a.principals), app_pool) as conn:
            conn.execute("INSERT INTO documents (id, organization_id, workspace_id, title) VALUES (%s,%s,%s,'x')",
                         (uuid.uuid4(), b.org, b.ws))


def test_app_role_cannot_bypass_rls_or_write_chunks(app_pool, make_tenant):
    t = make_tenant("priv")
    with app_pool.connection() as conn:
        row = conn.execute("SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user").fetchone()
        assert row == {"rolbypassrls": False, "rolsuper": False}
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with tenant_tx(SecurityContext(t.org, t.user, t.principals), app_pool) as conn:
            conn.execute("DELETE FROM chunks")


def test_audit_chain_links_events(make_tenant, app_pool, owner):
    t = make_tenant("audit")
    with tenant_tx(SecurityContext(t.org, t.user, t.principals), app_pool) as conn:
        for i in range(3):
            conn.execute("INSERT INTO audit_events (organization_id, actor_id, action, resource, decision) "
                         "VALUES (%s,%s,%s,'r','allow')", (t.org, t.user, f"a{i}"))
    rows = owner.execute("SELECT prev_hash, hash FROM audit_events WHERE organization_id=%s ORDER BY id",
                         (t.org,)).fetchall()
    assert rows[0]["prev_hash"] is None
    assert rows[1]["prev_hash"] == rows[0]["hash"] and rows[2]["prev_hash"] == rows[1]["hash"]
