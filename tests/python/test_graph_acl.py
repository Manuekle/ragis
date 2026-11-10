"""RAG-05: el grafo (entidades/relaciones) hereda la ACL de sus chunks fuente (ADR-019).

Corpus: un documento público del workspace y otro restringido al grupo Socios comparten la entidad
"Proyecto Fénix"; el restringido introduce entidades y relaciones exclusivas (Grupo Orión, Marta Salas) y cifras.
Un usuario sin el grupo no debe ver nada derivado solo del restringido: ni claves, ni procedencia, ni chunks por
grafo, ni nombres puente, ni texto en la respuesta.
"""

import json
import uuid

import psycopg
import pytest
from ragsis_core.db import SecurityContext, fetch_all, tenant_tx
from ragsis_ingest.pipeline import IngestPipeline, JobMessage
from ragsis_ingest.reindex import enqueue, plan_versions
from ragsis_rag.orchestrator import QueryOptions, QueryOrchestrator
from ragsis_rag.retrieval import graph_bridges, graph_search

COMPRAS = """# Procedimiento de compras de tecnología

## Aprobación
Las compras de equipos de Tecnología las aprueba la Dirección Financiera.
El Proyecto Fénix se financia con el presupuesto de la Gerencia de Innovación.
"""

ORGANIGRAMA = """# Organigrama corporativo

## Responsables
La Dirección Financiera está a cargo de Laura Gómez desde 2024.
La Gerencia de Innovación está a cargo de Pedro Ruiz.
"""

ACTA = """# Acta confidencial de socios

## Decisiones
El Proyecto Fénix será vendido a Grupo Orión por 900 millones.
Grupo Orión es representado por Marta Salas en la negociación.
"""

SECRET_NAMES = {"grupo orion", "marta salas"}
SECRET_MARKERS = ("Orión", "Orion", "Marta", "900")
# Pregunta cuyo puente desde el documento público ("Proyecto Fénix") lleva al acta restringida.
BRIDGE_Q = "¿Qué se financia con el presupuesto de innovación y a quién será vendido?"


@pytest.fixture
def pipeline(worker_pool, s3):
    return IngestPipeline(pool=worker_pool)


@pytest.fixture
def rag(app_pool):
    return QueryOrchestrator(pool=app_pool)


@pytest.fixture
def corpus(make_tenant, s3, pipeline, owner):
    """Tenant con grafo habilitado por override de organización (plan team: deshabilitado por defecto)."""
    t = make_tenant("graphacl")
    t.set_graph("on")
    socios = uuid.uuid4()
    owner.execute("INSERT INTO groups (id, organization_id, name) VALUES (%s,%s,'Socios')", (socios, t.org))
    docs = {}
    for name, text, acl in (("compras", COMPRAS, None), ("organigrama", ORGANIGRAMA, None),
                            ("acta", ACTA, [f"group:{socios}"])):
        doc, _, msg = t.add_document(s3, f"{name}.md", text.encode(), "text/markdown", title=name.title(), acl=acl)
        assert pipeline.handle(msg) == "indexed"
        docs[name] = doc
    t.socios = socios
    t.docs = docs
    t.member_principals = t.principals + (f"group:{socios}",)
    return t


def _chunks_of(owner, doc) -> set:
    return {r["id"] for r in owner.execute("SELECT id FROM chunks WHERE document_id=%s", (doc,)).fetchall()}


def test_graph_was_extracted_including_restricted_only_entities(corpus, owner):
    # Sanidad: el negativo solo prueba algo si las filas restringidas existen en la BD.
    names = {r["normalized_name"] for r in owner.execute(
        "SELECT normalized_name FROM entities WHERE organization_id=%s", (corpus.org,)).fetchall()}
    assert {"proyecto fenix", "direccion financiera", "laura gomez"} <= names
    assert SECRET_NAMES <= names
    n_rel = owner.execute("SELECT count(*) AS n FROM relation_sources WHERE document_id=%s",
                          (corpus.docs["acta"],)).fetchone()["n"]
    assert n_rel >= 1
    audit = owner.execute("SELECT metadata FROM audit_events WHERE organization_id=%s AND action='document.indexed' "
                          "ORDER BY id LIMIT 1", (corpus.org,)).fetchone()["metadata"]
    assert audit["graph"]["model"] == "local-graph-heuristic@v1"


