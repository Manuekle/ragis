"""Query Orchestrator (sección 07 del plan).

identidad verificada → clasificación → filtros obligatorios → retrieval híbrido → fusión/dedupe →
expansión → rerank → contexto acotado → [imágenes de figuras: VLM-enhanced] → generación →
verificación de citas → persistencia/uso.

VLM-enhanced (RAG-04): si el modelo de generación tiene visión y la política lo permite, las imágenes de las
figuras YA seleccionadas como evidencia (es decir, autorizadas por RLS + ACL) se adjuntan etiquetadas con su [n].
Nunca se cargan activos de figuras que no estén en la evidencia ni fuera del prefijo S3 del tenant.

GraphRAG (RAG-05, ADR-019): con el grafo habilitado para el tenant, las listas de chunks del grafo (local/global)
se fusionan por RRF con el híbrido. Un chunk que llega solo por el grafo y no supera el umbral de evidencia entra
como "evidencia de salto" únicamente si ya hay evidencia fuerte y menciona una entidad puente: entidad de la
evidencia fuerte cuya mención visible es la más pertinente a la pregunta sin estar nombrada en ella (máx. 2).
Las citas siguen apuntando a chunks y el verificador no cambia.
"""

from __future__ import annotations

import hashlib
import json
import logging
import secrets
import time
from dataclasses import dataclass, field
from datetime import date

from botocore.exceptions import BotoCoreError, ClientError
from ragsis_ai.gateway import AIGateway
from ragsis_ai.policy import is_allowed
from ragsis_ai.providers.local import lexical_score
from ragsis_ai.types import DataClass, Evidence, GenerationRequest, ImageInput, TenantAIPolicy
from ragsis_core.aws import s3_client
from ragsis_core.db import execute, tenant_tx
from ragsis_core.internal_auth import InternalClaims
from ragsis_core.logging import log
from ragsis_core.settings import get_settings
from ragsis_core.telemetry import stage
from ragsis_core.text import estimate_tokens

from .prompting import ABSTAIN_TEXT, SYSTEM_PROMPT, classify, render_prompt
from .retrieval import Candidate, expand_parents, graph_bridges, graph_search, hybrid_search
from .verifier import verify

logger = logging.getLogger("ragsis.rag")

CANDIDATE_K = 30
MAX_EVIDENCE = 8
MIN_LEXICAL_COVERAGE = 0.4
SNIPPET_CHARS = 320
MAX_HOP_EVIDENCE = 2


@dataclass
class QueryOptions:
    as_of: date | None = None
    top_k: int = MAX_EVIDENCE
    max_output_tokens: int = 800
    graph_mode: str = "auto"      # auto | off | local | global | hybrid


@dataclass
class QueryResult:
    trace_id: str
    answer: str
    abstained: bool
    abstain_reason: str | None
    citations: list[dict]
    retrieval_strategy: str
    question_class: str
    generation_model: str | None
    embedding_model: str
    latency_ms: int
    timings: dict = field(default_factory=dict)
    usage: dict = field(default_factory=dict)


