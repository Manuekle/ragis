"""ADR-037: preguntas acotadas a un expediente, una carpeta, unos documentos o todos los espacios de la persona.

El alcance solo restringe: la ACL de cada documento y el tenant se aplican igual, así que una pregunta acotada nunca
ve un documento que la persona no podría leer espacio por espacio.
"""

import uuid
from dataclasses import replace

import pytest
from ragsis_core.internal_auth import InternalAuthError, issue_internal_token, verify_internal_token
from ragsis_ingest.pipeline import IngestPipeline
from ragsis_rag.orchestrator import QueryOrchestrator

SENTENCIA = """# Sentencia C-217 de 2026

## Decisión
En la Sentencia C-217 de 2026 la Corte Constitucional decidió declarar exequible el artículo 5 de la Ley 2466 de 2025,
dentro del expediente D-16.857 promovido por el ciudadano Juan Felipe Parra Rosas.
"""

MATRIZ = """# Matriz de riesgos de la nueva demanda

## Riesgos
El riesgo principal de la nueva demanda del caso Parra Rosas es la cosa juzgada constitucional, con probabilidad media.
"""

OTRO_CLIENTE = """# Contrato de arrendamiento Gómez

## Canon
El canon mensual de arrendamiento pactado con el cliente Gómez Herrera es de 3500000 pesos.
"""

HONORARIOS = """# Memorando confidencial de honorarios

## Honorarios del caso Parra Rosas
Los honorarios pactados en el expediente D-16.857 son 40 millones de pesos más una cuota de éxito del 10 por ciento.
"""

Q_SENTENCIA = "¿Qué decidió la Corte Constitucional en la Sentencia C-217 de 2026?"
Q_CANON = "¿Cuál es el canon mensual de arrendamiento pactado?"
Q_HONORARIOS = "¿Cuáles son los honorarios pactados en el expediente D-16.857?"


@pytest.fixture
def pipeline(worker_pool, s3):
    return IngestPipeline(pool=worker_pool)


@pytest.fixture
def rag(app_pool):
    return QueryOrchestrator(pool=app_pool)


@pytest.fixture
def firm(make_tenant, owner, s3, pipeline):
    """Firma con dos espacios (General y Litigio), un expediente partido entre ambos y un documento de otro cliente."""
    t = make_tenant("firma")
    general = t.ws
    litigio = uuid.uuid4()
    owner.execute("INSERT INTO workspaces (id, organization_id, name) VALUES (%s,%s,'Litigio constitucional')",
                  (litigio, t.org))
    owner.execute("INSERT INTO workspace_members (workspace_id, organization_id, user_id, role) VALUES (%s,%s,%s,'editor')",
                  (litigio, t.org, t.user))
    socio = uuid.uuid4()
    owner.execute("INSERT INTO users (id, identity_provider, external_subject, email) VALUES (%s,'test',%s,%s)",
                  (socio, str(socio), f"socio-{socio.hex[:6]}@example.test"))

    def add(ws, filename, text, title, acl=None):
        t.ws = ws
        try:
            doc, _, msg = t.add_document(s3, filename, text.encode(), "text/markdown", title=title, acl=acl)
        finally:
            t.ws = general
        assert pipeline.handle(msg) == "indexed"
        return doc

    docs = {
        "sentencia": add(general, "sentencia.md", SENTENCIA, "Sentencia C-217 de 2026"),
        "matriz": add(litigio, "matriz.md", MATRIZ, "Matriz de riesgos de la nueva demanda"),
        "otro": add(general, "arrendamiento.md", OTRO_CLIENTE, "Contrato de arrendamiento Gómez"),
        # Solo el socio puede leerlo, aunque esté en el expediente.
        "honorarios": add(general, "honorarios.md", HONORARIOS, "Memorando confidencial de honorarios",
                          acl=[f"user:{socio}"]),
    }
    matter = uuid.uuid4()
    owner.execute("INSERT INTO matters (id, organization_id, title, client_name, case_number) "
                  "VALUES (%s,%s,'Parra Rosas — D-16.857','Juan Felipe Parra Rosas','D-16.857')", (matter, t.org))
    owner.execute("UPDATE documents SET matter_id=%s WHERE id = ANY(%s)",
                  (matter, [docs["sentencia"], docs["matriz"], docs["honorarios"]]))
    principals = (f"user:{t.user}", f"workspace:{general}", f"workspace:{litigio}")
    return {"t": t, "general": general, "litigio": litigio, "matter": matter, "docs": docs, "principals": principals,
            "socio": socio}


def _claims(firm, home, *, wss=(), scope=None, user=None, principals=None):
    t = firm["t"]
    base = t.claims(principals=principals or firm["principals"], user=user)
    return replace(base, workspace_id=home, workspace_ids=tuple(wss), scope=scope)


def _cited(result) -> set:
    return {uuid.UUID(c["document_id"]) for c in result.citations}


def test_space_scope_only_sees_the_active_space(firm, rag):
    # Desde Litigio, como hasta ahora: la sentencia está en General y la pregunta se abstiene.
    r = rag.run(_claims(firm, firm["litigio"]), Q_SENTENCIA)
    assert r.abstained and r.citations == []