def test_restricted_only_entities_and_relations_are_invisible(corpus, app_pool):
    ctx = SecurityContext(corpus.org, corpus.user, corpus.principals)
    with tenant_tx(ctx, app_pool) as conn:
        ents = {r["id"]: r["normalized_name"] for r in fetch_all(conn, "SELECT id, normalized_name FROM entities")}
        assert not SECRET_NAMES & set(ents.values())
        assert {"proyecto fenix", "direccion financiera"} <= set(ents.values())
        # Pedirlas explícitamente tampoco sirve.
        assert fetch_all(conn, "SELECT * FROM entities WHERE normalized_name = ANY(%s)", (list(SECRET_NAMES),)) == []
        # Relaciones: toda relación visible une entidades visibles (Fénix→Orión solo existe en el acta).
        for r in fetch_all(conn, "SELECT src_entity_id, dst_entity_id FROM relations"):
            assert r["src_entity_id"] in ents and r["dst_entity_id"] in ents
        # Procedencia: nada del documento restringido, ni siquiera de la entidad compartida.
        docs = {r["document_id"] for r in fetch_all(conn, "SELECT document_id FROM entity_sources UNION "
                                                          "SELECT document_id FROM relation_sources")}
        assert corpus.docs["acta"] not in docs
        # La descripción agregada de la entidad compartida se construye solo con menciones visibles.
        fenix = fetch_all(conn, """
            SELECT string_agg(s.description, ' ') AS d FROM entity_sources s JOIN entities e ON e.id = s.entity_id
             WHERE e.normalized_name = 'proyecto fenix'""")[0]["d"]
        assert "presupuesto" in fenix and not any(m in fenix for m in SECRET_MARKERS)
        text = json.dumps(fetch_all(conn, "SELECT name AS a, description AS b FROM entity_sources UNION ALL "
                                          "SELECT keywords, description FROM relation_sources"), ensure_ascii=False)
        assert not any(m in text for m in SECRET_MARKERS)

    # Con el grupo, lo mismo es visible (el filtro es la ACL, no la ausencia de datos).
    with tenant_tx(SecurityContext(corpus.org, corpus.user, corpus.member_principals), app_pool) as conn:
        names = {r["normalized_name"] for r in fetch_all(conn, "SELECT normalized_name FROM entities")}
        assert SECRET_NAMES <= names


@pytest.mark.parametrize("mode", ["local", "global", "hybrid"])
def test_graph_search_never_reaches_restricted_chunks(corpus, app_pool, owner, mode):
    secret_chunks = _chunks_of(owner, corpus.docs["acta"])
    q = "¿A quién será vendido el Proyecto Fénix y quién representa al comprador?"
    scope = {"organization_id": corpus.org, "workspace_id": corpus.ws}
    with tenant_tx(SecurityContext(corpus.org, corpus.user, corpus.principals), app_pool) as conn:
        hits = graph_search(conn, **scope, principals=list(corpus.principals), question=q, mode=mode)
        assert not secret_chunks & set(hits)
        public = _chunks_of(owner, corpus.docs["compras"])
        # Ni siquiera como puente: la entidad compartida no conecta con el chunk restringido.
        assert graph_bridges(conn, **scope, principals=list(corpus.principals), question=BRIDGE_Q,
                             hop_ids=list(secret_chunks), strong_ids=list(public))[1] == {}
    # Aunque la app pasara principals de más, la RLS de la sesión (sin el grupo) sigue filtrando.
    with tenant_tx(SecurityContext(corpus.org, corpus.user, corpus.principals), app_pool) as conn:
        hits = graph_search(conn, **scope, principals=list(corpus.member_principals), question=q, mode=mode)
        assert not secret_chunks & set(hits)
    with tenant_tx(SecurityContext(corpus.org, corpus.user, corpus.member_principals), app_pool) as conn:
        hits = graph_search(conn, **scope, principals=list(corpus.member_principals), question=q, mode=mode)
        assert secret_chunks & set(hits)
        # Con el grupo, la entidad compartida sí es puente hacia el acta: el {} de arriba lo produce la ACL.
        public = _chunks_of(owner, corpus.docs["compras"])
        assert graph_bridges(conn, **scope, principals=list(corpus.member_principals), question=BRIDGE_Q,
                             hop_ids=list(secret_chunks), strong_ids=list(public))[1]


