"""Recuperación híbrida (pgvector + full-text español) con filtros de seguridad obligatorios.

El filtro ACL se aplica dos veces: en la consulta (principals verificados) y por RLS en la BD.
La fusión usa Reciprocal Rank Fusion (RRF) y el filtro ocurre ANTES del reranking/generación.

GraphRAG (RAG-05, ADR-019): `graph_search` produce listas ordenadas de chunks a partir de entidades/relaciones cuya
procedencia es visible para el usuario (modo local: entidades + vecinos a 1 salto; global: relaciones). Esas listas
entran al mismo RRF y los chunks pasan por los mismos filtros de seguridad: las citas siguen siendo chunks.
Las semillas combinan coincidencia léxica y similitud densa sobre embeddings de entidades/relaciones (ADR-029);
`graph_facts` devuelve las entidades y relaciones de la evidencia seleccionada para el contexto del prompt.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, field
from datetime import date

import psycopg
from ragsis_core.db import fetch_all
from ragsis_core.text import SPANISH_STOPWORDS, content_terms, fold

RRF_K = 60
# Preferencia de modalidad inferida de la pregunta (ADR-029): medio voto de primer puesto para los chunks del tipo
# pedido. Desempata a favor de la figura/tabla sin dejar que supere a evidencia textual claramente mejor.
MODALITY_BONUS = 0.5 / (RRF_K + 1)
GRAPH_MODES = ("off", "local", "global", "hybrid")
GRAPH_SEEDS = 8
_TERM_RE = re.compile(r"[0-9a-záéíóúüñ]+", re.I)


@dataclass
class Candidate:
    chunk_id: uuid.UUID
    document_id: uuid.UUID
    version_id: uuid.UUID
    title: str
    filename: str
    version_no: int
    section_path: str
    page_start: int | None
    page_end: int | None
    text: str
    kind: str
    ordinal: int
    token_count: int
    effective_from: date | None
    effective_to: date | None
    similarity: float | None
    sem_rank: int | None
    lex_score: float | None
    lex_rank: int | None
    rrf: float = 0.0
    rerank: float | None = None
    context_before: str = ""
    context_after: str = ""
    extra: dict = field(default_factory=dict)
    bbox: list[float] | None = None
    asset_key: str | None = None
    meta: dict = field(default_factory=dict)
    graph_local_rank: int | None = None
    graph_global_rank: int | None = None
    bridges: list[str] = field(default_factory=list)

    @property
    def page(self) -> int | None:
        return self.page_start


def tsquery_terms(question: str, limit: int = 16) -> str | None:
    """OR de términos de contenido saneados (solo [0-9a-zñáéíóú]); None si no hay términos."""
    seen: list[str] = []
    for raw in _TERM_RE.findall(question.lower()):
        if fold(raw) in SPANISH_STOPWORDS or (len(raw) < 3 and not raw.isdigit()):
            continue
        if raw not in seen:
            seen.append(raw)
    return " | ".join(seen[:limit]) or None


_SQL = """
WITH sem AS (
  SELECT e.chunk_id,
         1 - (e.embedding <=> %(qvec)s) AS sim,
         row_number() OVER (ORDER BY e.embedding <=> %(qvec)s) AS rnk
    FROM chunk_embeddings e
    JOIN chunks c ON c.id = e.chunk_id
   WHERE e.organization_id = %(org)s
     AND e.model_version = %(mv)s
     AND c.workspace_id = %(ws)s
     AND c.index_state = 'active'
   ORDER BY e.embedding <=> %(qvec)s
   LIMIT %(k)s
), lex AS (
  SELECT c.id AS chunk_id,
         ts_rank_cd(c.tsv, q) AS score,
         row_number() OVER (ORDER BY ts_rank_cd(c.tsv, q) DESC) AS rnk
    FROM chunks c, to_tsquery('spanish', %(tsq)s) q
   WHERE %(tsq)s IS NOT NULL
     AND c.organization_id = %(org)s
     AND c.workspace_id = %(ws)s
     AND c.index_state = 'active'
     AND c.tsv @@ q
   ORDER BY score DESC
   LIMIT %(k)s
), graph AS (
  SELECT * FROM unnest(%(g_ids)s::uuid[], %(g_local)s::int[], %(g_global)s::int[]) AS g(chunk_id, local_rank, global_rank)
)
SELECT c.id AS chunk_id, c.document_id, c.version_id, c.section_path, c.page_start, c.page_end, c.text,
       c.kind, c.ordinal, c.token_count, c.bbox, c.asset_key, c.meta,
       d.title, v.filename, v.version_no, v.effective_from, v.effective_to,
       sem.sim AS similarity, sem.rnk AS sem_rank, lex.score AS lex_score, lex.rnk AS lex_rank,
       graph.local_rank AS graph_local_rank, graph.global_rank AS graph_global_rank
  FROM chunks c
  JOIN documents d ON d.id = c.document_id
  JOIN document_versions v ON v.id = c.version_id
  LEFT JOIN sem ON sem.chunk_id = c.id
  LEFT JOIN lex ON lex.chunk_id = c.id
  LEFT JOIN graph ON graph.chunk_id = c.id
 WHERE (sem.chunk_id IS NOT NULL OR lex.chunk_id IS NOT NULL OR graph.chunk_id IS NOT NULL)
   AND c.organization_id = %(org)s
   AND c.workspace_id = %(ws)s
   AND c.index_state = 'active'
   AND d.status = 'active'
   AND v.is_current
   AND EXISTS (SELECT 1 FROM document_acl a
                WHERE a.document_id = c.document_id AND a.principal = ANY(%(principals)s))
   AND (%(as_of)s::date IS NULL
        OR ((v.effective_from IS NULL OR v.effective_from <= %(as_of)s::date)
            AND (v.effective_to IS NULL OR v.effective_to >= %(as_of)s::date)))