def test_matter_scope_searches_the_case_across_spaces(firm, rag, owner):
    scope = {"kind": "matter", "matter_id": firm["matter"]}
    wss = (firm["general"], firm["litigio"])
    r = rag.run(_claims(firm, firm["litigio"], wss=wss, scope=scope), Q_SENTENCIA)
    assert not r.abstained, r
    assert _cited(r) == {firm["docs"]["sentencia"]}

    # Otro cliente nunca entra en una respuesta acotada al expediente, aunque la pregunta sea sobre él.
    other = rag.run(_claims(firm, firm["litigio"], wss=wss, scope=scope), Q_CANON)
    assert firm["docs"]["otro"] not in _cited(other)
    assert other.abstained

    run = owner.execute("SELECT scope, workspace_id FROM query_runs WHERE id=%s", (r.trace_id,)).fetchone()
    assert run["workspace_id"] == firm["litigio"]
    assert run["scope"]["type"] == "matter" and run["scope"]["matter_id"] == str(firm["matter"])
    assert run["scope"]["workspaces"] == 2 and run["scope"]["documents"] == 2   # el memorando no es legible


def test_matter_scope_keeps_document_acl(firm, rag):
    scope = {"kind": "matter", "matter_id": firm["matter"]}
    wss = (firm["general"], firm["litigio"])
    r = rag.run(_claims(firm, firm["general"], wss=wss, scope=scope), Q_HONORARIOS)
    assert firm["docs"]["honorarios"] not in _cited(r)
    assert "40 millones" not in r.answer

    # Quien sí está en la ACL lo ve dentro del mismo expediente.
    socio = (f"user:{firm['socio']}", f"workspace:{firm['general']}", f"workspace:{firm['litigio']}")
    r2 = rag.run(_claims(firm, firm["general"], wss=wss, scope=scope, user=firm["socio"], principals=socio),
                 Q_HONORARIOS)
    assert firm["docs"]["honorarios"] in _cited(r2)


def test_all_spaces_scope_and_workspace_boundary(firm, rag):
    wss = (firm["general"], firm["litigio"])
    r = rag.run(_claims(firm, firm["litigio"], wss=wss, scope={"kind": "all"}), Q_CANON)
    assert firm["docs"]["otro"] in _cited(r)

    # Sin `wss` firmado la búsqueda no sale del espacio activo, aunque los principals den acceso a otro.
    r2 = rag.run(_claims(firm, firm["litigio"], scope={"kind": "all"}), Q_CANON)
    assert r2.abstained


def test_documents_and_folder_scopes(firm, rag, owner):
    t = firm["t"]
    wss = (firm["general"], firm["litigio"])
    only_matrix = {"kind": "documents", "document_ids": (firm["docs"]["matriz"],)}
    r = rag.run(_claims(firm, firm["general"], wss=wss, scope=only_matrix), Q_SENTENCIA)
    assert firm["docs"]["sentencia"] not in _cited(r)

    parent, child = uuid.uuid4(), uuid.uuid4()
    owner.execute("INSERT INTO folders (id, organization_id, workspace_id, name) VALUES (%s,%s,%s,'Cliente — Gómez')",
                  (parent, t.org, firm["general"]))
    owner.execute("INSERT INTO folders (id, organization_id, workspace_id, parent_id, name) VALUES (%s,%s,%s,%s,'Contratos')",
                  (child, t.org, firm["general"], parent))
    owner.execute("UPDATE documents SET folder_id=%s WHERE id=%s", (child, firm["docs"]["otro"]))
    folder = {"kind": "folder", "folder_id": parent}
    r2 = rag.run(_claims(firm, firm["general"], scope=folder), Q_CANON)
    assert _cited(r2) == {firm["docs"]["otro"]}            # la subcarpeta entra
    r3 = rag.run(_claims(firm, firm["general"], scope=folder), Q_SENTENCIA)
    assert firm["docs"]["sentencia"] not in _cited(r3)


def test_empty_scope_abstains_without_searching_elsewhere(firm, rag, owner):
    t = firm["t"]
    empty = uuid.uuid4()
    owner.execute("INSERT INTO matters (id, organization_id, title, client_name) VALUES (%s,%s,'Nuevo','Cliente nuevo')",
                  (empty, t.org))
    wss = (firm["general"], firm["litigio"])
    r = rag.run(_claims(firm, firm["general"], wss=wss, scope={"kind": "matter", "matter_id": empty}), Q_SENTENCIA)
    assert r.abstained and r.abstain_reason == "empty_scope" and r.citations == []


def test_scope_claims_round_trip_and_fail_closed(firm):
    t = firm["t"]
    claims = _claims(firm, firm["litigio"], wss=(firm["general"], firm["litigio"]),
                     scope={"kind": "matter", "matter_id": firm["matter"]})
    back = verify_internal_token(issue_internal_token(claims))
    assert back.search_workspaces == [firm["general"], firm["litigio"]]
    assert back.scope == {"kind": "matter", "matter_id": firm["matter"]}

    plain = verify_internal_token(issue_internal_token(t.claims()))
    assert plain.search_workspaces == [t.ws] and plain.scope is None

    import time

    import jwt
    from ragsis_core.settings import get_settings

    s = get_settings()
    now = int(time.time())
    base = {"iss": s.internal_token_issuer, "aud": s.internal_token_audience, "iat": now, "exp": now + 60,
            "sub": str(t.user), "org": str(t.org), "ws": str(t.ws), "principals": list(t.principals)}
    for bad in ({"sc": {"k": "matter"}}, {"sc": {"k": "nope"}}, {"sc": {"k": "documents", "d": []}},
                {"wss": []}, {"wss": ["not-a-uuid"]}):
        with pytest.raises(InternalAuthError):
            verify_internal_token(jwt.encode({**base, **bad}, s.internal_service_secret, algorithm="HS256"))