def test_answer_without_group_does_not_leak_through_graph(corpus, rag):
    q = "¿A quién será vendido el Proyecto Fénix y quién representa al comprador?"
    for mode in ("local", "global", "hybrid"):
        r = rag.run(corpus.claims(graph=True), q, QueryOptions(graph_mode=mode))
        assert not any(m in r.answer for m in SECRET_MARKERS), r.answer
        assert all(c["document_id"] != str(corpus.docs["acta"]) for c in r.citations)
        assert all(not any(m in c["snippet"] for m in SECRET_MARKERS) for c in r.citations)
    member = rag.run(corpus.claims(graph=True, principals=corpus.member_principals), q)
    assert "Grupo Orión" in member.answer


def test_multi_hop_needs_graph_and_cites_chunks_of_both_documents(corpus, rag):
    q = "¿Quién está a cargo del área que aprueba las compras de equipos de Tecnología?"
    with_graph = rag.run(corpus.claims(graph=True), q)
    assert not with_graph.abstained, with_graph
    assert "Laura Gómez" in with_graph.answer and "Pedro Ruiz" not in with_graph.answer
    assert {c["document_id"] for c in with_graph.citations} == {str(corpus.docs["compras"]),
                                                                 str(corpus.docs["organigrama"])}
    assert all(c["chunk_id"] for c in with_graph.citations)
    assert with_graph.retrieval_strategy == "hybrid+graph_hybrid"

    # Sin grafo (modo off o tenant sin grafo en el claim) el segundo salto no aparece.
    for claims, opts in ((corpus.claims(graph=True), QueryOptions(graph_mode="off")),
                         (corpus.claims(graph=False), QueryOptions(graph_mode="hybrid"))):
        r = rag.run(claims, q, opts)
        assert "Laura Gómez" not in r.answer
        assert r.retrieval_strategy == "hybrid"


def test_unanswerable_question_still_abstains_with_graph(corpus, rag):
    r = rag.run(corpus.claims(graph=True), "¿Cuál es la política de teletrabajo en Japón?")
    assert r.abstained and r.citations == []


def test_cross_tenant_graph_invisible(corpus, make_tenant, s3, pipeline, app_pool, worker_pool):
    other = make_tenant("graphother")
    other.set_graph("on")
    _, _, msg = other.add_document(s3, "compras.md", COMPRAS.encode(), "text/markdown")
    assert pipeline.handle(msg) == "indexed"
    with tenant_tx(SecurityContext(other.org, other.user, other.principals), app_pool) as conn:
        assert all(r["organization_id"] == other.org
                   for r in fetch_all(conn, "SELECT organization_id FROM entities UNION ALL "
                                            "SELECT organization_id FROM entity_sources"))
        assert fetch_all(conn, "SELECT * FROM entities WHERE organization_id=%s", (corpus.org,)) == []
        assert graph_search(conn, organization_id=corpus.org, workspace_id=corpus.ws,
                            principals=list(corpus.member_principals), question="Proyecto Fénix", mode="hybrid") == {}
    with tenant_tx(SecurityContext(other.org), worker_pool) as conn:
        assert fetch_all(conn, "SELECT * FROM entities WHERE organization_id=%s", (corpus.org,)) == []
    with app_pool.connection() as conn:
        for table in ("entities", "entity_sources", "relations", "relation_sources"):
            assert conn.execute(f"SELECT count(*) AS n FROM {table}").fetchone()["n"] == 0


def test_app_role_cannot_write_graph(corpus, app_pool):
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with tenant_tx(SecurityContext(corpus.org, corpus.user, corpus.member_principals), app_pool) as conn:
            conn.execute("INSERT INTO entities (organization_id, workspace_id, normalized_name) VALUES (%s,%s,'x')",
                         (corpus.org, corpus.ws))