"""


def _rrf(rank: int | None) -> float:
    return 1.0 / (RRF_K + rank) if rank else 0.0


def hybrid_search(conn: psycopg.Connection, *, organization_id: uuid.UUID, workspace_id: uuid.UUID,
                  principals: list[str], question: str, query_vector: list[float], model_version: str,
                  k: int = 30, as_of: date | None = None,
                  graph: dict[uuid.UUID, tuple[int | None, int | None]] | None = None,
                  prefer_kinds: tuple[str, ...] = ()) -> list[Candidate]:
    """`graph`: {chunk_id: (rank_local, rank_global)} de `graph_search`; se fusiona por RRF con sem/lex y
    pasa por exactamente los mismos filtros (tenant, workspace, activo, vigente, ACL, as_of).
    `prefer_kinds`: tipos de chunk que la pregunta pide (figure/table/equation); solo reordena candidatos que ya
    pasaron esos filtros, nunca añade ninguno."""
    import numpy as np

    graph = graph or {}

    with conn.cursor() as cur:
        # pgvector >= 0.8: escaneo iterativo para que los filtros de tenant/ACL no vacíen el top-k.
        cur.execute("SET LOCAL hnsw.ef_search = 200")
        cur.execute("SET LOCAL hnsw.iterative_scan = 'relaxed_order'")
    rows = fetch_all(conn, _SQL, {
        "qvec": np.array(query_vector, dtype=np.float32), "org": organization_id, "mv": model_version,
        "ws": workspace_id, "k": k, "tsq": tsquery_terms(question), "principals": principals, "as_of": as_of,
        "g_ids": list(graph), "g_local": [v[0] for v in graph.values()], "g_global": [v[1] for v in graph.values()],
    })
    cands = [Candidate(**r) for r in rows]
    for c in cands:
        c.rrf = _rrf(c.sem_rank) + _rrf(c.lex_rank) + _rrf(c.graph_local_rank) + _rrf(c.graph_global_rank)
        if c.kind in prefer_kinds:
            c.rrf += MODALITY_BONUS
            c.extra["modality"] = True
    cands.sort(key=lambda c: c.rrf, reverse=True)
    return dedupe(cands)


def dedupe(cands: list[Candidate]) -> list[Candidate]:
    """Elimina fragmentos casi idénticos (p. ej. plantillas repetidas entre documentos)."""
    seen: set[str] = set()
    out = []
    for c in cands:
        key = fold(c.text)[:200]
        if key in seen:
            continue
        seen.add(key)
        out.append(c)
    return out


def expand_parents(conn: psycopg.Connection, cands: list[Candidate], max_tokens_each: int = 250) -> None:
    """Expansión contextual: añade fragmentos vecinos de la misma sección (parent-child ligero)."""
    if not cands:
        return
    keys = [(c.version_id, c.ordinal) for c in cands if c.token_count < 400]
    if not keys:
        return
    rows = fetch_all(conn, """
        SELECT n.version_id, n.ordinal, n.section_path, n.text, n.token_count
          FROM chunks n
          JOIN unnest(%s::uuid[], %s::int[]) AS t(version_id, ordinal)
            ON n.version_id = t.version_id AND n.ordinal IN (t.ordinal - 1, t.ordinal + 1)
         WHERE n.index_state = 'active'""",
        ([k[0] for k in keys], [k[1] for k in keys]))
    by_key = {(r["version_id"], r["ordinal"]): r for r in rows}
    for c in cands:
        before = by_key.get((c.version_id, c.ordinal - 1))
        after = by_key.get((c.version_id, c.ordinal + 1))
        if before and before["section_path"] == c.section_path and before["token_count"] <= max_tokens_each:
            c.context_before = before["text"]
        if after and after["section_path"] == c.section_path and after["token_count"] <= max_tokens_each:
            c.context_after = after["text"]


# ---------------------------------------------------------------------------- GraphRAG (RAG-05)
# Toda fila del grafo se lee a través de su procedencia (`*_sources`) con chunk activo del workspace y ACL del
# documento explícita (además de la RLS de la BD). Nada global: puntajes y vecinos se calculan solo con fuentes
# visibles para este usuario.
_VISIBLE = """EXISTS (SELECT 1 FROM chunks c{n}
                WHERE c{n}.id = {alias}.chunk_id AND c{n}.workspace_id = %(ws)s AND c{n}.index_state = 'active')
   AND EXISTS (SELECT 1 FROM document_acl a{n}
                WHERE a{n}.document_id = {alias}.document_id AND a{n}.principal = ANY(%(principals)s))"""


def _vis(alias: str, n: int) -> str:
    return _VISIBLE.format(alias=alias, n=n)


GRAPH_VECTOR_K = 40


def _seed_sql(table: str, id_col: str, lex_score: str, use_vec: bool) -> str:
    """Semillas del grafo: coincidencia léxica (tsvector) y, con vector de consulta, similitud densa sobre los
    embeddings de procedencia (ADR-029). Ambas listas se normalizan a 0..1 y se suman por entidad/relación.
    La similitud tiene piso (`min_sim`, el umbral de evidencia del modelo): sin él, el vecino más cercano siempre
    devolvería algo aunque la pregunta no tenga nada que ver."""
    lex = f"""
  lex AS (
    SELECT s.{id_col} AS id, max({lex_score}) AS score
      FROM {table} s, q
     WHERE s.organization_id = %(org)s AND s.tsv @@ q.q AND {_vis("s", 1)}
     GROUP BY s.{id_col}
     ORDER BY score DESC
     LIMIT %(seeds)s
  )"""
    parts = "SELECT id, score / NULLIF(max(score) OVER (), 0) AS score FROM lex"
    vec = ""
    if use_vec:
        vec = f""",
  near AS (
    SELECT e.{id_col} AS id, 1 - (e.embedding <=> %(qvec)s) AS sim
      FROM {table.removesuffix("s")}_embeddings e
     WHERE e.organization_id = %(org)s AND e.model_version = %(mv)s AND {_vis("e", 9)}
     ORDER BY e.embedding <=> %(qvec)s
     LIMIT %(vk)s
  ), vec AS (
    SELECT id, max(sim) AS score FROM near WHERE sim >= %(min_sim)s GROUP BY id ORDER BY score DESC LIMIT %(seeds)s
  )"""
        parts += " UNION ALL SELECT id, score FROM vec"
    return f"""{lex}{vec},
  seed AS (
    SELECT id, sum(score) AS score FROM ({parts}) u WHERE score IS NOT NULL
     GROUP BY id ORDER BY score DESC, id LIMIT %(seeds)s
  )"""


def _graph_local_sql(use_vec: bool) -> str:
    seeds = _seed_sql("entity_sources", "entity_id", "ts_rank_cd(s.tsv, q.q)", use_vec)
    return f"""
