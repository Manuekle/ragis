"""Proveedor local determinista, sin red ni GPU.

- Embeddings: feature hashing (términos + bigramas + prefijos) a 1024 dimensiones, L2-normalizado.
  Captura coincidencia lexical/morfológica, NO semántica: baseline para dev, tests y on-prem mínimo.
- Generación extractiva: selecciona las oraciones de evidencia más relevantes y las cita [n]. Las tablas
  Markdown se leen por filas ("Encabezado = valor, …") y de cada tabla solo se toma la fila más relevante.
- Rerank lexical: cobertura de términos de la consulta + bonus por frase contigua.
- Grafo heurístico (RAG-05, `graph-heuristic`): entidades = nombres propios (secuencias capitalizadas con
  conectores de/del/la/y) y siglas; relaciones = pares consecutivos en una misma oración, con los términos entre
  ellos como keywords. Devuelve el mismo JSON que se pide a un LLM.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from collections import Counter

from ragsis_core.text import SPANISH_STOPWORDS, content_terms, estimate_tokens, fold, split_sentences

from ..registry import ModelSpec
from ..types import GenerationRequest, GenerationResult
from .base import ProviderError

DIM = 1024
_SECTION_PREFIX = re.compile(r"^\[(?:Sección:[^\]]*|Figura|Tabla|Ecuación)\]\s*", re.MULTILINE)


def _features(text: str) -> Counter:
    terms = content_terms(text)
    feats: Counter = Counter()
    for t in terms:
        feats[f"t:{t}"] += 1.0
        if len(t) > 5:
            feats[f"p:{t[:5]}"] += 0.5          # stem aproximado (plural/conjugación)
    for a, b in zip(terms, terms[1:], strict=False):
        feats[f"b:{a}_{b}"] += 0.7
    return feats


def hash_embed(text: str, salt: str = "") -> list[float]:
    vec = [0.0] * DIM
    for feat, tf in _features(text).items():
        h = hashlib.blake2b((salt + feat).encode("utf-8"), digest_size=8).digest()
        idx = int.from_bytes(h[:4], "little") % DIM
        sign = 1.0 if h[4] & 1 else -1.0
        vec[idx] += sign * (1.0 + math.log(tf))
    norm = math.sqrt(sum(v * v for v in vec))
    if norm == 0:
        # Vector nulo no es válido para distancia coseno: usar dirección fija de baja similitud.
        vec[0] = 1.0
        return vec
    return [v / norm for v in vec]


def _cells(line: str) -> list[str]:
    return [c.strip() for c in line.strip().strip("|").split("|")]


def split_tables(body: str) -> tuple[str, list[list[str]]]:
    """Separa el texto libre de las tablas Markdown; cada tabla → filas "Encabezado = valor, …"."""
    text_lines: list[str] = []
    tables: list[list[str]] = []
    block: list[str] = []

    def close() -> None:
        if len(block) >= 2:
            header = _cells(block[0])
            rows = [_cells(b) for b in block[1:] if not set(b.replace("|", "").strip()) <= set("-: ")]
            # "=" y "," no cortan oraciones en el verificador (":" y ";" sí): la fila queda como una sola afirmación.
            tables.append([", ".join(f"{h} = {v}" for h, v in zip(header, r, strict=False) if v and h) for r in rows])
        else:
            text_lines.extend(block)
        block.clear()

    for line in body.split("\n"):
        if line.strip().startswith("|") and line.strip().endswith("|"):
            block.append(line)
            continue
        close()
        text_lines.append(line)
    close()
    return "\n".join(text_lines), tables


def lexical_score(query: str, doc: str) -> float:
    q = content_terms(query)
    if not q:
        return 0.0
    d_terms = content_terms(doc)
    d = Counter(d_terms)
    d_pref = Counter(t[:5] for t in d_terms if len(t) > 5)
    qset = set(q)
    hits = 0.0
    for t in qset:
        if d[t]:
            hits += 1.0 + 0.2 * math.log(d[t])
        elif len(t) > 5 and d_pref[t[:5]]:
            hits += 0.6
    coverage = hits / len(qset)
    folded = fold(doc)
    bigrams = [f"{a} {b}" for a, b in zip(q, q[1:], strict=False)]
    phrase = sum(1 for bg in bigrams if bg in folded) / max(len(bigrams), 1)
    length_penalty = 1.0 / (1.0 + max(len(d_terms) - 400, 0) / 800)
    return round((0.8 * coverage + 0.2 * phrase) * length_penalty, 6)


_TOKEN = re.compile(r"[0-9A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+(?:[-'][0-9A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+)*")
_CONNECTORS = frozenset({"de", "del", "la", "las", "los", "el", "y", "e"})
_ORG_HEADS = frozenset({"direccion", "gerencia", "comite", "area", "departamento", "junta", "vicepresidencia",
                        "coordinacion", "oficina", "subdireccion", "jefatura", "consejo", "asamblea", "unidad"})
_PROJECT_HEADS = frozenset({"proyecto", "programa", "iniciativa", "plan"})
_PLACE_HEADS = frozenset({"planta", "sede", "region", "ciudad"})
_HINT_MIN_SCORE = 0.5


def _is_name_token(tok: str) -> bool:
    return tok[0].isupper() or (tok.isupper() and len(tok) >= 2)


def _entity_type(tokens: list[str]) -> str:
    head = fold(tokens[0])
    if head in _ORG_HEADS:
        return "organizacion"
    if head in _PROJECT_HEADS:
        return "proyecto"
    if head in _PLACE_HEADS:
        return "lugar"
    if len(tokens) == 1 and tokens[0].isupper():
        return "organizacion"
    return "otro"


def _sentence_entities(sentence: str) -> list[tuple[int, int, str, str]]:
    """(inicio, fin, nombre, tipo) de las menciones en una oración."""
    toks = list(_TOKEN.finditer(sentence))
    out: list[tuple[int, int, str, str]] = []
    i = 0
    while i < len(toks):
        if not _is_name_token(toks[i].group()) or toks[i].group().isdigit():
            i += 1
            continue
        j = i + 1
        while j < len(toks):
            t = toks[j].group()
            if _is_name_token(t) and not t.isdigit():
                j += 1
            elif fold(t) in _CONNECTORS and j + 1 < len(toks) and _is_name_token(toks[j + 1].group()):
                j += 2
            else:
                break
        run = [m.group() for m in toks[i:j]]
        start = i
        # Artículos/stopwords capitalizados al inicio ("La Dirección…", "El Comité…") no forman parte del nombre.
        while run and (fold(run[0]) in SPANISH_STOPWORDS or fold(run[0]) in _CONNECTORS):
            run.pop(0)
            start += 1
        while run and fold(run[-1]) in _CONNECTORS:
            run.pop()
        # Una sola palabra al inicio de la oración es casi siempre mayúscula gramatical, no un nombre.
        if run and not (len(run) == 1 and start == 0 and not run[0].isupper()) and len(" ".join(run)) >= 3:
            first, last = toks[start], toks[start + len(run) - 1]
            out.append((first.start(), last.end(), sentence[first.start():last.end()], _entity_type(run)))
        i = j
    return out


def graph_heuristic(text: str) -> dict:
    entities: dict[str, dict] = {}
    relations: dict[tuple[str, str], dict] = {}
    for sentence in split_sentences(_SECTION_PREFIX.sub("", text)):
        found = _sentence_entities(sentence)
        for _, _, name, etype in found:
            key = fold(name)
            if key not in entities:
                entities[key] = {"name": name, "type": etype, "description": sentence[:300]}
        for (_, e1, a, _), (s2, _, b, _) in zip(found, found[1:], strict=False):
            if fold(a) == fold(b):
                continue
            between = [t for t in content_terms(sentence[e1:s2])][:6]
            if not between:
                continue
            key = (fold(a), fold(b))
            if key not in relations:
                relations[key] = {"source": a, "target": b, "keywords": " ".join(between),
                                  "description": sentence[:300], "weight": 1.0}
    return {"entities": list(entities.values()), "relations": list(relations.values())}


def _hint_match(sentence: str, hints: tuple[str, ...]) -> bool:
    folded = set(content_terms(sentence))
    for h in hints:
        terms = set(content_terms(h))
        if terms and terms <= folded:
            return True
    return False


class LocalProvider:
    name = "local"

    def embed(self, model: ModelSpec, texts: list[str], input_type: str) -> tuple[list[list[float]], int]:
        salts = {"hash-1024": "", "hash-1024-v2": "v2|"}
        if model.provider_model_id not in salts:
            raise ProviderError(f"modelo local desconocido {model.provider_model_id}")
        salt = salts[model.provider_model_id]
        return [hash_embed(t, salt) for t in texts], sum(estimate_tokens(t) for t in texts)

    def rerank(self, model: ModelSpec, query: str, documents: list[str]) -> list[float]:
        return [lexical_score(query, d) for d in documents]

    def generate(self, model: ModelSpec, request: GenerationRequest) -> GenerationResult:
        if model.provider_model_id == "graph-heuristic":
            body = "\n".join(ev.text for ev in request.evidence)
            text = json.dumps(graph_heuristic(body), ensure_ascii=False)
            return GenerationResult(text, model.model_id, estimate_tokens(request.prompt), estimate_tokens(text))
        if model.provider_model_id != "extractive":
            raise ProviderError(f"modelo local desconocido {model.provider_model_id}")
        if not request.evidence:
            text = "I couldn't find enough evidence in the authorized documents to answer."
            return GenerationResult(text, model.model_id, estimate_tokens(request.prompt), estimate_tokens(text))
        scored: list[tuple[float, int, str]] = []
        for ev in request.evidence:
            body, tables = split_tables(_SECTION_PREFIX.sub("", ev.text))
            for sent in split_sentences(body):
                if len(sent) < 25:
                    continue
                s = lexical_score(request.question, sent)
                # Segundo salto (RAG-05): una oración que nombra una entidad puente y comparte algún término con
                # la pregunta entra con puntaje mínimo elegible, desempatada por su relevancia.
                if request.hints and 0 < s < _HINT_MIN_SCORE and _hint_match(sent, request.hints):
                    s = _HINT_MIN_SCORE + 0.3 * s
                if s > 0:
                    scored.append((s, ev.n, sent))
            for rows in tables:
                ranked = sorted(((lexical_score(request.question, r), r) for r in rows if len(r) >= 25), reverse=True)
                if ranked and ranked[0][0] > 0:
                    scored.append((ranked[0][0], ev.n, ranked[0][1]))
        scored.sort(key=lambda x: x[0], reverse=True)
        picked: list[tuple[int, str]] = []
        seen: set[str] = set()
        budget = request.max_output_tokens
        for s, n, sent in scored:
            if s < 0.5 or len(picked) >= 3:
                break
            key = fold(sent)[:80]
            if key in seen:
                continue
            seen.add(key)
            cost = estimate_tokens(sent)
            if cost > budget:
                break
            budget -= cost
            picked.append((n, sent.rstrip()))
        if not picked:
            text = "I couldn't find enough evidence in the authorized documents to answer."
        else:
            text = "According to the documents: " + " ".join(
                f"{sent}{'' if sent.endswith(('.', ';', ':')) else '.'} [{n}]" for n, sent in picked
            )
        return GenerationResult(text, model.model_id, estimate_tokens(request.prompt), estimate_tokens(text))

    def tokenize(self, text: str) -> int:
        return estimate_tokens(text)

    def healthcheck(self) -> bool:
        return True