class QueryOrchestrator:
    def __init__(self, gateway: AIGateway | None = None, pool=None, s3=None) -> None:
        self.pool = pool
        self.gateway = gateway or AIGateway()
        self._s3 = s3

    @property
    def s3(self):
        return self._s3 if self._s3 is not None else s3_client()

    def run(self, claims: InternalClaims, question: str, options: QueryOptions | None = None) -> QueryResult:
        opts = options or QueryOptions()
        t_start = time.perf_counter()
        timings: dict[str, int] = {}
        trace_id = "qry_" + secrets.token_hex(12)
        policy = TenantAIPolicy(data_class=DataClass(claims.data_class), model_allowlist=claims.model_allowlist,
                                max_output_tokens=1200)
        qclass = classify(question)
        calls_before = len(self.gateway.calls)
        info: dict = {}

        with stage("rag.query", None, **{"ragsis.org_id": str(claims.organization_id),
                                         "ragsis.workspace_id": str(claims.workspace_id),
                                         "ragsis.user_id": str(claims.user_id), "ragsis.query_trace_id": trace_id,
                                         "ragsis.question_class": qclass}) as root:
            abstain_reason, answer, cited_ns, gen_model, selected, cands, strategy, emb = self._pipeline(
                claims, question, opts, policy, qclass, timings, info)
            root.set_attributes({"ragsis.candidates": len(cands), "ragsis.evidence": len(selected),
                                 "ragsis.cited": len(cited_ns), "ragsis.abstained": abstain_reason is not None,
                                 "ragsis.strategy": strategy, "gen_ai.request.model": gen_model or "none",
                                 "ragsis.embedding_model": emb.model_id})
        abstained = abstain_reason is not None
        if abstained:
            answer = ABSTAIN_TEXT
        by_n = {i + 1: c for i, c in enumerate(selected)}
        citations = [self._citation(n, by_n[n]) for n in cited_ns]

        new_calls = self.gateway.calls[calls_before:]
        usage = {
            "embedding_tokens": sum(c.input_tokens for c in new_calls if c.kind == "embed"),
            "llm_input_tokens": sum(c.input_tokens for c in new_calls if c.kind == "generate"),
            "llm_output_tokens": sum(c.output_tokens for c in new_calls if c.kind == "generate"),
            "rerank_calls": sum(1 for c in new_calls if c.kind == "rerank"),
            "vision_images": info.get("vision_images", 0),
        }
        cost = sum(self.gateway.registry.estimate_cost(c.model_id, c.input_tokens, c.output_tokens) for c in new_calls)
        latency = int((time.perf_counter() - t_start) * 1000)
        result = QueryResult(trace_id, answer, abstained, abstain_reason, citations, strategy, qclass, gen_model,
                             emb.model_id, latency, timings, usage)
        with stage("rag.persist"):
            self._persist(claims, question, result, cands, cost)
        log(logger, logging.INFO, "query.completed", trace_id=trace_id, org=str(claims.organization_id),
            abstained=abstained, latency_ms=latency, candidates=len(cands), cited=len(citations), strategy=strategy)
        return result

    def _pipeline(self, claims: InternalClaims, question: str, opts: QueryOptions, policy: TenantAIPolicy,
                  qclass: str, timings: dict, info: dict):
        # 1) embedding de la consulta (mismo modelo/versión que el índice activo)
        with stage("rag.embed", timings):
            emb = self.gateway.embed([question], policy, input_type="query")
            embed_model = self.gateway.embedding_model()

        ctx = claims.security_context()
        graph_mode = self._graph_mode(claims, opts)
        scope = {"organization_id": claims.organization_id, "workspace_id": claims.workspace_id,
                 "principals": list(claims.principals)}
        with tenant_tx(ctx, self.pool) as conn:
            # 2a) grafo (RAG-05): solo procedencia visible para el usuario
            graph = {}
            if graph_mode != "off":
                with stage("rag.graph", timings, **{"ragsis.graph_mode": graph_mode}) as span:
                    graph = graph_search(conn, **scope, question=question, mode=graph_mode, k=CANDIDATE_K)
                    span.set_attribute("ragsis.graph_chunks", len(graph))
            # 2b) retrieval híbrido con filtros de seguridad que el texto del usuario no puede alterar
            with stage("rag.retrieve", timings, **{"ragsis.candidate_k": CANDIDATE_K}):
                cands = hybrid_search(conn, **scope, question=question, query_vector=emb.vectors[0],
                                      model_version=emb.model_id, k=CANDIDATE_K, as_of=opts.as_of, graph=graph)

            # 3) umbral de evidencia: coincidencia de un solo término no basta; se exige cobertura lexical
            # mínima de la pregunta o similitud semántica sobre el umbral calibrado del modelo.
            for c in cands:
                c.extra["lex_cov"] = lexical_score(question, f"{c.section_path} {c.text}")
            strong = [c for c in cands if c.extra["lex_cov"] >= MIN_LEXICAL_COVERAGE
                      or (c.similarity or 0) >= embed_model.abstain_similarity]
            strategy = "hybrid"
            if claims.rerank_enabled and strong:
                with stage("rag.rerank", timings, **{"ragsis.rerank_inputs": len(strong[:CANDIDATE_K])}):
                    rr = self.gateway.rerank(question, [c.text for c in strong[:CANDIDATE_K]], policy)
                    for c, s in zip(strong, rr.scores, strict=False):
                        c.rerank = s
                    strong.sort(key=lambda c: c.rerank or 0.0, reverse=True)
                    strategy = "hybrid_rerank"
            hops, hints = self._hop_evidence(conn, scope, question, cands, strong) if graph else ([], ())
            max_items = min(opts.top_k, MAX_EVIDENCE)
            selected = self._fit_context(strong, claims.max_context_tokens, max_items - len(hops))
            if selected and hops:
                used = sum(c.token_count + 40 for c in selected)
                selected += self._fit_context(hops, claims.max_context_tokens - used, len(hops))
            if graph_mode != "off":
                strategy += f"+graph_{graph_mode}"
            expand_parents(conn, selected)

        abstain_reason = None
        answer = ""
        hints = hints if selected else ()
        cited_ns: list[int] = []
        gen_model = None
        if not selected:
            abstain_reason = "insufficient_evidence"
        else:
            evidence = [Evidence(i + 1, self._evidence_text(c), c.title, c.page) for i, c in enumerate(selected)]
            meta = [{"version_no": c.version_no, "effective_from": c.effective_from, "kind": c.kind} for c in selected]
            images = self._figure_images(claims, selected, policy, timings)
            prompt = render_prompt(question, evidence, meta, qclass, len(images))
            hints = tuple(dict.fromkeys([*hints, *(b for c in selected for b in c.bridges)]))
            with stage("rag.generate", timings) as span:
                gen = self.gateway.generate(GenerationRequest(SYSTEM_PROMPT, prompt, question, tuple(evidence),
                                                              opts.max_output_tokens, tuple(images), hints), policy)
                gen_model = gen.model_id
                if images and self.gateway.registry.get(gen.model_id).vision:
                    info["vision_images"] = len(images)
                span.set_attributes({"gen_ai.request.model": gen.model_id, "gen_ai.usage.input_tokens": gen.input_tokens,
                                     "gen_ai.usage.output_tokens": gen.output_tokens,
                                     "ragsis.vision_images": info.get("vision_images", 0)})
            with stage("rag.verify", timings) as span:
                ver = verify(gen.text, evidence)
                span.set_attributes({"ragsis.citations_valid": len(ver.cited),
                                     "ragsis.citations_invalid": len(ver.invalid_citations),
                                     "ragsis.sentences_dropped": ver.dropped_sentences})
            if ver.abstained:
                abstain_reason = ver.reason
            else:
                answer, cited_ns = ver.answer, ver.cited
        return abstain_reason, answer, cited_ns, gen_model, selected, cands, strategy, emb

    # ------------------------------------------------------------------
    @staticmethod
    def _graph_mode(claims: InternalClaims, opts: QueryOptions) -> str:
        """El tenant decide si hay grafo (claim firmado por la API); el cliente solo elige el modo."""
        if not claims.graph_enabled or opts.graph_mode == "off":
            return "off"
        return "hybrid" if opts.graph_mode == "auto" else opts.graph_mode

    @staticmethod
    def _hop_evidence(conn, scope: dict, question: str, cands: list[Candidate],
                      strong: list[Candidate]) -> tuple[list[Candidate], tuple[str, ...]]:
        """Evidencia de salto + nombres puente. Puente: entidad de la evidencia fuerte cuya mención visible es la
        más pertinente a la pregunta sin estar nombrada en ella. Salto: chunk traído por el grafo, bajo el umbral,
        que menciona un puente (máx. 2). Sin evidencia fuerte no hay salto: la abstención no cambia."""
        if not strong:
            return [], ()
        strong_ids = {c.chunk_id for c in strong}
        pool = [c for c in cands if c.chunk_id not in strong_ids and (c.graph_local_rank or c.graph_global_rank)]
        pool.sort(key=lambda c: c.rrf, reverse=True)
        pool = pool[:CANDIDATE_K]
        names, by_hop = graph_bridges(conn, **scope, question=question, strong_ids=list(strong_ids),
                                      hop_ids=[c.chunk_id for c in pool])
        hops = []
        for c in pool:
            if c.chunk_id in by_hop:
                c.bridges = by_hop[c.chunk_id]
                c.extra["hop"] = True
                hops.append(c)
            if len(hops) >= MAX_HOP_EVIDENCE:
                break
        return hops, tuple(names)

    def _figure_images(self, claims: InternalClaims, selected: list[Candidate], policy: TenantAIPolicy,
                       timings: dict) -> list[ImageInput]:
        s = get_settings()
        if s.rag_vlm_enhanced == "off":
            return []
        figs = [(i + 1, c) for i, c in enumerate(selected) if c.kind == "figure" and c.asset_key][:s.rag_vlm_max_images]
        if not figs:
            return []
        model = self.gateway.registry.get(s.ai_generation_model)
        if not model.vision or not is_allowed(model, policy)[0]:
            return []
        prefix = f"tenants/{claims.organization_id}/assets/"
        out: list[ImageInput] = []
        with stage("rag.load_figures", timings, **{"ragsis.figures": len(figs)}):
            for n, c in figs:
                if not c.asset_key.startswith(prefix):
                    log(logger, logging.ERROR, "asset fuera del prefijo del tenant", chunk=str(c.chunk_id))
                    continue
                try:
                    obj = self.s3.get_object(Bucket=s.s3_bucket, Key=c.asset_key)
                    if int(obj.get("ContentLength", 0)) > s.vision_max_image_bytes:
                        continue
                    data = obj["Body"].read(s.vision_max_image_bytes + 1)
                    if len(data) > s.vision_max_image_bytes:
                        continue
                    out.append(ImageInput(data, (c.meta or {}).get("mime", ""), f"Image for source [{n}]"))
                except (ClientError, BotoCoreError, ValueError) as exc:
                    # Sin imagen la figura sigue disponible por su descripción textual.
                    log(logger, logging.WARNING, "figura no cargada para VLM", chunk=str(c.chunk_id),
                        error=type(exc).__name__)
        return out

    @staticmethod
    def _evidence_text(c: Candidate) -> str:
        parts = []
        label = {"figure": "[Figura]", "table": "[Tabla]", "equation": "[Ecuación]"}.get(c.kind)
        if label:
            parts.append(label)
        if c.section_path:
            parts.append(f"[Sección: {c.section_path}]")
        if c.context_before:
            parts.append(c.context_before)
        parts.append(c.text)
        if c.context_after:
            parts.append(c.context_after)
        return "\n".join(parts)

    @staticmethod
    def _fit_context(cands: list[Candidate], max_tokens: int, max_items: int) -> list[Candidate]:
        out, used = [], 0
        for c in cands:
            if len(out) >= max_items:
                break
            cost = c.token_count + 40
            if used + cost > max_tokens:
                continue
            out.append(c)
            used += cost
        return out

    @staticmethod
    def _citation(n: int, c: Candidate) -> dict:
        snippet = c.text[:SNIPPET_CHARS] + ("…" if len(c.text) > SNIPPET_CHARS else "")
        return {
            "n": n,
            "document_id": str(c.document_id),
            "version_id": str(c.version_id),
            "version_no": c.version_no,
            "chunk_id": str(c.chunk_id),
            "title": c.title,
            "filename": c.filename,
            "section": c.section_path,
            "page": c.page_start,
            "effective_from": c.effective_from.isoformat() if c.effective_from else None,
            "snippet": snippet,
            "display_url": "signed-on-demand",
            "kind": c.kind,
            "bbox": [round(float(v), 4) for v in c.bbox] if c.bbox else None,
            "caption": (c.meta or {}).get("caption"),
            "has_asset": bool(c.asset_key),
            # La evidencia incluye texto generado por IA (descripción de figura o resumen de tabla).
            "ai_generated": (c.meta or {}).get("description_source") == "vlm" or "summary" in (c.meta or {}),
        }

    def _persist(self, claims: InternalClaims, question: str, r: QueryResult, cands: list[Candidate],
                 cost: float) -> None:
        refs = [{"chunk_id": str(c.chunk_id), "rrf": round(c.rrf, 6), "sim": round(c.similarity or 0, 4),
                 "lex_rank": c.lex_rank, "rerank": c.rerank, "graph_local_rank": c.graph_local_rank,
                 "graph_global_rank": c.graph_global_rank, "hop": bool(c.extra.get("hop"))}
                for c in cands[:CANDIDATE_K]]
        with tenant_tx(claims.security_context(), self.pool) as conn:
            execute(conn, """
                INSERT INTO query_runs (id, organization_id, workspace_id, user_id, question_sha256, question_class,
                  strategy, generation_model, embedding_model, abstained, abstain_reason, latency_ms, timings,
                  prompt_tokens, completion_tokens, cost_estimate_usd, retrieved_refs)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s,%s,%s,%s::jsonb)""",
                    (r.trace_id, claims.organization_id, claims.workspace_id, claims.user_id,
                     hashlib.sha256(question.encode("utf-8")).hexdigest(), r.question_class, r.retrieval_strategy,
                     r.generation_model, r.embedding_model, r.abstained, r.abstain_reason, r.latency_ms,
                     json.dumps(r.timings), r.usage["llm_input_tokens"], r.usage["llm_output_tokens"], cost,
                     json.dumps(refs)))
            for cit in r.citations:
                execute(conn, "INSERT INTO citations (query_run_id, organization_id, ordinal, chunk_id, document_id, "
                              "version_id, page) VALUES (%s,%s,%s,%s,%s,%s,%s)",
                        (r.trace_id, claims.organization_id, cit["n"], cit["chunk_id"], cit["document_id"],
                         cit["version_id"], cit["page"]))
            for kind in ("embedding_tokens", "llm_input_tokens", "llm_output_tokens", "rerank_calls", "vision_images"):
                if r.usage[kind]:
                    execute(conn, "INSERT INTO usage_events (organization_id, kind, quantity, ref) VALUES (%s,%s,%s,%s)",
                            (claims.organization_id, kind, r.usage[kind], r.trace_id))
            execute(conn, "INSERT INTO usage_events (organization_id, kind, quantity, ref) VALUES (%s,'query',1,%s)",
                    (claims.organization_id, r.trace_id))


def estimate_question_tokens(q: str) -> int:
    return estimate_tokens(q)