WITH q AS (SELECT to_tsquery('spanish', %(tsq)s) AS q),{seeds},
rel AS (
  SELECT rs.chunk_id, rs.weight, sd.score,
         CASE WHEN r.src_entity_id = sd.id THEN r.dst_entity_id ELSE r.src_entity_id END AS nbr_id
    FROM seed sd
    JOIN relations r ON sd.id IN (r.src_entity_id, r.dst_entity_id)
    JOIN relation_sources rs ON rs.relation_id = r.id
   WHERE rs.organization_id = %(org)s AND {_vis("rs", 2)}
), nbr AS (
  -- grado del vecino contado solo con relaciones visibles para este usuario
  SELECT nbr_id, max(score) AS score, count(*) AS degree FROM rel GROUP BY nbr_id
), hits AS (
  SELECT s.chunk_id, sd.score FROM seed sd JOIN entity_sources s ON s.entity_id = sd.id
   WHERE {_vis("s", 3)}
  UNION ALL
  SELECT chunk_id, score * 0.8 * least(weight, 5) / 5 + score * 0.4 FROM rel
  UNION ALL
  SELECT s.chunk_id, nb.score * 0.5 * (1 + ln(nb.degree)) / (1 + ln(nb.degree) + 1)
    FROM nbr nb JOIN entity_sources s ON s.entity_id = nb.nbr_id
   WHERE {_vis("s", 4)}
)
SELECT chunk_id, max(score) AS score FROM hits GROUP BY chunk_id ORDER BY score DESC, chunk_id LIMIT %(k)s
"""


def _graph_global_sql(use_vec: bool) -> str:
    seeds = _seed_sql("relation_sources", "relation_id", "ts_rank_cd(s.tsv, q.q) * s.weight", use_vec)
    return f"""
