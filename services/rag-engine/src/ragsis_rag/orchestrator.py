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

Modalidad (ADR-029): si la pregunta nombra un tipo de contenido ("según la figura…", "en la tabla…"), los chunks de
ese tipo reciben un bono en la fusión y, si alguno supera el umbral de evidencia pero quedaría fuera del corte, ocupa
el último puesto de la evidencia. Contrarresta el sesgo hacia el texto sin relajar umbrales ni filtros.

Contexto de grafo (ADR-029): con el grafo activo, las entidades y relaciones cuya procedencia es la evidencia ya
seleccionada (incluidas las celdas de tablas: "fila / columna = valor") se añaden al prompt en <grafo>, cada una
con el [n] de su chunk, ordenadas por pertinencia a la pregunta y acotadas por RAG_GRAPH_CONTEXT_TOKENS. Las semillas
del grafo usan además el vector de la consulta sobre embeddings de entidades y relaciones.

Registros públicos (ADR-036): si la API lo permite en el token (`pub`), en paralelo con la recuperación interna se
planifican consultas a Croma SOLO a partir de la pregunta (nunca de la evidencia interna) y sus resultados entran como
evidencia adicional, numerada después de la interna, con el mismo verificador de citas. Sin evidencia interna pero con
evidencia pública ya no hay abstención.
"""

from __future__ import annotations

import contextvars
import hashlib
import json
import logging
import secrets
import time
import uuid
from concurrent.futures import Future, ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from dataclasses import dataclass, field, replace
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

from .documents.compose import (
    DOCUMENT_SYSTEM_PROMPT,
    chat_message,
    extractive_document,
    render_document_prompt,
    verify_markdown,
)
from .documents.intent import FORMATS, DocumentRequest
from .documents.intent import resolve as resolve_document
from .documents.model import Table as MdTable
from .documents.model import build_document, outline, slug, word_count
from .prompting import ABSTAIN_TEXT, SYSTEM_PROMPT, classify, modality_preference, render_prompt
from .public_sources import COUNTRY_NAMES, ExternalItem, PublicClaim, PublicOutcome, build_client, run_lookup
from .public_sources.client import LookupClient
from .retrieval import Candidate, expand_parents, graph_bridges, graph_facts, graph_search, hybrid_search
from .smalltalk import SmallTalk
from .smalltalk import detect as detect_smalltalk
from .verifier import verify

logger = logging.getLogger("ragsis.rag")

CANDIDATE_K = 30
MAX_EVIDENCE = 8
MIN_LEXICAL_COVERAGE = 0.4
# Los primeros puestos de la búsqueda léxica o del grafo entran con algo menos de cobertura: una pregunta con palabras
# que el documento no repite (p. ej. "C-217 de 2026" en la página de firmas) los dejaba fuera por centésimas aunque
# fueran el mejor resultado. El LLM y el verificador de citas siguen filtrando lo que no responde.
TOP_RANK = 3
TOP_RANK_MIN_COVERAGE = 0.3
SNIPPET_CHARS = 320
MAX_HOP_EVIDENCE = 2
PLANNER_MAX_TOKENS = 300
# Consultas a registros públicos en paralelo con la recuperación interna (ADR-036).
_PUBLIC_POOL = ThreadPoolExecutor(max_workers=8, thread_name_prefix="public-lookup")


@dataclass
class QueryOptions:
    as_of: date | None = None
    top_k: int = MAX_EVIDENCE
    max_output_tokens: int = 800
    graph_mode: str = "auto"      # auto | off | local | global | hybrid
    # ADR-034: "answer" (respuesta de chat), "auto" (detecta si se pide un archivo) o un formato (pdf, docx, pptx,
    # csv, md) que fuerza un documento generado.
    output: str = "answer"


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
    # ADR-034: documento generado (Markdown verificado + metadatos); None en una respuesta normal.
    document: dict | None = None
    # ADR-036: resumen de los registros públicos consultados; None si la pregunta no los pidió.
    public_sources: dict | None = None


DOCUMENT_ABSTAIN_TEXT = ("I couldn't find enough evidence in the authorized documents to create that file. "
                         "Try naming the topic with the words your documents use.")


def _top_ranked(c: Candidate) -> bool:
    return any(r is not None and r <= TOP_RANK for r in (c.lex_rank, c.graph_local_rank))


class QueryOrchestrator:
    def __init__(self, gateway: AIGateway | None = None, pool=None, s3=None,
                 lookup_client: LookupClient | None = None) -> None:
        self.pool = pool
        self.gateway = gateway or AIGateway()
        self._s3 = s3
        self._lookup_client = lookup_client

    @property
    def s3(self):
        return self._s3 if self._s3 is not None else s3_client()

    def run(self, claims: InternalClaims, question: str, options: QueryOptions | None = None) -> QueryResult:
        opts = options or QueryOptions()
        t_start = time.perf_counter()
        timings: dict[str, int] = {}
        trace_id = "qry_" + secrets.token_hex(12)
        chat = detect_smalltalk(question)
        if chat:
            return self._small_talk(claims, question, chat, trace_id, t_start)
        policy = TenantAIPolicy(data_class=DataClass(claims.data_class), model_allowlist=claims.model_allowlist,
                                max_output_tokens=1200)
        doc_request = resolve_document(opts.output, question)
        qclass = "document" if doc_request else classify(question)
        calls_before = len(self.gateway.calls)
        info: dict = {"document_request": doc_request}
        if claims.public_sources:
            info["public_future"] = self._start_public(claims, doc_request.topic if doc_request else question, policy)

        with stage("rag.query", None, **{"ragsis.org_id": str(claims.organization_id),
                                         "ragsis.workspace_id": str(claims.workspace_id),
                                         "ragsis.user_id": str(claims.user_id), "ragsis.query_trace_id": trace_id,
                                         "ragsis.question_class": qclass}) as root:
            abstain_reason, answer, cited_ns, gen_model, selected, cands, strategy, emb = self._pipeline(
                claims, question, opts, policy, qclass, timings, info)
            public: PublicOutcome | None = info.get("public")
            root.set_attributes({"ragsis.candidates": len(cands), "ragsis.evidence": len(selected),
                                 "ragsis.public_lookups": public.lookups if public else 0,
                                 "ragsis.cited": len(cited_ns), "ragsis.abstained": abstain_reason is not None,
                                 "ragsis.strategy": strategy, "gen_ai.request.model": gen_model or "none",
                                 "ragsis.embedding_model": emb.model_id})
        abstained = abstain_reason is not None
        if abstained:
            answer = DOCUMENT_ABSTAIN_TEXT if doc_request else ABSTAIN_TEXT
        by_n = {i + 1: c for i, c in enumerate(selected)}
        external: list[ExternalItem] = info.get("external", [])
        ext_by_n = {len(selected) + j + 1: item for j, item in enumerate(external)}
        citations = [self._citation(n, by_n[n]) if n in by_n else self._external_citation(n, ext_by_n[n])
                     for n in (sorted(cited_ns) if doc_request else cited_ns) if n in by_n or n in ext_by_n]
        document = None
        if doc_request and not abstained:
            document = self._document(doc_request, info["document_markdown"], citations)
            count = {"pptx": document["slides"], "xlsx": document["rows"], "csv": document["rows"]}.get(
                doc_request.format, document["sections"])
            answer = chat_message(document["title"], doc_request, count, document["documents"], question)

        new_calls = self.gateway.calls[calls_before:]
        usage = {
            "embedding_tokens": sum(c.input_tokens for c in new_calls if c.kind == "embed"),
            "llm_input_tokens": sum(c.input_tokens for c in new_calls if c.kind == "generate"),
            "llm_output_tokens": sum(c.output_tokens for c in new_calls if c.kind == "generate"),
            "rerank_calls": sum(1 for c in new_calls if c.kind == "rerank"),
            "vision_images": info.get("vision_images", 0),
            "public_lookups": public.lookups if public else 0,
            "public_credits": public.credits if public else 0,
        }
        cost = sum(self.gateway.registry.estimate_cost(c.model_id, c.input_tokens, c.output_tokens) for c in new_calls)
        latency = int((time.perf_counter() - t_start) * 1000)
        result = QueryResult(trace_id, answer, abstained, abstain_reason, citations, strategy, qclass, gen_model,
                             emb.model_id, latency, timings, usage, document,
                             public.summary() if public else None)
        with stage("rag.persist"):
            self._persist(claims, question, result, cands, cost, public_refs=public.refs if public else ())
        log(logger, logging.INFO, "query.completed", trace_id=trace_id, org=str(claims.organization_id),
            abstained=abstained, latency_ms=latency, candidates=len(cands), cited=len(citations), strategy=strategy)
        return result

    def _small_talk(self, claims: InternalClaims, question: str, chat: SmallTalk, trace_id: str,
                    t_start: float) -> QueryResult:
        """Saludos y cortesías: texto fijo, sin recuperar ni llamar al modelo. Va como `abstained` (no hay respuesta
        documental que agentes y workflows puedan usar) con motivo `smalltalk`, y no cuenta contra la cuota mensual."""
        usage = {"embedding_tokens": 0, "llm_input_tokens": 0, "llm_output_tokens": 0, "rerank_calls": 0,
                 "vision_images": 0, "public_lookups": 0, "public_credits": 0}
        latency = int((time.perf_counter() - t_start) * 1000)
        result = QueryResult(trace_id, chat.message, True, "smalltalk", [], "smalltalk", "smalltalk", None,
                             self.gateway.embedding_model().model_id, latency, {}, usage)
        with stage("rag.persist"):
            self._persist(claims, question, result, [], 0.0, billable=False)
        log(logger, logging.INFO, "query.completed", trace_id=trace_id, org=str(claims.organization_id),
            abstained=True, latency_ms=latency, candidates=0, cited=0, strategy="smalltalk")
        return result

    def _pipeline(self, claims: InternalClaims, question: str, opts: QueryOptions, policy: TenantAIPolicy,
                  qclass: str, timings: dict, info: dict):
        doc_request: DocumentRequest | None = info.get("document_request")
        prompt_question = question
        # Un pedido de archivo se busca por su tema: «hazme una presentación en PowerPoint» no está en los documentos.
        question = doc_request.topic if doc_request else question
        # 1) embedding de la consulta (mismo modelo/versión que el índice activo)
        with stage("rag.embed", timings):
            emb = self.gateway.embed([question], policy, input_type="query")
            embed_model = self.gateway.embedding_model()

        ctx = claims.security_context()
        graph_mode = self._graph_mode(claims, opts)
        prefer = modality_preference(question)
        scope = {"organization_id": claims.organization_id, "workspace_id": claims.workspace_id,
                 "principals": list(claims.principals)}
        with tenant_tx(ctx, self.pool) as conn:
            # 2a) grafo (RAG-05): solo procedencia visible para el usuario
            graph = {}
            if graph_mode != "off":
                with stage("rag.graph", timings, **{"ragsis.graph_mode": graph_mode}) as span:
                    graph = graph_search(conn, **scope, question=question, mode=graph_mode, k=CANDIDATE_K,
                                         query_vector=emb.vectors[0], model_version=emb.model_id,
                                         min_similarity=embed_model.abstain_similarity)
                    span.set_attribute("ragsis.graph_chunks", len(graph))
            # 2b) retrieval híbrido con filtros de seguridad que el texto del usuario no puede alterar
            with stage("rag.retrieve", timings, **{"ragsis.candidate_k": CANDIDATE_K}):
                cands = hybrid_search(conn, **scope, question=question, query_vector=emb.vectors[0],
                                      model_version=emb.model_id, k=CANDIDATE_K, as_of=opts.as_of, graph=graph,
                                      prefer_kinds=prefer)

            # 3) umbral de evidencia: coincidencia de un solo término no basta; se exige cobertura lexical
            # mínima de la pregunta o similitud semántica sobre el umbral calibrado del modelo.
            for c in cands:
                c.extra["lex_cov"] = lexical_score(question, f"{c.section_path} {c.text}")
            strong = [c for c in cands if c.extra["lex_cov"] >= MIN_LEXICAL_COVERAGE
                      or (c.similarity or 0) >= embed_model.abstain_similarity
                      or (c.extra["lex_cov"] >= TOP_RANK_MIN_COVERAGE and _top_ranked(c))]
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
            strong = self._reserve_modality(strong, prefer, max_items - len(hops))
            selected = self._fit_context(strong, claims.max_context_tokens, max_items - len(hops))
            if selected and hops:
                used = sum(c.token_count + 40 for c in selected)
                selected += self._fit_context(hops, claims.max_context_tokens - used, len(hops))
            if graph_mode != "off":
                strategy += f"+graph_{graph_mode}"
            expand_parents(conn, selected)
            facts = self._graph_facts(conn, scope, question, selected) if graph_mode != "off" else []

        external = self._collect_public(info, timings)
        info["external"] = external
        if external:
            strategy += "+public"

        abstain_reason = None
        answer = ""
        hints = hints if selected else ()
        cited_ns: list[int] = []
        gen_model = None
        if not selected and not external:
            abstain_reason = "insufficient_evidence"
        elif doc_request:
            abstain_reason, cited_ns, gen_model = self._compose(prompt_question, question, doc_request, selected,
                                                                external, facts, hints, policy, timings, info)
        else:
            evidence, meta = self._evidence_and_meta(selected, external)
            images = self._figure_images(claims, selected, policy, timings)
            prompt = render_prompt(question, evidence, meta, qclass, len(images), facts)
            info["graph_facts"] = len(facts)
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
    def _compose(self, prompt_question: str, topic: str, request: DocumentRequest, selected: list[Candidate],
                 external: list[ExternalItem], facts: list[tuple[int, str]], hints: tuple[str, ...],
                 policy: TenantAIPolicy, timings: dict, info: dict) -> tuple[str | None, list[int], str | None]:
        """Documento generado (ADR-034): misma evidencia autorizada, prompt de documento, verificación por bloque."""
        hints = tuple(dict.fromkeys([*hints, *(b for c in selected for b in c.bridges)]))
        evidence, meta = self._evidence_and_meta(selected, external)
        prompt = render_document_prompt(prompt_question, request, evidence, meta, facts)
        info["graph_facts"] = len(facts)
        max_out = get_settings().rag_document_max_output_tokens
        with stage("rag.generate", timings, **{"ragsis.document_format": request.format}) as span:
            gen = self.gateway.generate(GenerationRequest(DOCUMENT_SYSTEM_PROMPT, prompt, topic, tuple(evidence),
                                                          max_out, (), hints),
                                        replace(policy, max_output_tokens=max_out))
            span.set_attributes({"gen_ai.request.model": gen.model_id, "gen_ai.usage.input_tokens": gen.input_tokens,
                                 "gen_ai.usage.output_tokens": gen.output_tokens})
        with stage("rag.verify", timings) as span:
            source = gen.text
            if self.gateway.registry.get(gen.model_id).provider == "local":
                # Sin modelo generativo (o tras su fallback local): documento con oraciones literales de la evidencia.
                source = extractive_document(prompt_question, request, evidence)
            composed = verify_markdown(source, evidence)
            span.set_attributes({"ragsis.citations_valid": len(composed.cited),
                                 "ragsis.sentences_dropped": composed.dropped})
        if composed.abstained:
            return composed.reason, [], gen.model_id
        info["document_markdown"] = composed.markdown
        return None, composed.cited, gen.model_id

    @staticmethod
    def _document(request: DocumentRequest, markdown: str, citations: list[dict]) -> dict:
        built = build_document(markdown, citations, kind=request.kind, fallback_title=request.topic[:120])
        sections = outline(built)
        slides = 0
        if request.format == "pptx":
            from .documents.render.pptx import plan_slides
            slides = plan_slides(built)
        rows = sum(len(b.rows) for b in built.blocks if isinstance(b, MdTable))
        used = {s.n for s in built.sources}
        documents = len({c.get("document_id") or c.get("title") for c in citations if c.get("n") in used})
        return {
            "id": str(uuid.uuid4()),
            "title": built.title,
            "format": request.format,
            "kind": request.kind,
            "filename": f"{slug(built.title)}.{request.format}",
            "markdown": markdown,
            "outline": sections,
            "sections": len(sections),
            "words": word_count(built),
            "sources": len(built.sources),
            "documents": documents,
            "slides": slides,
            "rows": rows,
            "formats": list(FORMATS),
        }

    # ------------------------------------------------------------------ registros públicos (ADR-036)
    def _start_public(self, claims: InternalClaims, question: str, policy: TenantAIPolicy) -> Future:
        """Planifica y ejecuta las consultas públicas en otro hilo. El planificador solo ve la pregunta."""
        raw = claims.public_sources or {}
        claim = PublicClaim(country=raw.get("country"), web=bool(raw.get("web")),
                            max_calls=int(raw.get("max_calls", 0)), override=raw.get("override"))
        client = self._lookup_client if self._lookup_client is not None else build_client()

        def generate(system: str, prompt: str) -> tuple[str, bool]:
            model = self.gateway.registry.get(get_settings().ai_generation_model)
            if model.provider == "local":
                return "", True
            res = self.gateway.generate(GenerationRequest(system, prompt, question, (), PLANNER_MAX_TOKENS),
                                        replace(policy, max_output_tokens=max(policy.max_output_tokens,
                                                                              PLANNER_MAX_TOKENS)))
            return res.text, self.gateway.registry.get(res.model_id).provider == "local"

        def work() -> PublicOutcome:
            with stage("rag.public_lookup"):
                return run_lookup(question, claim, generate, client)

        return _PUBLIC_POOL.submit(contextvars.copy_context().run, work)

    @staticmethod
    def _collect_public(info: dict, timings: dict) -> list[ExternalItem]:
        future: Future | None = info.get("public_future")
        if future is None:
            return []
        t0 = time.perf_counter()
        try:
            outcome = future.result(timeout=get_settings().croma_timeout_seconds + 20)
        except FutureTimeout:
            outcome = PublicOutcome(unavailable="timeout")
        except Exception:  # noqa: BLE001 — una falla externa nunca le cuesta la respuesta documental al usuario
            logger.exception("public lookup crashed")
            outcome = PublicOutcome(unavailable="unavailable")
        timings["public_wait_ms"] = int((time.perf_counter() - t0) * 1000)
        info["public"] = outcome
        return outcome.items

    def _evidence_and_meta(self, selected: list[Candidate],
                           external: list[ExternalItem]) -> tuple[list[Evidence], list[dict]]:
        evidence = [Evidence(i + 1, self._evidence_text(c), c.title, c.page) for i, c in enumerate(selected)]
        meta = [{"version_no": c.version_no, "effective_from": c.effective_from, "kind": c.kind} for c in selected]
        base = len(selected)
        for j, item in enumerate(external):
            evidence.append(Evidence(base + j + 1, item.text, item.title, None))
            meta.append({"external": True, "kind": item.kind, "retrieved": item.retrieved, "as_of": item.as_of,
                         "version_no": None, "effective_from": None})
        return evidence, meta

    @staticmethod
    def _external_citation(n: int, item: ExternalItem) -> dict:
        return {
            "n": n,
            "external": True,
            "kind": item.kind,                 # public_record | web
            "title": item.title,
            "source": item.source,
            "country": item.country,
            "country_name": COUNTRY_NAMES.get(item.country, item.country),
            "url": item.url,
            "snippet": item.snippet,
            "as_of": item.as_of,
            "retrieved_at": item.retrieved,
            "no_match": item.no_match,
            "demo": item.demo,
            "provider": "croma",
            # Campos de documento vacíos: el historial y los documentos generados los distinguen por `external`.
            "document_id": None, "version_id": None, "version_no": None, "chunk_id": None, "filename": None,
            "section": None, "page": None, "effective_from": None, "has_asset": False, "ai_generated": False,
        }

    @staticmethod
    def _graph_mode(claims: InternalClaims, opts: QueryOptions) -> str:
        """El tenant decide si hay grafo (claim firmado por la API); el cliente solo elige el modo."""
        if not claims.graph_enabled or opts.graph_mode == "off":
            return "off"
        return "hybrid" if opts.graph_mode == "auto" else opts.graph_mode

    @staticmethod
    def _graph_facts(conn, scope: dict, question: str, selected: list[Candidate]) -> list[tuple[int, str]]:
        """Entidades/relaciones de la evidencia seleccionada para el prompt: [(n, texto)], las más pertinentes a la
        pregunta primero, sin las que no comparten ningún término con ella y dentro del presupuesto de tokens."""
        budget = get_settings().rag_graph_context_tokens
        if budget <= 0 or not selected:
            return []
        n_of = {c.chunk_id: i + 1 for i, c in enumerate(selected)}
        scored = []
        for f in graph_facts(conn, **scope, chunk_ids=list(n_of)):
            score = lexical_score(question, f["text"])
            if score > 0:
                scored.append((score, n_of[f["chunk_id"]], f["text"][:400]))
        scored.sort(key=lambda x: (-x[0], x[1], x[2]))
        out, used, seen = [], 0, set()
        for _, n, text in scored:
            cost = estimate_tokens(text) + 8
            if (n, text) in seen or used + cost > budget:
                continue
            seen.add((n, text))
            out.append((n, text))
            used += cost
        return out

    @staticmethod
    def _reserve_modality(strong: list[Candidate], prefer: tuple[str, ...], slots: int) -> list[Candidate]:
        """Si la pregunta pide una modalidad y ningún chunk de ese tipo entra en el corte, el mejor de ellos (ya
        sobre el umbral de evidencia) pasa al último puesto. No añade candidatos ni cambia el resto del orden."""
        if not prefer or slots < 1 or len(strong) <= slots or any(c.kind in prefer for c in strong[:slots]):
            return strong
        i = next((j for j, c in enumerate(strong) if c.kind in prefer), None)
        if i is None:
            return strong
        out = list(strong)
        out.insert(slots - 1, out.pop(i))
        return out

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
        label = {"figure": "[Figura]", "table": "[Tabla]", "equation": "[Ecuación]", "audio": "[Audio]"}.get(c.kind)
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
            # Audio (ADR-030): rango en segundos del tramo citado, para reproducir desde ahí.
            "t_start": (c.meta or {}).get("t_start") if c.kind == "audio" else None,
            "t_end": (c.meta or {}).get("t_end") if c.kind == "audio" else None,
            # La evidencia incluye texto generado por IA (descripción de figura o resumen de tabla).
            "ai_generated": (c.meta or {}).get("description_source") == "vlm" or "summary" in (c.meta or {})
            or "analysis" in (c.meta or {}),
        }

    def _persist(self, claims: InternalClaims, question: str, r: QueryResult, cands: list[Candidate],
                 cost: float, billable: bool = True, public_refs=()) -> None:
        refs = [{"chunk_id": str(c.chunk_id), "rrf": round(c.rrf, 6), "sim": round(c.similarity or 0, 4),
                 "lex_rank": c.lex_rank, "rerank": c.rerank, "graph_local_rank": c.graph_local_rank,
                 "graph_global_rank": c.graph_global_rank, "hop": bool(c.extra.get("hop")),
                 "kind": c.kind, "modality": bool(c.extra.get("modality"))}
                for c in cands[:CANDIDATE_K]]
        # ADR-036: qué consultas públicas se hicieron y con qué resultado; nunca los parámetros (nombres, NIT…).
        refs += list(public_refs)
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
            if r.document:
                d = r.document
                execute(conn, """
                    INSERT INTO generated_documents (id, organization_id, user_id, workspace_id, query_run_id, title,
                      format, kind, markdown, citations)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb)""",
                        (d["id"], claims.organization_id, claims.user_id, claims.workspace_id, r.trace_id, d["title"],
                         d["format"], d["kind"], d["markdown"], json.dumps(r.citations)))
            for cit in r.citations:
                if cit.get("external"):
                    continue
                execute(conn, "INSERT INTO citations (query_run_id, organization_id, ordinal, chunk_id, document_id, "
                              "version_id, page) VALUES (%s,%s,%s,%s,%s,%s,%s)",
                        (r.trace_id, claims.organization_id, cit["n"], cit["chunk_id"], cit["document_id"],
                         cit["version_id"], cit["page"]))
            for kind in ("embedding_tokens", "llm_input_tokens", "llm_output_tokens", "rerank_calls", "vision_images",
                         "public_lookups"):
                if r.usage[kind]:
                    execute(conn, "INSERT INTO usage_events (organization_id, kind, quantity, ref) VALUES (%s,%s,%s,%s)",
                            (claims.organization_id, kind, r.usage[kind], r.trace_id))
            if billable:
                execute(conn, "INSERT INTO usage_events (organization_id, kind, quantity, ref) VALUES (%s,'query',1,%s)",
                        (claims.organization_id, r.trace_id))


def estimate_question_tokens(q: str) -> int:
    return estimate_tokens(q)
