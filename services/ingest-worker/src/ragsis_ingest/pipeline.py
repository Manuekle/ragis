"""Pipeline de ingesta: uploaded → quarantined → validated → parsing → enriched → embedding → indexed.

`enriched` incluye OCR (Textract) y enriquecimiento multimodal (RAG-04): figuras descritas por VLM y
guardadas como activos derivados en S3, captions, tablas (incluidos gráficos nativos) y ecuaciones.

Idempotente por job: un mensaje repetido de SQS no re-indexa una versión ya procesada.
Errores definitivos (validación, política, límites) no se reintentan; los transitorios
vuelven a SQS y, tras maxReceiveCount, terminan en la DLQ.

Jobs soportados:
  ingest   indexa una versión nueva y la activa con swap atómico (supersede la anterior).
  delete   purga chunks, embeddings y objetos S3 de un documento marcado como borrado.
  reindex  sobre la versión vigente, sin interrumpir consultas:
             mode=embeddings  dual-write: agrega vectores de otro modelo a los chunks activos.
             mode=full        re-parsea/re-chunkea y reemplaza los chunks en una sola transacción.
             mode=graph       (RAG-05) extrae entidades/relaciones de los chunks activos sin tocarlos
                              (backfill al habilitar el grafo en un tenant).

Grafo (RAG-05): si el tenant tiene el grafo habilitado (plan u organización), tras el chunking se extraen
entidades/relaciones por chunk con AI_GRAPH_MODEL y se guardan con procedencia por chunk (ADR-019). Figuras, tablas
y ecuaciones aportan además su nodo ancla y relaciones `pertenece_a` (grafo cross-modal, ADR-029).
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
import uuid
from dataclasses import dataclass, field

import psycopg
from botocore.exceptions import BotoCoreError, ClientError
from ragsis_ai.gateway import AIGateway
from ragsis_ai.policy import PolicyViolation, is_allowed, require_allowed
from ragsis_ai.providers.base import ProviderError
from ragsis_ai.registry import ModelSpec
from ragsis_ai.types import DataClass, TenantAIPolicy
from ragsis_core.aws import s3_client
from ragsis_core.db import SecurityContext, execute, fetch_all, fetch_one, tenant_tx
from ragsis_core.logging import log
from ragsis_core.settings import get_settings
from ragsis_core.telemetry import remote_parent, stage

from .chunker import Chunk, Chunker
from .enrich import detect_pii
from .graph import BELONGS_KEYWORDS, ChunkGraph, GraphExtractor, GraphStats
from .multimodal import MultimodalEnricher, MultimodalStats
from .ocr import OcrProvider, OcrResult, OcrUnavailable, get_ocr_provider
from .parsers.model import Block, ParsedDocument
from .parsers.pdf import PageLimitExceeded
from .parsers.selector import parse
from .parsers.text import parse_lines
from .scanner import ScannerUnavailable, scan
from .transcription import (
    AUDIO_FORMATS,
    Transcript,
    TranscriptionProvider,
    TranscriptionUnavailable,
    get_transcription_provider,
    transcript_document,
)
from .validation import FileInfo, ValidationError, validate

logger = logging.getLogger("ragsis.ingest")

MAX_RECEIVES = 4
EMBED_BATCH = 32
JOB_KINDS = ("ingest", "delete", "reindex")


class PermanentError(Exception):
    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(f"{code}: {detail}")
        self.code = code
        self.detail = detail


class TransientError(Exception):
    pass


@dataclass(frozen=True)
class JobMessage:
    kind: str
    organization_id: uuid.UUID
    document_id: uuid.UUID
    version_id: uuid.UUID | None
    job_id: uuid.UUID
    traceparent: str | None = None

    @classmethod
    def parse(cls, body: str) -> JobMessage:
        try:
            d = json.loads(body)
            if d.get("v") != 1 or d["kind"] not in JOB_KINDS:
                raise ValueError("versión/tipo de mensaje no soportado")
            return cls(d["kind"], uuid.UUID(d["organization_id"]), uuid.UUID(d["document_id"]),
                       uuid.UUID(d["version_id"]) if d.get("version_id") else None, uuid.UUID(d["job_id"]),
                       d.get("traceparent") if isinstance(d.get("traceparent"), str) else None)
        except (ValueError, KeyError, TypeError) as exc:
            raise PermanentError("bad_message", str(exc)) from exc

    def body(self) -> str:
        return json.dumps({"v": 1, "kind": self.kind, "organization_id": str(self.organization_id),
                           "document_id": str(self.document_id),
                           "version_id": str(self.version_id) if self.version_id else None, "job_id": str(self.job_id)})


@dataclass
class Extraction:
    info: FileInfo
    checksum: str
    parsed: ParsedDocument
    chunks: list[Chunk]
    pii: list[list[str]]
    ocr: OcrResult | None = None
    mm: MultimodalStats = field(default_factory=MultimodalStats)
    timings: dict = field(default_factory=dict)
    graph: dict[int, ChunkGraph] = field(default_factory=dict)
    graph_stats: GraphStats | None = None
    audio: Transcript | None = None


def _audit(conn: psycopg.Connection, org: uuid.UUID, action: str, resource: str, decision: str, meta: dict) -> None:
    execute(conn, "INSERT INTO audit_events (organization_id, actor_id, action, resource, decision, metadata) "
                  "VALUES (%s, NULL, %s, %s, %s, %s::jsonb)", (org, action, resource, decision, json.dumps(meta)))


def _usage(conn: psycopg.Connection, org: uuid.UUID, kind: str, qty: float, ref: str) -> None:
    if qty:
        execute(conn, "INSERT INTO usage_events (organization_id, kind, quantity, ref) VALUES (%s, %s, %s, %s)",
                (org, kind, qty, ref))


_VERSION_SQL = """
    SELECT v.*, d.workspace_id, d.status AS doc_status, d.title AS doc_title, o.data_class, o.region_policy, o.model_allowlist,
           p.max_pages_per_doc, p.max_upload_bytes,
           CASE o.graph_mode WHEN 'on' THEN true WHEN 'off' THEN false ELSE p.graph_enabled END AS graph_enabled
      FROM document_versions v
      JOIN documents d ON d.id = v.document_id
      JOIN organizations o ON o.id = v.organization_id
      JOIN plans p ON p.id = o.plan_id
     WHERE v.id = %s AND v.document_id = %s"""


class IngestPipeline:
    def __init__(self, gateway: AIGateway | None = None, chunker: Chunker | None = None, pool=None,
                 ocr: OcrProvider | None = None, multimodal: MultimodalEnricher | None = None,
                 graph: GraphExtractor | None = None, transcriber: TranscriptionProvider | None = None) -> None:
        self.pool = pool
        self.gateway = gateway or AIGateway()
        self.chunker = chunker or Chunker()
        self.settings = get_settings()
        self._ocr = ocr
        self._transcriber = transcriber
        self.multimodal = multimodal or MultimodalEnricher(self.gateway, self.settings)
        self.graph = graph or GraphExtractor(self.gateway, self.settings)

    @property
    def ocr(self) -> OcrProvider | None:
        return self._ocr if self._ocr is not None else get_ocr_provider()

    @property
    def transcriber(self) -> TranscriptionProvider | None:
        return self._transcriber if self._transcriber is not None else get_transcription_provider()

    # ------------------------------------------------------------------ entrada
    def handle(self, msg: JobMessage, receive_count: int = 1) -> str:
        with remote_parent({"traceparent": msg.traceparent} if msg.traceparent else None), \
                stage(f"ingest.{msg.kind}", None, **{"ragsis.org_id": str(msg.organization_id),
                                                     "ragsis.job_id": str(msg.job_id),
                                                     "ragsis.receive_count": receive_count}) as span:
            result = self._handle(msg, receive_count)
            span.set_attribute("ragsis.result", result)
            return result

    def _handle(self, msg: JobMessage, receive_count: int) -> str:
        ctx = SecurityContext(msg.organization_id)
        try:
            if msg.kind == "ingest":
                return self._ingest(ctx, msg)
            if msg.kind == "reindex":
                return self._reindex(ctx, msg)
            return self._delete(ctx, msg)
        except (ValidationError, PageLimitExceeded, PolicyViolation, PermanentError) as exc:
            code = getattr(exc, "code", None) or (
                "page_limit" if isinstance(exc, PageLimitExceeded) else "model_policy_violation")
            self._fail(ctx, msg, code, str(exc)[:500], terminal_state="failed",
                       version_status="rejected" if isinstance(exc, ValidationError) else "failed")
            return f"failed:{code}"
        except (ProviderError, ScannerUnavailable, OcrUnavailable, TranscriptionUnavailable, ClientError, BotoCoreError,
                psycopg.OperationalError, TransientError) as exc:
            if receive_count >= MAX_RECEIVES:
                self._fail(ctx, msg, "dead_letter", f"{type(exc).__name__}: {str(exc)[:400]}",
                           terminal_state="dead", version_status="failed")
                raise TransientError(str(exc)) from exc
            self._mark_retry(ctx, msg, f"{type(exc).__name__}: {str(exc)[:400]}")
            raise TransientError(str(exc)) from exc

    # ------------------------------------------------------------------ etapas comunes
    @staticmethod
    def _policy(ver: dict) -> TenantAIPolicy:
        return TenantAIPolicy(data_class=DataClass(ver["data_class"]),
                              model_allowlist=tuple(ver["model_allowlist"] or ()),
                              approved_regions=(ver["region_policy"],))

    def _extract(self, ctx: SecurityContext, ver: dict, policy: TenantAIPolicy, on_status=None,
                 known_descriptions: dict[str, tuple] | None = None) -> Extraction:
        """Descarga → validación → antimalware → parsing (+OCR) → multimodal → chunking → PII."""
        status = on_status or (lambda *_a, **_k: None)
        if not ver["s3_key"].startswith(f"tenants/{ctx.organization_id}/"):
            raise PermanentError("storage_key_outside_tenant", ver["s3_key"])
        data = self._download(ver["s3_key"], int(ver["max_upload_bytes"]))
        checksum = hashlib.sha256(data).hexdigest()
        info = validate(data, ver["filename"], ver["content_type"], int(ver["declared_size"]),
                        int(ver["max_upload_bytes"]))
        scan(data)
        status("validated", size_bytes=info.size, checksum_sha256=checksum)
        status("parsing")
        audio = None
        if info.kind == "audio":
            del data
            audio = self._transcribe(ctx, ver, policy, info.audio_format)
            parsed = transcript_document(audio)
        else:
            parsed = parse(data, info.kind, int(ver["max_pages_per_doc"]))
            del data
        ocr_result = None
        if info.kind in ("pdf", "image") and parsed.low_text_pages:
            ocr_result = self._apply_ocr(parsed, ver, policy, info.kind)
        mm = self.multimodal.enrich(parsed, org=ctx.organization_id, document_id=ver["document_id"],
                                    version_id=ver["id"], policy=policy,
                                    title=ver.get("doc_title") or ver["filename"], known=known_descriptions)
        chunks = self.chunker.chunk(parsed.blocks)
        if not chunks:
            if audio is not None:
                raise PermanentError("no_speech_detected", "la grabación no tiene voz reconocible")
            raise PermanentError("no_extractable_text", "; ".join(parsed.warnings) or "documento sin texto")
        return Extraction(info, checksum, parsed, chunks, [detect_pii(c.text) for c in chunks], ocr_result, mm,
                          audio=audio)

    def _transcribe(self, ctx: SecurityContext, ver: dict, policy: TenantAIPolicy, audio_format: str | None) -> Transcript:
        """Voz → texto con tiempos (ADR-030). Reutiliza la transcripción ya pagada de esta versión si existe."""
        bucket = self.settings.s3_bucket
        prefix = f"tenants/{ctx.organization_id}/assets/{ver['document_id']}/{ver['id']}/"
        saved = f"{prefix}transcript.json"
        s3 = s3_client()
        try:
            tr = Transcript.from_json(s3.get_object(Bucket=bucket, Key=saved)["Body"].read())
            tr.reused = True
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") not in ("NoSuchKey", "404"):
                raise
            tr = None
        except (ValueError, KeyError, TypeError):
            tr = None           # transcripción guardada ilegible: se vuelve a transcribir
        if tr is None:
            provider = self.transcriber
            if provider is None:
                raise PermanentError("transcription_required",
                                     "audio y transcripción no habilitada (TRANSCRIPTION_PROVIDER)")
            # El audio sale a un servicio cloud: la clasificación del tenant decide si puede usarse.
            require_allowed(self.gateway.registry.get(provider.model_id), policy)
            with stage("ingest.transcribe", None, **{"ragsis.audio_format": audio_format or ""}) as span:
                tr = provider.transcribe(bucket, ver["s3_key"], AUDIO_FORMATS[audio_format or "mp3"], prefix)
                span.set_attributes({"ragsis.audio_seconds": tr.duration, "ragsis.audio_segments": len(tr.segments)})
            s3.put_object(Bucket=bucket, Key=saved, Body=tr.to_json().encode("utf-8"), ContentType="application/json")
        if tr.duration > self.settings.audio_max_seconds:
            raise PermanentError("audio_too_long", f"{int(tr.duration)} s > {self.settings.audio_max_seconds} s")
        return tr

    def _apply_ocr(self, parsed: ParsedDocument, ver: dict, policy: TenantAIPolicy, kind: str = "pdf") -> OcrResult | None:
        heavy = any(w.startswith("ocr_required") for w in parsed.warnings)
        provider = self.ocr
        if provider is None:
            if heavy:
                raise PermanentError("ocr_required", "PDF escaneado y OCR no habilitado (OCR_PROVIDER)")
            return None
        # Textract es un servicio cloud: la clasificación del tenant decide si puede usarse.
        ocr_model = self.gateway.registry.get(provider.model_id)
        if kind == "image" and not is_allowed(ocr_model, policy)[0]:
            # Una imagen puede indexarse solo con la descripción de un VLM permitido (p. ej. local).
            parsed.warnings.append("ocr_skipped_policy: OCR cloud no permitido para el tenant")
            return None
        require_allowed(ocr_model, policy)
        result = provider.recognize(self.settings.s3_bucket, ver["s3_key"], parsed.low_text_pages)
        ocr_pages = set(result.pages)
        # El texto OCR reemplaza al texto digital de esas páginas; los elementos visuales se conservan.
        indexed: list[tuple[int, int, Block]] = [
            (b.page or 0, i, b) for i, b in enumerate(parsed.blocks)
            if (b.page or 0) not in ocr_pages or b.kind in ("figure", "table", "equation")
        ]
        base = len(parsed.blocks)
        for page, lines in result.pages.items():
            for j, b in enumerate(parse_lines(lines, page=page, markdown=False)):
                indexed.append((page, base + j, b))
            base += len(lines) + 1
        indexed.sort(key=lambda x: (x[0], x[1]))
        parsed.blocks = [b for _, _, b in indexed]
        parsed.parser = f"{parsed.parser}+ocr"
        unread = sorted(set(parsed.low_text_pages) - ocr_pages)
        if unread:
            parsed.warnings.append(f"ocr_low_confidence_pages: {unread[:20]}")
        return result

    def _embed(self, chunks: list[Chunk] | list[dict], policy: TenantAIPolicy,
               model: ModelSpec) -> tuple[list[list[float]], int]:
        vectors: list[list[float]] = []
        tokens = 0
        for i in range(0, len(chunks), EMBED_BATCH):
            batch = chunks[i:i + EMBED_BATCH]
            texts = []
            for c in batch:
                section, text = (c["section_path"], c["text"]) if isinstance(c, dict) else (c.section_path, c.text)
                texts.append(f"{section}\n{text}" if section else text)
            res = self.gateway.embed(texts, policy, input_type="document", model_id=model.model_id)
            vectors.extend(res.vectors)
            tokens += res.input_tokens
        return vectors, tokens

    @staticmethod
    def _insert_chunks(conn, ctx: SecurityContext, ver: dict, ex: Extraction, vectors: list[list[float]],
                       model: ModelSpec, state: str) -> list[uuid.UUID]:
        rows, emb_rows, ids = [], [], []
        for c, vec, flags in zip(ex.chunks, vectors, ex.pii, strict=True):
            cid = uuid.uuid4()
            ids.append(cid)
            rows.append((cid, ctx.organization_id, ver["workspace_id"], ver["document_id"], ver["id"], c.ordinal,
                         c.section_path, c.page_start, c.page_end, c.char_start, c.char_end, c.kind, c.text,
                         c.token_count, flags, state, list(c.bbox) if c.bbox else None, c.asset_key,
                         json.dumps(c.meta, ensure_ascii=False)))
            emb_rows.append((cid, ctx.organization_id, ver["document_id"], model.model_id, vec))
        with conn.cursor() as cur:
            cur.executemany(
                "INSERT INTO chunks (id, organization_id, workspace_id, document_id, version_id, ordinal, section_path,"
                " page_start, page_end, char_start, char_end, kind, text, token_count, pii_flags, index_state,"
                " bbox, asset_key, meta)"
                " VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb)", rows)
            cur.executemany(
                "INSERT INTO chunk_embeddings (chunk_id, organization_id, document_id, model_version, embedding)"
                " VALUES (%s,%s,%s,%s,%s)", emb_rows)
        return ids

    @staticmethod
    def _refresh_centroid(conn, document_id: uuid.UUID) -> None:
        """Vector resumen del documento (ADR-031): promedio de los vectores de sus chunks activos, por modelo.
        Lo usa la sugerencia de carpeta; se recalcula en la misma transacción que cambia los chunks."""
        execute(conn, "DELETE FROM document_centroids WHERE document_id = %s", (document_id,))
        execute(conn, """
            INSERT INTO document_centroids (document_id, organization_id, model_version, embedding, chunk_count)
            SELECT c.document_id, c.organization_id, e.model_version, avg(e.embedding), count(*)
              FROM chunks c JOIN chunk_embeddings e ON e.chunk_id = c.id
             WHERE c.document_id = %s AND c.index_state = 'active'
             GROUP BY c.document_id, c.organization_id, e.model_version""", (document_id,))

    # ------------------------------------------------------------------ grafo (RAG-05)
    @staticmethod
    def _graph_inputs(chunks: list[Chunk]) -> list[tuple]:
        return [(c.kind, c.text, {"caption": c.meta.get("caption"), "page": c.page_start, "ordinal": c.ordinal,
                                  "summary": c.meta.get("entity_summary") or c.meta.get("summary")})
                for c in chunks]

    # Texto que se embebe por fila de procedencia (ADR-029). Las relaciones `pertenece_a` son estructura repetitiva
    # sin contenido propio: se navegan, no se buscan por similitud.
    @staticmethod
    def _entity_text(name: str, etype: str, description: str) -> str:
        return f"{name} ({etype})\n{description}" if description else f"{name} ({etype})"

    @staticmethod
    def _relation_text(keywords: str, description: str) -> str:
        return f"{keywords}\n{description}" if description else keywords

    def _embed_texts(self, texts: list[str], policy: TenantAIPolicy, model: ModelSpec) -> tuple[dict[str, list[float]], int]:
        """Embebe textos únicos por lotes; devuelve {texto: vector} y tokens."""
        unique = list(dict.fromkeys(texts))
        out: dict[str, list[float]] = {}
        tokens = 0
        for i in range(0, len(unique), EMBED_BATCH):
            batch = unique[i:i + EMBED_BATCH]
            res = self.gateway.embed(batch, policy, input_type="document", model_id=model.model_id)
            out.update(zip(batch, res.vectors, strict=True))
            tokens += res.input_tokens
        return out, tokens

    def _embed_graph(self, graphs: dict[int, ChunkGraph], stats: GraphStats | None, policy: TenantAIPolicy,
                     model: ModelSpec) -> None:
        """Vectores de entidades y relaciones, en el mismo espacio que los chunks (tabla T del índice)."""
        if not graphs or stats is None:
            return
        texts = []
        for g in graphs.values():
            for e in g.entities:
                e["embed_text"] = self._entity_text(e["name"], e["type"], e["description"])
                texts.append(e["embed_text"])
            for r in g.relations:
                if r["keywords"] != BELONGS_KEYWORDS:
                    r["embed_text"] = self._relation_text(r["keywords"], r["description"])
                    texts.append(r["embed_text"])
        with stage("ingest.graph_embed", None, **{"ragsis.graph_texts": len(texts)}):
            vectors, tokens = self._embed_texts(texts, policy, model)
        for g in graphs.values():
            for x in (*g.entities, *g.relations):
                if "embed_text" in x:
                    x["vec"] = vectors[x.pop("embed_text")]
        stats.embedded = len(texts)
        stats.embedding_tokens = tokens

    def _extract_graph(self, ver: dict, policy: TenantAIPolicy, chunks: list[tuple]) -> tuple[
            dict[int, ChunkGraph], GraphStats | None]:
        if not ver.get("graph_enabled"):
            return {}, None
        with stage("ingest.graph", None, **{"ragsis.chunks": len(chunks)}) as span:
            graphs, stats = self.graph.extract(chunks, policy, ver.get("doc_title") or ver["filename"])
            span.set_attributes({"ragsis.graph_entities": stats.entities, "ragsis.graph_relations": stats.relations,
                                 "gen_ai.request.model": stats.model or "none"})
        for w in stats.warnings:
            log(logger, logging.WARNING, "graph.warning", version=str(ver["id"]), warning=w)
        return graphs, stats

    @staticmethod
    def _insert_graph(conn, ctx: SecurityContext, ver: dict, chunk_ids: list[uuid.UUID],
                      graphs: dict[int, ChunkGraph], model: ModelSpec | None = None) -> None:
        """Upsert de claves + procedencia por chunk. La clave no lleva datos propios (ver 0005_graphrag.sql)."""
        if not graphs:
            return
        org, ws, doc = ctx.organization_id, ver["workspace_id"], ver["document_id"]
        keys = sorted({e["key"] for g in graphs.values() for e in g.entities})
        # DO UPDATE (no-op) en lugar de DO NOTHING: devuelve el id y bloquea la fila frente al GC concurrente.
        ent = {r["normalized_name"]: r["id"] for r in fetch_all(conn, """
            INSERT INTO entities (organization_id, workspace_id, normalized_name)
            SELECT %s, %s, k FROM unnest(%s::text[]) AS k
            ON CONFLICT (organization_id, workspace_id, normalized_name)
            DO UPDATE SET normalized_name = EXCLUDED.normalized_name
            RETURNING id, normalized_name""", (org, ws, keys))}
        ent_rows, rel_src, ent_emb, rel_emb = [], [], [], []
        pairs: set[tuple[uuid.UUID, uuid.UUID]] = set()
        mv = model.model_id if model else None
        for i, g in graphs.items():
            cid = chunk_ids[i]
            for e in g.entities:
                ent_rows.append((ent[e["key"]], cid, org, doc, e["name"], e["type"], e["description"]))
                if mv and "vec" in e:
                    ent_emb.append((ent[e["key"]], cid, org, doc, mv, e["vec"]))
            for r in g.relations:
                pair = (ent[r["src_key"]], ent[r["dst_key"]])
                pairs.add(pair)
                rel_src.append((pair, cid, r["keywords"], r["description"], r["weight"]))
                if mv and "vec" in r:
                    rel_emb.append((pair, cid, mv, r["vec"]))
        with conn.cursor() as cur:
            cur.executemany("INSERT INTO entity_sources (entity_id, chunk_id, organization_id, document_id, name, type,"
                            " description) VALUES (%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING", ent_rows)
            cur.executemany("INSERT INTO entity_source_embeddings (entity_id, chunk_id, organization_id, document_id,"
                            " model_version, embedding) VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING", ent_emb)
        if not pairs:
            return
        src, dst = zip(*sorted(pairs), strict=True)
        rel = {(r["src_entity_id"], r["dst_entity_id"]): r["id"] for r in fetch_all(conn, """
            INSERT INTO relations (organization_id, workspace_id, src_entity_id, dst_entity_id)
            SELECT %s, %s, s, d FROM unnest(%s::uuid[], %s::uuid[]) AS t(s, d)
            ON CONFLICT (organization_id, workspace_id, src_entity_id, dst_entity_id)
            DO UPDATE SET src_entity_id = EXCLUDED.src_entity_id
            RETURNING id, src_entity_id, dst_entity_id""", (org, ws, list(src), list(dst)))}
        with conn.cursor() as cur:
            cur.executemany("INSERT INTO relation_sources (relation_id, chunk_id, organization_id, document_id, keywords,"
                            " description, weight) VALUES (%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                            [(rel[p], cid, org, doc, kw, desc, w) for p, cid, kw, desc, w in rel_src])
            cur.executemany("INSERT INTO relation_source_embeddings (relation_id, chunk_id, organization_id, document_id,"
                            " model_version, embedding) VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                            [(rel[p], cid, org, doc, m, vec) for p, cid, m, vec in rel_emb])

    @staticmethod
    def _gc_graph(conn, workspace_id) -> None:
        """Elimina claves sin procedencia (ya invisibles por RLS) tras borrar chunks."""
        execute(conn, "DELETE FROM relations r WHERE r.workspace_id = %s AND NOT EXISTS "
                      "(SELECT 1 FROM relation_sources s WHERE s.relation_id = r.id)", (workspace_id,))
        execute(conn, "DELETE FROM entities e WHERE e.workspace_id = %s AND NOT EXISTS "
                      "(SELECT 1 FROM entity_sources s WHERE s.entity_id = e.id)", (workspace_id,))

    @staticmethod
    def _graph_usage(conn, ctx: SecurityContext, stats: GraphStats | None, ref: str) -> None:
        if stats:
            _usage(conn, ctx.organization_id, "llm_input_tokens", stats.llm_input_tokens, ref)
            _usage(conn, ctx.organization_id, "llm_output_tokens", stats.llm_output_tokens, ref)
            _usage(conn, ctx.organization_id, "embedding_tokens", stats.embedding_tokens, ref)

    def _version_meta(self, conn, ver_id, ex: Extraction, model: ModelSpec) -> None:
        execute(conn, """
            UPDATE document_versions
               SET parser=%s, parser_version=%s, page_count=%s, chunk_count=%s, pipeline_version=%s,
                   embedding_model=%s, ocr_provider=%s, ocr_mean_confidence=%s,
                   figure_count=%s, table_count=%s, vision_model=%s,
                   duration_seconds=%s, transcription_provider=%s, transcription_language=%s
             WHERE id=%s""",
                (ex.parsed.parser, ex.parsed.parser_version, ex.parsed.page_count, len(ex.chunks),
                 self.settings.pipeline_version, model.model_id, ex.ocr.provider if ex.ocr else None,
                 ex.ocr.mean_confidence if ex.ocr else None,
                 sum(1 for c in ex.chunks if c.kind == "figure"), sum(1 for c in ex.chunks if c.kind == "table"),
                 ex.mm.vision_model, ex.audio.duration if ex.audio else None,
                 ex.audio.provider if ex.audio else None, (ex.audio.language or None) if ex.audio else None, ver_id))

    def _claim_job(self, conn, msg: JobMessage) -> dict | None:
        job = fetch_one(conn, "SELECT * FROM ingestion_jobs WHERE id = %s FOR UPDATE", (msg.job_id,))
        if not job:
            raise PermanentError("job_not_found")
        if job["state"] in ("succeeded", "failed", "dead"):
            return None
        return job

    # ------------------------------------------------------------------ ingesta
    def _ingest(self, ctx: SecurityContext, msg: JobMessage) -> str:
        t0 = time.perf_counter()
        with tenant_tx(ctx, self.pool) as conn:
            job = self._claim_job(conn, msg)
            if job is None:
                return "skipped:terminal"
            ver = fetch_one(conn, _VERSION_SQL, (msg.version_id, msg.document_id))
            if not ver:
                raise PermanentError("version_not_found")
            if ver["doc_status"] != "active":
                raise PermanentError("document_not_active")
            if ver["status"] == "indexed":
                execute(conn, "UPDATE ingestion_jobs SET state='succeeded', updated_at=now() WHERE id=%s", (msg.job_id,))
                return "skipped:already_indexed"
            execute(conn, "UPDATE ingestion_jobs SET state='running', attempts=attempts+1, updated_at=now() WHERE id=%s",
                    (msg.job_id,))
            execute(conn, "UPDATE document_versions SET status='quarantined', error_code=NULL, error_detail=NULL "
                          "WHERE id=%s", (msg.version_id,))

        policy = self._policy(ver)
        model = self.gateway.embedding_model()
        # La política se valida ANTES de leer contenido: un tenant restringido nunca envía datos a la nube.
        require_allowed(model, policy)

        ex = self._extract(ctx, ver, policy, on_status=lambda st, **f: self._status(ctx, msg.version_id, st, **f))
        self._status(ctx, msg.version_id, "enriched", parser=ex.parsed.parser,
                     parser_version=ex.parsed.parser_version, page_count=ex.parsed.page_count)
        self._status(ctx, msg.version_id, "embedding")
        vectors, embed_tokens = self._embed(ex.chunks, policy, model)
        ex.graph, ex.graph_stats = self._extract_graph(ver, policy, self._graph_inputs(ex.chunks))
        self._embed_graph(ex.graph, ex.graph_stats, policy, model)

        with tenant_tx(ctx, self.pool) as conn:
            # Verificar que el documento siga activo (pudo borrarse durante el procesamiento).
            doc = fetch_one(conn, "SELECT status FROM documents WHERE id=%s FOR UPDATE", (msg.document_id,))
            if not doc or doc["status"] != "active":
                raise PermanentError("document_not_active")
            # Re-entrada: limpiar restos de un intento previo de esta misma versión.
            execute(conn, "DELETE FROM chunks WHERE version_id=%s", (msg.version_id,))
            chunk_ids = self._insert_chunks(conn, ctx, ver, ex, vectors, model, "building")
            self._insert_graph(conn, ctx, ver, chunk_ids, ex.graph, model)
            # Swap atómico: la nueva versión pasa a activa y la anterior queda superseded.
            execute(conn, "UPDATE chunks SET index_state='superseded' WHERE document_id=%s AND version_id<>%s "
                          "AND index_state='active'", (msg.document_id, msg.version_id))
            execute(conn, "UPDATE chunks SET index_state='active' WHERE version_id=%s", (msg.version_id,))
            self._refresh_centroid(conn, msg.document_id)
            execute(conn, "UPDATE document_versions SET is_current=false, "
                          "status=CASE WHEN status='indexed' THEN 'superseded' ELSE status END "
                          "WHERE document_id=%s AND id<>%s AND is_current", (msg.document_id, msg.version_id))
            self._version_meta(conn, msg.version_id, ex, model)
            execute(conn, "UPDATE document_versions SET status='indexed', is_current=true, indexed_at=now() WHERE id=%s",
                    (msg.version_id,))
            execute(conn, "UPDATE documents SET current_version_id=%s, updated_at=now(), "
                          "title=CASE WHEN title='' THEN COALESCE(%s, title) ELSE title END WHERE id=%s",
                    (msg.version_id, ex.parsed.title, msg.document_id))
            execute(conn, "UPDATE ingestion_jobs SET state='succeeded', last_error=NULL, updated_at=now() WHERE id=%s",
                    (msg.job_id,))
            ref = str(msg.version_id)
            _usage(conn, ctx.organization_id, "ingest_documents", 1, ref)
            _usage(conn, ctx.organization_id, "ingest_pages", ex.parsed.page_count, ref)
            _usage(conn, ctx.organization_id, "embedding_tokens", embed_tokens, ref)
            _usage(conn, ctx.organization_id, "storage_bytes", ex.info.size, ref)
            _usage(conn, ctx.organization_id, "ocr_pages", ex.ocr.pages_processed if ex.ocr else 0, ref)
            self._mm_usage(conn, ctx, ex, ref)
            self._graph_usage(conn, ctx, ex.graph_stats, ref)
            _audit(conn, ctx.organization_id, "document.indexed", f"document_version:{msg.version_id}", "allow", {
                "document_id": str(msg.document_id), "chunks": len(ex.chunks), "pages": ex.parsed.page_count,
                "parser": f"{ex.parsed.parser}@{ex.parsed.parser_version}", "embedding_model": model.model_id,
                "pipeline_version": self.settings.pipeline_version, "sha256": ex.checksum,
                "ocr": {"provider": ex.ocr.provider, "pages": ex.ocr.pages_processed,
                        "mean_confidence": ex.ocr.mean_confidence, "dropped_lines": ex.ocr.dropped_lines} if ex.ocr else None,
                "multimodal": ex.mm.as_audit() or None,
                "graph": ex.graph_stats.as_audit() if ex.graph_stats else None,
                "audio": {"provider": ex.audio.provider, "seconds": ex.audio.duration, "language": ex.audio.language,
                          "segments": len(ex.audio.segments), "mean_confidence": ex.audio.mean_confidence,
                          "dropped_words": ex.audio.dropped_words} if ex.audio else None,
                "duration_ms": int((time.perf_counter() - t0) * 1000), "warnings": ex.parsed.warnings[:5],
            })
        log(logger, logging.INFO, "document.indexed", org=str(ctx.organization_id), version=str(msg.version_id),
            chunks=len(ex.chunks), pages=ex.parsed.page_count, ocr_pages=ex.ocr.pages_processed if ex.ocr else 0)
        return "indexed"

    # ------------------------------------------------------------------ reindexado
    def _reindex(self, ctx: SecurityContext, msg: JobMessage) -> str:
        with tenant_tx(ctx, self.pool) as conn:
            job = self._claim_job(conn, msg)
            if job is None:
                return "skipped:terminal"
            ver = fetch_one(conn, _VERSION_SQL, (msg.version_id, msg.document_id))
            if not ver or ver["doc_status"] != "active" or not ver["is_current"] or ver["status"] != "indexed":
                # La versión dejó de estar vigente: nada que hacer (otra versión ya fue indexada o se borró).
                execute(conn, "UPDATE ingestion_jobs SET state='succeeded', last_error='version_not_current', "
                              "updated_at=now() WHERE id=%s", (msg.job_id,))
                return "skipped:not_current"
            execute(conn, "UPDATE ingestion_jobs SET state='running', attempts=attempts+1, updated_at=now() WHERE id=%s",
                    (msg.job_id,))
        params = job["params"] or {}
        mode = params.get("mode", "embeddings")
        if mode == "graph":
            return self._reindex_graph(ctx, msg, ver, self._policy(ver))
        model = self.gateway.registry.get(params.get("model") or self.settings.ai_embedding_model)
        if model.dimensions != 1024:
            raise PermanentError("bad_model", "el modelo de embeddings debe producir 1024 dimensiones")
        policy = self._policy(ver)
        require_allowed(model, policy)
        if mode == "embeddings":
            return self._reindex_embeddings(ctx, msg, ver, policy, model)
        if mode == "full":
            return self._reindex_full(ctx, msg, ver, policy, model)
        raise PermanentError("bad_reindex_mode", str(mode))

    def _reindex_embeddings(self, ctx, msg, ver, policy, model) -> str:
        with tenant_tx(ctx, self.pool) as conn:
            missing = fetch_all(conn, """
                SELECT c.id, c.section_path, c.text FROM chunks c
                 WHERE c.version_id = %s AND c.index_state = 'active'
                   AND NOT EXISTS (SELECT 1 FROM chunk_embeddings e WHERE e.chunk_id = c.id AND e.model_version = %s)
                 ORDER BY c.ordinal""", (msg.version_id, model.model_id))
            ents = fetch_all(conn, """
                SELECT s.entity_id, s.chunk_id, s.name, s.type, s.description FROM entity_sources s
                  JOIN chunks c ON c.id = s.chunk_id
                 WHERE c.version_id = %s AND c.index_state = 'active'
                   AND NOT EXISTS (SELECT 1 FROM entity_source_embeddings e WHERE e.entity_id = s.entity_id
                                      AND e.chunk_id = s.chunk_id AND e.model_version = %s)""",
                             (msg.version_id, model.model_id))
            rels = fetch_all(conn, """
                SELECT s.relation_id, s.chunk_id, s.keywords, s.description FROM relation_sources s
                  JOIN chunks c ON c.id = s.chunk_id
                 WHERE c.version_id = %s AND c.index_state = 'active' AND s.keywords <> %s
                   AND NOT EXISTS (SELECT 1 FROM relation_source_embeddings e WHERE e.relation_id = s.relation_id
                                      AND e.chunk_id = s.chunk_id AND e.model_version = %s)""",
                             (msg.version_id, BELONGS_KEYWORDS, model.model_id))
        vectors, tokens = self._embed(missing, policy, model) if missing else ([], 0)
        ent_text = [self._entity_text(r["name"], r["type"], r["description"]) for r in ents]
        rel_text = [self._relation_text(r["keywords"], r["description"]) for r in rels]
        gvec, gtokens = self._embed_texts(ent_text + rel_text, policy, model) if ents or rels else ({}, 0)
        tokens += gtokens
        with tenant_tx(ctx, self.pool) as conn:
            with conn.cursor() as cur:
                # Vectores del grafo: la fila de procedencia puede haber desaparecido (reindex concurrente).
                cur.executemany(
                    "INSERT INTO entity_source_embeddings (entity_id, chunk_id, organization_id, document_id,"
                    " model_version, embedding) SELECT s.entity_id, s.chunk_id, s.organization_id, s.document_id, %s, %s"
                    " FROM entity_sources s WHERE s.entity_id = %s AND s.chunk_id = %s ON CONFLICT DO NOTHING",
                    [(model.model_id, gvec[t], r["entity_id"], r["chunk_id"]) for r, t in zip(ents, ent_text, strict=True)])
                cur.executemany(
                    "INSERT INTO relation_source_embeddings (relation_id, chunk_id, organization_id, document_id,"
                    " model_version, embedding) SELECT s.relation_id, s.chunk_id, s.organization_id, s.document_id, %s, %s"
                    " FROM relation_sources s WHERE s.relation_id = %s AND s.chunk_id = %s ON CONFLICT DO NOTHING",
                    [(model.model_id, gvec[t], r["relation_id"], r["chunk_id"]) for r, t in zip(rels, rel_text, strict=True)])
                cur.executemany(
                    "INSERT INTO chunk_embeddings (chunk_id, organization_id, document_id, model_version, embedding)"
                    " SELECT %s, %s, %s, %s, %s WHERE EXISTS (SELECT 1 FROM chunks WHERE id = %s AND index_state='active')"
                    " ON CONFLICT (chunk_id, model_version) DO NOTHING",
                    [(c["id"], ctx.organization_id, msg.document_id, model.model_id, v, c["id"])
                     for c, v in zip(missing, vectors, strict=True)])
            self._refresh_centroid(conn, msg.document_id)
            execute(conn, "UPDATE ingestion_jobs SET state='succeeded', last_error=NULL, updated_at=now() WHERE id=%s",
                    (msg.job_id,))
            _usage(conn, ctx.organization_id, "embedding_tokens", tokens, f"reindex:{msg.version_id}")
            _audit(conn, ctx.organization_id, "document.reindexed", f"document_version:{msg.version_id}", "allow",
                   {"mode": "embeddings", "model": model.model_id, "chunks_embedded": len(missing),
                    "graph_embedded": len(ents) + len(rels)})
        return f"reindexed:embeddings:{len(missing)}"

    def _reindex_graph(self, ctx, msg, ver, policy) -> str:
        if not ver.get("graph_enabled"):
            with tenant_tx(ctx, self.pool) as conn:
                execute(conn, "UPDATE ingestion_jobs SET state='succeeded', last_error='graph_disabled', updated_at=now() "
                              "WHERE id=%s", (msg.job_id,))
            return "skipped:graph_disabled"
        with tenant_tx(ctx, self.pool) as conn:
            rows = fetch_all(conn, "SELECT id, kind, text, meta->>'caption' AS caption, page_start, ordinal, "
                                   "COALESCE(meta->>'entity_summary', meta->>'summary') AS summary FROM chunks "
                                   "WHERE version_id=%s AND index_state='active' ORDER BY ordinal", (msg.version_id,))
        model = self.gateway.embedding_model()
        require_allowed(model, policy)
        graphs, stats = self._extract_graph(ver, policy, [
            (r["kind"], r["text"], {"caption": r["caption"], "page": r["page_start"], "ordinal": r["ordinal"],
                                    "summary": r["summary"]})
            for r in rows])
        self._embed_graph(graphs, stats, policy, model)
        with tenant_tx(ctx, self.pool) as conn:
            ids = [r["id"] for r in rows]
            # Solo chunks que siguen activos: un reindex full concurrente pudo reemplazarlos.
            alive = {r["id"] for r in fetch_all(conn, "SELECT id FROM chunks WHERE id = ANY(%s) AND index_state='active' "
                                                      "FOR UPDATE", (ids,))}
            graphs = {i: g for i, g in graphs.items() if ids[i] in alive}
            execute(conn, "DELETE FROM entity_sources WHERE chunk_id = ANY(%s)", (ids,))
            execute(conn, "DELETE FROM relation_sources WHERE chunk_id = ANY(%s)", (ids,))
            self._insert_graph(conn, ctx, ver, ids, graphs, model)
            self._gc_graph(conn, ver["workspace_id"])
            execute(conn, "UPDATE ingestion_jobs SET state='succeeded', last_error=NULL, updated_at=now() WHERE id=%s",
                    (msg.job_id,))
            ref = f"reindex:{msg.version_id}"
            self._graph_usage(conn, ctx, stats, ref)
            _audit(conn, ctx.organization_id, "document.reindexed", f"document_version:{msg.version_id}", "allow",
                   {"mode": "graph", "graph": stats.as_audit() if stats else None})
        return f"reindexed:graph:{stats.entities if stats else 0}"

    def _reindex_full(self, ctx, msg, ver, policy, model) -> str:
        # Las descripciones VLM ya pagadas se reutilizan por SHA-256 de la imagen (mismo modelo de visión).
        with tenant_tx(ctx, self.pool) as conn:
            known = {r["sha"]: (r["description"], r["model"], r["summary"]) for r in fetch_all(conn, """
                SELECT meta->>'sha256' AS sha, meta->>'description' AS description, meta->>'vision_model' AS model,
                       meta->>'entity_summary' AS summary
                  FROM chunks WHERE version_id=%s AND kind='figure' AND meta ? 'description'""", (msg.version_id,))}
        ex = self._extract(ctx, ver, policy, known_descriptions=known)
        vectors, tokens = self._embed(ex.chunks, policy, model)
        ex.graph, ex.graph_stats = self._extract_graph(ver, policy, self._graph_inputs(ex.chunks))
        self._embed_graph(ex.graph, ex.graph_stats, policy, model)
        with tenant_tx(ctx, self.pool) as conn:
            cur_ver = fetch_one(conn, "SELECT is_current, status FROM document_versions WHERE id=%s FOR UPDATE",
                                (msg.version_id,))
            doc = fetch_one(conn, "SELECT status FROM documents WHERE id=%s", (msg.document_id,))
            if not cur_ver or not cur_ver["is_current"] or cur_ver["status"] != "indexed" or doc["status"] != "active":
                execute(conn, "UPDATE ingestion_jobs SET state='succeeded', last_error='version_not_current' "
                              "WHERE id=%s", (msg.job_id,))
                return "skipped:not_current"
            # Reemplazo atómico: las consultas ven los chunks viejos hasta el COMMIT y los nuevos después.
            removed = execute(conn, "DELETE FROM chunks WHERE version_id=%s", (msg.version_id,))
            chunk_ids = self._insert_chunks(conn, ctx, ver, ex, vectors, model, "active")
            self._insert_graph(conn, ctx, ver, chunk_ids, ex.graph, model)
            self._gc_graph(conn, ver["workspace_id"])
            self._refresh_centroid(conn, msg.document_id)
            self._version_meta(conn, msg.version_id, ex, model)
            execute(conn, "UPDATE ingestion_jobs SET state='succeeded', last_error=NULL, updated_at=now() WHERE id=%s",
                    (msg.job_id,))
            ref = f"reindex:{msg.version_id}"
            _usage(conn, ctx.organization_id, "embedding_tokens", tokens, ref)
            _usage(conn, ctx.organization_id, "ocr_pages", ex.ocr.pages_processed if ex.ocr else 0, ref)
            self._mm_usage(conn, ctx, ex, ref)
            self._graph_usage(conn, ctx, ex.graph_stats, ref)
            _audit(conn, ctx.organization_id, "document.reindexed", f"document_version:{msg.version_id}", "allow", {
                "mode": "full", "multimodal": ex.mm.as_audit() or None, "model": model.model_id,
                "graph": ex.graph_stats.as_audit() if ex.graph_stats else None,
                "chunks_before": removed, "chunks_after": len(ex.chunks),
                "parser": f"{ex.parsed.parser}@{ex.parsed.parser_version}",
                "pipeline_version": self.settings.pipeline_version})
        return f"reindexed:full:{len(ex.chunks)}"

    # ------------------------------------------------------------------ borrado
    def _delete(self, ctx: SecurityContext, msg: JobMessage) -> str:
        with tenant_tx(ctx, self.pool) as conn:
            job = fetch_one(conn, "SELECT * FROM ingestion_jobs WHERE id=%s FOR UPDATE", (msg.job_id,))
            if not job:
                raise PermanentError("job_not_found")
            if job["state"] == "succeeded":
                return "skipped:succeeded"
            doc = fetch_one(conn, "SELECT * FROM documents WHERE id=%s FOR UPDATE", (msg.document_id,))
            if not doc:
                raise PermanentError("document_not_found")
            if doc["status"] == "active":
                raise PermanentError("document_still_active")
            keys = [r["s3_key"] for r in fetch_all(conn, "SELECT s3_key FROM document_versions WHERE document_id=%s",
                                                   (msg.document_id,))]
            n_chunks = execute(conn, "DELETE FROM chunks WHERE document_id=%s", (msg.document_id,))
            self._gc_graph(conn, doc["workspace_id"])
            execute(conn, "UPDATE document_versions SET is_current=false WHERE document_id=%s", (msg.document_id,))
            execute(conn, "UPDATE documents SET status='deleted', current_version_id=NULL, updated_at=now() "
                          "WHERE id=%s", (msg.document_id,))
            execute(conn, "UPDATE ingestion_jobs SET state='running', attempts=attempts+1 WHERE id=%s", (msg.job_id,))
        s3 = s3_client()
        prefix = f"tenants/{ctx.organization_id}/"
        for key in keys:
            if key.startswith(prefix):
                s3.delete_object(Bucket=self.settings.s3_bucket, Key=key)
        assets = self._purge_prefix(s3, f"{prefix}assets/{msg.document_id}/")
        with tenant_tx(ctx, self.pool) as conn:
            execute(conn, "UPDATE ingestion_jobs SET state='succeeded', updated_at=now() WHERE id=%s", (msg.job_id,))
            _audit(conn, ctx.organization_id, "document.purged", f"document:{msg.document_id}", "allow",
                   {"chunks_removed": n_chunks, "objects_removed": len(keys), "assets_removed": assets})
        return "purged"

    # ------------------------------------------------------------------ utilidades
    def _purge_prefix(self, s3, prefix: str) -> int:
        """Borra todos los activos derivados bajo el prefijo (incluye restos de intentos fallidos)."""
        removed = 0
        for page in s3.get_paginator("list_objects_v2").paginate(Bucket=self.settings.s3_bucket, Prefix=prefix):
            objs = [{"Key": o["Key"]} for o in page.get("Contents", []) if o["Key"].startswith(prefix)]
            if objs:
                s3.delete_objects(Bucket=self.settings.s3_bucket, Delete={"Objects": objs, "Quiet": True})
                removed += len(objs)
        return removed

    @staticmethod
    def _mm_usage(conn, ctx: SecurityContext, ex: Extraction, ref: str) -> None:
        _usage(conn, ctx.organization_id, "vision_images", ex.mm.vision_images, ref)
        # Solo se cobra lo transcrito de verdad: una transcripción reutilizada no vuelve a contar.
        if ex.audio and not ex.audio.reused:
            _usage(conn, ctx.organization_id, "audio_seconds", round(ex.audio.duration), ref)
        _usage(conn, ctx.organization_id, "llm_input_tokens", ex.mm.llm_input_tokens, ref)
        _usage(conn, ctx.organization_id, "llm_output_tokens", ex.mm.llm_output_tokens, ref)

    def _download(self, key: str, max_bytes: int) -> bytes:
        obj = s3_client().get_object(Bucket=self.settings.s3_bucket, Key=key)
        if int(obj.get("ContentLength", 0)) > max_bytes:
            raise ValidationError("too_large", "objeto excede el límite del plan")
        data = obj["Body"].read(max_bytes + 1)
        if len(data) > max_bytes:
            raise ValidationError("too_large", "objeto excede el límite del plan")
        return data

    _STATUS_FIELDS = {"size_bytes", "checksum_sha256", "parser", "parser_version", "page_count"}

    def _status(self, ctx: SecurityContext, version_id: uuid.UUID | None, status: str, **fields) -> None:
        assert set(fields) <= self._STATUS_FIELDS
        sets = ", ".join([f"{k}=%s" for k in fields] + ["status=%s"])
        with tenant_tx(ctx, self.pool) as conn:
            execute(conn, f"UPDATE document_versions SET {sets} WHERE id=%s", (*fields.values(), status, version_id))

    def _fail(self, ctx: SecurityContext, msg: JobMessage, code: str, detail: str, terminal_state: str,
              version_status: str) -> None:
        log(logger, logging.WARNING, f"{msg.kind}.failed", org=str(ctx.organization_id), job=str(msg.job_id), code=code)
        try:
            with tenant_tx(ctx, self.pool) as conn:
                execute(conn, "UPDATE ingestion_jobs SET state=%s, last_error=%s, updated_at=now() WHERE id=%s",
                        (terminal_state, f"{code}: {detail}"[:1000], msg.job_id))
                if msg.kind == "reindex":
                    # La versión sigue sirviendo consultas con su índice actual: no se toca su estado.
                    _audit(conn, ctx.organization_id, "document.reindex_failed", f"document_version:{msg.version_id}",
                           "allow", {"code": code})
                    return
                if msg.version_id:
                    execute(conn, "UPDATE document_versions SET status=%s, error_code=%s, error_detail=%s "
                                  "WHERE id=%s AND status<>'indexed'", (version_status, code, detail[:1000], msg.version_id))
                    execute(conn, "DELETE FROM chunks WHERE version_id=%s AND index_state='building'", (msg.version_id,))
                _audit(conn, ctx.organization_id, f"document.{'rejected' if version_status == 'rejected' else 'failed'}",
                       f"document_version:{msg.version_id}", "deny" if version_status == "rejected" else "allow",
                       {"code": code})
        except psycopg.Error:
            logger.exception("no se pudo registrar el fallo del job")

    def _mark_retry(self, ctx: SecurityContext, msg: JobMessage, error: str) -> None:
        try:
            with tenant_tx(ctx, self.pool) as conn:
                execute(conn, "UPDATE ingestion_jobs SET state='queued', last_error=%s, updated_at=now() WHERE id=%s",
                        (error[:1000], msg.job_id))
        except psycopg.Error:
            logger.exception("no se pudo marcar reintento")
