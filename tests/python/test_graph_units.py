"""RAG-05: unidades del grafo (extracción, validación, generador local con puentes, modo efectivo)."""

import json
import uuid

from ragsis_ai.gateway import AIGateway
from ragsis_ai.providers.local import LocalProvider, graph_heuristic
from ragsis_ai.registry import ModelRegistry
from ragsis_ai.types import DataClass, Evidence, GenerationRequest, TenantAIPolicy
from ragsis_core.internal_auth import InternalClaims, issue_internal_token, verify_internal_token
from ragsis_ingest.graph import GraphExtractor, normalize_name, parse_graph
from ragsis_rag.orchestrator import QueryOptions, QueryOrchestrator

REG = ModelRegistry()
TEXT = ("Las compras de equipos de Tecnología las aprueba la Dirección Financiera. "
        "La Dirección Financiera está a cargo de Laura Gómez desde 2024.")


def test_heuristic_extracts_proper_names_and_relations():
    g = graph_heuristic(TEXT)
    names = {e["name"] for e in g["entities"]}
    assert {"Tecnología", "Dirección Financiera", "Laura Gómez"} <= names
    assert "Las" not in names and "La Dirección Financiera" not in names
    rel = {(r["source"], r["target"]) for r in g["relations"]}
    assert ("Dirección Financiera", "Laura Gómez") in rel
    assert next(e for e in g["entities"] if e["name"] == "Dirección Financiera")["type"] == "organizacion"


def test_parse_graph_keeps_only_mentions_anchored_in_the_chunk():
    raw = "Claro, aquí está:\n" + json.dumps({
        "entities": [
            {"name": "Dirección Financiera", "type": "Organización", "description": "Aprueba compras."},
            {"name": "Grupo Orión", "type": "organizacion", "description": "No aparece en el chunk."},
            {"name": "laura  gómez", "type": "persona"},
            {"name": "", "type": "x"}, "basura",
        ],
        "relations": [
            {"source": "Dirección Financiera", "target": "Laura Gómez", "keywords": "a cargo", "weight": 99},
            {"source": "Dirección Financiera", "target": "Grupo Orión", "keywords": "vende"},
            {"source": "Laura Gómez", "target": "Laura Gómez"},
        ],
    }) + "\nFin."
    g = parse_graph(raw, TEXT)
    assert [e["key"] for e in g.entities] == ["direccion financiera", "laura gomez"]
    assert g.entities[0]["type"] == "organizacion"
    assert len(g.relations) == 1 and g.relations[0]["weight"] == 10.0


def test_parse_graph_tolerates_garbage():
    assert parse_graph("no json", TEXT).entities == []
    assert parse_graph("{bad json}", TEXT).entities == []
    assert parse_graph("[1, 2]", TEXT).entities == []


def test_normalize_name():
    assert normalize_name("  Dirección   Financiera! ") == "direccion financiera"


def test_extractor_without_allowed_model_skips_with_warning(monkeypatch):
    from ragsis_core.settings import get_settings

    monkeypatch.setenv("AI_GRAPH_MODEL", "bedrock-claude-sonnet-5-5@v1")
    get_settings.cache_clear()
    try:
        ex = GraphExtractor(AIGateway())
        graphs, stats = ex.extract([("text", TEXT)], TenantAIPolicy(DataClass.RESTRICTED))
    finally:
        monkeypatch.delenv("AI_GRAPH_MODEL")
        get_settings.cache_clear()
    assert graphs == {} and stats.warnings == ["graph_skipped_policy"]


def test_extractor_without_model_configured(monkeypatch):
    from ragsis_core.settings import get_settings

    monkeypatch.setenv("AI_GRAPH_MODEL", "")
    get_settings.cache_clear()
    try:
        graphs, stats = GraphExtractor(AIGateway()).extract([("text", TEXT)], TenantAIPolicy())
    finally:
        monkeypatch.delenv("AI_GRAPH_MODEL")
        get_settings.cache_clear()
    assert graphs == {} and stats.warnings == ["graph_disabled_no_model"]


def test_extractor_local_skips_figures_and_records_usage():
    gw = AIGateway()
    graphs, stats = GraphExtractor(gw).extract([("figure", TEXT), ("text", TEXT)], TenantAIPolicy())
    assert list(graphs) == [1] and stats.chunks == 1 and stats.model == "local-graph-heuristic@v1"
    assert gw.calls[-1].kind == "generate"


def test_local_generator_uses_bridge_hints_only_for_second_hop():
    ev = (Evidence(1, "Las compras de equipos de Tecnología las aprueba la Dirección Financiera."),
          Evidence(2, "La Dirección Financiera está a cargo de Laura Gómez. La Gerencia de Innovación está a cargo "
                      "de Pedro Ruiz."))
    q = "¿Quién está a cargo del área que aprueba las compras de equipos de Tecnología?"
    model = REG.get("local-extractive@v1")
    plain = LocalProvider().generate(model, GenerationRequest("", "", q, ev)).text
    hinted = LocalProvider().generate(model, GenerationRequest("", "", q, ev, hints=("Dirección Financiera",))).text
    assert "Laura Gómez" not in plain
    assert "Laura Gómez" in hinted and "[2]" in hinted and "Pedro Ruiz" not in hinted


def _claims(graph: bool) -> InternalClaims:
    return InternalClaims(uuid.uuid4(), uuid.uuid4(), uuid.uuid4(), ("user:x",), "team", "internal", (), 6000,
                          False, graph)


def test_graph_mode_is_gated_by_signed_claim():
    assert QueryOrchestrator._graph_mode(_claims(False), QueryOptions(graph_mode="local")) == "off"
    assert QueryOrchestrator._graph_mode(_claims(True), QueryOptions()) == "hybrid"
    assert QueryOrchestrator._graph_mode(_claims(True), QueryOptions(graph_mode="global")) == "global"
    assert QueryOrchestrator._graph_mode(_claims(True), QueryOptions(graph_mode="off")) == "off"


def test_graph_claim_roundtrip_and_backward_compatible():
    c = _claims(True)
    assert verify_internal_token(issue_internal_token(c)).graph_enabled is True
    assert verify_internal_token(issue_internal_token(_claims(False))).graph_enabled is False