def test_source_must_match_its_chunk_document(corpus, worker_pool, owner):
    public_chunk = next(iter(_chunks_of(owner, corpus.docs["compras"])))
    with pytest.raises(psycopg.errors.CheckViolation):
        with tenant_tx(SecurityContext(corpus.org), worker_pool) as conn:
            eid = conn.execute("INSERT INTO entities (organization_id, workspace_id, normalized_name) "
                               "VALUES (%s,%s,'fuga') RETURNING id", (corpus.org, corpus.ws)).fetchone()["id"]
            # Atar un chunk público a un documento restringido (o al revés) rompería la ACL derivada.
            conn.execute("INSERT INTO entity_sources (entity_id, chunk_id, organization_id, document_id, name) "
                         "VALUES (%s,%s,%s,%s,'Fuga')", (eid, public_chunk, corpus.org, corpus.docs["acta"]))


def test_deleting_restricted_document_purges_its_graph(corpus, pipeline, owner):
    doc = corpus.docs["acta"]
    owner.execute("UPDATE documents SET status='deleting' WHERE id=%s", (doc,))
    job = uuid.uuid4()
    owner.execute("INSERT INTO ingestion_jobs (id, organization_id, kind, document_id, idempotency_key) "
                  "VALUES (%s,%s,'delete',%s,%s)", (job, corpus.org, doc, f"delete:{doc}"))
    assert pipeline.handle(JobMessage("delete", corpus.org, doc, None, job)) == "purged"
    names = {r["normalized_name"] for r in owner.execute(
        "SELECT normalized_name FROM entities WHERE organization_id=%s", (corpus.org,)).fetchall()}
    assert not SECRET_NAMES & names
    assert "proyecto fenix" in names        # sigue respaldada por el documento público
    for table in ("entity_sources", "relation_sources"):
        n = owner.execute(f"SELECT count(*) AS n FROM {table} WHERE document_id=%s", (doc,)).fetchone()["n"]
        assert n == 0


def test_graph_disabled_by_default_and_backfill_with_reindex(make_tenant, s3, pipeline, worker_pool, owner):
    t = make_tenant("graphbackfill")             # plan team, graph_mode inherit: sin grafo
    _, _, msg = t.add_document(s3, "organigrama.md", ORGANIGRAMA.encode(), "text/markdown")
    assert pipeline.handle(msg) == "indexed"

    def count():
        return owner.execute("SELECT count(*) AS n FROM entities WHERE organization_id=%s", (t.org,)).fetchone()["n"]

    assert count() == 0
    t.set_graph("on")
    versions = plan_versions(t.org, "graph", "local-hash-1024@v1", False, pool=worker_pool)
    assert len(versions) == 1
    [res] = enqueue(t.org, versions, "graph", "local-hash-1024@v1", inline=True, pool=worker_pool, pipeline=pipeline)
    assert res.startswith("reindexed:graph:")
    assert count() >= 2
    # Idempotente: repetir el backfill no duplica procedencia.
    before = owner.execute("SELECT count(*) AS n FROM entity_sources WHERE organization_id=%s", (t.org,)).fetchone()["n"]
    enqueue(t.org, versions, "graph", "local-hash-1024@v1", inline=True, pool=worker_pool, pipeline=pipeline)
    after = owner.execute("SELECT count(*) AS n FROM entity_sources WHERE organization_id=%s", (t.org,)).fetchone()["n"]
    assert before == after


def test_restricted_tenant_without_allowed_llm_indexes_without_graph(make_tenant, s3, worker_pool, owner,
                                                                     monkeypatch):
    from ragsis_core.settings import get_settings

    t = make_tenant("graphpolicy", data_class="restricted")
    t.set_graph("on")
    _, _, msg = t.add_document(s3, "organigrama.md", ORGANIGRAMA.encode(), "text/markdown")
    monkeypatch.setenv("AI_GRAPH_MODEL", "bedrock-claude-sonnet-5-5@v1")
    get_settings.cache_clear()
    try:
        assert IngestPipeline(pool=worker_pool).handle(msg) == "indexed"
    finally:
        monkeypatch.delenv("AI_GRAPH_MODEL")
        get_settings.cache_clear()
    assert owner.execute("SELECT count(*) AS n FROM entities WHERE organization_id=%s", (t.org,)).fetchone()["n"] == 0
    meta = owner.execute("SELECT metadata FROM audit_events WHERE organization_id=%s AND action='document.indexed'",
                         (t.org,)).fetchone()["metadata"]
    assert "graph_skipped_policy" in meta["graph"]["warnings"]
