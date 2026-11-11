"""RAG-05: unidades del grafo (extracción, validación, generador local con puentes, modo efectivo)."""

import json
import uuid

from ragsis_ai.gateway import AIGateway
from ragsis_ai.providers.local import LocalProvider, graph_heuristic
from ragsis_ai.registry import ModelRegistry
from ragsis_ai.types import DataClass, Evidence, GenerationRequest, TenantAIPolicy
from ragsis_core.internal_auth import InternalClaims, issue_internal_token, verify_internal_token
from ragsis_ingest.graph import GraphExtractor, modal_anchor, normalize_name, parse_graph
from ragsis_rag.orchestrator import QueryOptions, QueryOrchestrator
from ragsis_rag.prompting import modality_preference
from ragsis_rag.retrieval import Candidate

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


def test_extractor_skips_unknown_kinds_and_records_usage():
    gw = AIGateway()
    graphs, stats = GraphExtractor(gw).extract([("heading", TEXT), ("text", TEXT)], TenantAIPolicy())
    assert list(graphs) == [1] and stats.chunks == 1 and stats.model == "local-graph-heuristic@v1"
    assert stats.anchors == 0 and gw.calls[-1].kind == "generate"


def test_modal_anchor_name_is_deterministic_and_document_scoped():
    a = modal_anchor("figure", "Figura 2: Ventas.\nDescripción…", caption="Figura 2: Ventas.", page=4, ordinal=7,
                     title="Informe anual")
    assert (a["name"], a["key"], a["type"]) == ("Figura 2 · Informe anual", "figura 2 informe anual", "figura")
    assert a["description"].startswith("Figura 2: Ventas.")
    assert modal_anchor("table", "| a | b |", caption="Table 3.1 — totals", title="R")["name"] == "Tabla 3.1 · R"
    assert modal_anchor("figure", "x", caption="Figurativo", page=4, ordinal=7, title="D")["name"] == "Figura p.4 n.8 · D"
    assert modal_anchor("equation", "E = mc^2", ordinal=0)["name"] == "Ecuación n.1"
    # Otro documento con su propia "Figura 2" no comparte nodo.
    assert modal_anchor("figure", "x", caption="Figura 2", title="Otro")["key"] != a["key"]
    assert modal_anchor("text", TEXT) is None


def test_extractor_anchors_non_text_chunks_with_belongs_to_edges():
    fig = "Figura 2: organigrama.\nDescripción de la figura (generada por IA): " + TEXT
    graphs, stats = GraphExtractor(AIGateway()).extract(
        [("text", TEXT), ("figure", fig, {"caption": "Figura 2: organigrama.", "page": 3, "ordinal": 1}),
         ("equation", "x = y + 1", {"caption": "", "page": 5, "ordinal": 2})],
        TenantAIPolicy(), title="Manual")
    assert stats.anchors == 2 and stats.chunks == 3
    # El chunk de texto no cambia: sin ancla ni relaciones pertenece_a.
    assert not any(e["type"] == "figura" for e in graphs[0].entities)
    assert not any(r["keywords"] == "pertenece_a contenido_en" for r in graphs[0].relations)
    g = graphs[1]
    anchor = next(e for e in g.entities if e["type"] == "figura")
    assert anchor["key"] == "figura 2 manual"
    members = {e["key"] for e in g.entities} - {anchor["key"]}
    assert {"direccion financiera", "laura gomez"} <= members
    belongs = {r["src_key"] for r in g.relations if r["dst_key"] == anchor["key"]}
    assert belongs == members
    # Fusión por nombre: la entidad de la figura es la misma clave que la del chunk de texto.
    assert "direccion financiera" in {e["key"] for e in graphs[0].entities}
    # Una ecuación sin entidades propias sigue siendo un nodo del grafo.
    assert [e["name"] for e in graphs[2].entities] == ["Ecuación p.5 n.3 · Manual"] and graphs[2].relations == []


def test_modality_preference_from_lexical_cues():
    assert modality_preference("¿Qué muestra la Figura 2?") == ("figure",)
    assert modality_preference("Según el gráfico y la tabla de ventas") == ("figure", "table")
    assert modality_preference("Which equation defines the loss?") == ("equation",)
    assert modality_preference("¿Cuál es la fórmula del interés?") == ("equation",)
    assert modality_preference("¿Quién aprueba las compras?") == ()
    assert modality_preference("configurar el equipo") == ()


def _cand(kind: str, n: int) -> Candidate:
    return Candidate(uuid.uuid4(), uuid.uuid4(), uuid.uuid4(), "t", "f", 1, "", 1, 1, f"c{n}", kind, n, 10, None, None,
                     0.5, n, None, None)


def test_reserve_modality_promotes_only_when_the_cut_has_none():
    strong = [_cand("text", i) for i in range(4)] + [_cand("figure", 4), _cand("figure", 5)]
    out = QueryOrchestrator._reserve_modality(strong, ("figure",), 3)
    assert [c.ordinal for c in out] == [0, 1, 4, 2, 3, 5]
    assert QueryOrchestrator._reserve_modality(strong, (), 3) is strong
    assert QueryOrchestrator._reserve_modality(strong, ("table",), 3) is strong        # nada de ese tipo
    assert QueryOrchestrator._reserve_modality(strong, ("figure",), 5) is strong       # ya entra en el corte
    assert QueryOrchestrator._reserve_modality(strong, ("figure",), 0) is strong


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