WITH q AS (SELECT to_tsquery('spanish', %(tsq)s) AS q),{seeds},
hits AS (
  SELECT rs.chunk_id, t.score FROM seed t JOIN relation_sources rs ON rs.relation_id = t.id
   WHERE {_vis("rs", 2)}
  UNION ALL
  SELECT s.chunk_id, t.score * 0.5
    FROM seed t JOIN relations r ON r.id = t.id
    JOIN entity_sources s ON s.entity_id IN (r.src_entity_id, r.dst_entity_id)
   WHERE {_vis("s", 3)}
)
SELECT chunk_id, max(score) AS score FROM hits GROUP BY chunk_id ORDER BY score DESC, chunk_id LIMIT %(k)s
"""


def graph_search(conn: psycopg.Connection, *, organization_id: uuid.UUID, workspace_id: uuid.UUID,
                 principals: list[str], question: str, mode: str, k: int = 30,
                 query_vector: list[float] | None = None, model_version: str | None = None,
                 min_similarity: float = 0.0) -> dict[uuid.UUID, tuple[int | None, int | None]]:
    """Chunks recuperados vía grafo: {chunk_id: (rank_local, rank_global)}. Vacío si mode='off' o sin señal.

    Con `query_vector` (mismo modelo que el índice) las semillas combinan coincidencia léxica y similitud densa
    sobre entidades/relaciones; sin él, solo léxica."""
    if mode not in GRAPH_MODES:
        raise ValueError(f"modo de grafo desconocido {mode}")
    tsq = tsquery_terms(question)
    use_vec = query_vector is not None and bool(model_version)
    if mode == "off" or not (tsq or use_vec):
        return {}
    params = {"org": organization_id, "ws": workspace_id, "principals": principals, "tsq": tsq, "k": k,
              "seeds": GRAPH_SEEDS}
    if use_vec:
        import numpy as np

        params.update(qvec=np.array(query_vector, dtype=np.float32), mv=model_version, vk=GRAPH_VECTOR_K,
                      min_sim=min_similarity)
        with conn.cursor() as cur:
            # Igual que en hybrid_search: escaneo iterativo para que tenant/ACL no vacíen el top-k.
            cur.execute("SET LOCAL hnsw.ef_search = 200")
            cur.execute("SET LOCAL hnsw.iterative_scan = 'relaxed_order'")
    out: dict[uuid.UUID, tuple[int | None, int | None]] = {}
    if mode in ("local", "hybrid"):
        for i, r in enumerate(fetch_all(conn, _graph_local_sql(use_vec), params), start=1):
            out[r["chunk_id"]] = (i, None)
    if mode in ("global", "hybrid"):
        for i, r in enumerate(fetch_all(conn, _graph_global_sql(use_vec), params), start=1):
            out[r["chunk_id"]] = (out.get(r["chunk_id"], (None, None))[0], i)
    return out


GRAPH_FACTS_PER_CHUNK = 60


def graph_facts(conn: psycopg.Connection, *, organization_id: uuid.UUID, workspace_id: uuid.UUID,
                principals: list[str], chunk_ids: list[uuid.UUID]) -> list[dict]:
    """Entidades y relaciones cuya procedencia es uno de `chunk_ids` (la evidencia ya seleccionada).

    Devuelve [{chunk_id, kind: 'entity'|'relation', text}]. Solo menciones de ESOS chunks: lo que se muestre al
    modelo es citable con el [n] de su chunk y no añade nada que el usuario no pueda leer (ADR-019)."""
    if not chunk_ids:
        return []
    params = {"org": organization_id, "ws": workspace_id, "principals": principals, "ids": chunk_ids,
              "cap": GRAPH_FACTS_PER_CHUNK}
    ents = fetch_all(conn, f"""
        SELECT chunk_id, name, type, description FROM (
          SELECT s.chunk_id, s.name, s.type, s.description,
                 row_number() OVER (PARTITION BY s.chunk_id ORDER BY s.name) AS rn
            FROM entity_sources s
           WHERE s.organization_id = %(org)s AND s.chunk_id = ANY(%(ids)s) AND {_vis("s", 1)}) t
         WHERE rn <= %(cap)s""", params)
    rels = fetch_all(conn, f"""
        SELECT chunk_id, src, dst, keywords, description FROM (
          SELECT rs.chunk_id, a.name AS src, b.name AS dst, rs.keywords, rs.description,
                 row_number() OVER (PARTITION BY rs.chunk_id ORDER BY rs.weight DESC, a.name, b.name) AS rn
            FROM relation_sources rs
            JOIN relations r ON r.id = rs.relation_id
            JOIN entity_sources a ON a.entity_id = r.src_entity_id AND a.chunk_id = rs.chunk_id
            JOIN entity_sources b ON b.entity_id = r.dst_entity_id AND b.chunk_id = rs.chunk_id
           WHERE rs.organization_id = %(org)s AND rs.chunk_id = ANY(%(ids)s)
             AND rs.keywords NOT IN ('pertenece_a contenido_en', 'fila_de', 'columna_de') AND {_vis("rs", 1)}) t
         WHERE rn <= %(cap)s""", params)
    out = [{"chunk_id": r["chunk_id"], "kind": "entity",
            "text": f"{r['name']} ({r['type']}): {r['description']}" if r["description"] else f"{r['name']} ({r['type']})"}
           for r in ents if r["type"] not in ("fila", "columna")]
    out += [{"chunk_id": r["chunk_id"], "kind": "relation",
             "text": r["description"] if r["keywords"].startswith(("celda ", "unidad_de"))
             else f"{r['src']} → {r['dst']} ({r['keywords']}): {r['description']}"} for r in rels]
    return out


MAX_BRIDGES = 3
BRIDGE_REL_RANK = 0.5


def graph_bridges(conn: psycopg.Connection, *, organization_id: uuid.UUID, workspace_id: uuid.UUID,
                  principals: list[str], question: str, strong_ids: list[uuid.UUID],
                  hop_ids: list[uuid.UUID]) -> tuple[list[str], dict[uuid.UUID, list[str]]]:
    """Entidades puente y chunks de salto.

    Puente = entidad mencionada en la evidencia fuerte cuya descripción (de ESA mención visible) coincide mejor con
    la pregunta, sin estar ya nombrada en ella (máx. 3, rango >= 50 % del mejor). Devuelve los nombres puente tal
    como aparecen en la evidencia fuerte y, por cada chunk de salto que menciona un puente, su propia mención.
    """
    tsq = tsquery_terms(question)
    if not strong_ids or not tsq:
        return [], {}
    params = {"org": organization_id, "ws": workspace_id, "principals": principals, "tsq": tsq,
              "strong": strong_ids, "hop": hop_ids}
    rows = fetch_all(conn, f"""
        SELECT s.entity_id, s.name, ts_rank(to_tsvector('spanish', s.description), q) AS rank
          FROM entity_sources s, to_tsquery('spanish', %(tsq)s) q
         WHERE s.organization_id = %(org)s AND s.chunk_id = ANY(%(strong)s)
           AND to_tsvector('spanish', s.description) @@ q AND {_vis("s", 1)}
         ORDER BY rank DESC, s.name""", params)
    q_terms = set(content_terms(question))
    best: dict[uuid.UUID, tuple[float, str]] = {}
    for r in rows:
        terms = set(content_terms(r["name"]))
        if not terms or terms <= q_terms:       # ya está en la pregunta: no es un salto
            continue
        if r["entity_id"] not in best:
            best[r["entity_id"]] = (r["rank"], r["name"])
    if not best:
        return [], {}
    top = max(v[0] for v in best.values())
    chosen = sorted(((v[0], k, v[1]) for k, v in best.items() if v[0] >= BRIDGE_REL_RANK * top),
                    key=lambda x: (-x[0], x[2]))[:MAX_BRIDGES]
    names = [n for _, _, n in chosen]
    if not hop_ids:
        return names, {}
    hop_rows = fetch_all(conn, f"""
        SELECT h.chunk_id, h.name FROM entity_sources h
         WHERE h.organization_id = %(org)s AND h.chunk_id = ANY(%(hop)s) AND h.entity_id = ANY(%(ents)s)
           AND {_vis("h", 1)}
         ORDER BY h.chunk_id, h.name""", {**params, "ents": [k for _, k, _ in chosen]})
    out: dict[uuid.UUID, list[str]] = {}
    for r in hop_rows:
        out.setdefault(r["chunk_id"], []).append(r["name"])
    return names, out
