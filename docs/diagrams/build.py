#!/usr/bin/env python3
"""Generates the diagrams in docs/diagrams/*.svg (light and dark variants).

    python3 docs/diagrams/build.py

Edit the functions below and run it again. Icons come from docs/assets/icons
(see docs/assets/icons/README.md for licenses and source).
"""
from __future__ import annotations

from pathlib import Path

from lib import Canvas

OUT = Path(__file__).resolve().parent


def containers(c: Canvas) -> None:
    c.text(24, 36, "Ragis · containers and data flow", 17, 700)
    c.text(24, 56, "Same services locally (Docker Compose) and on AWS; only S3/SQS and the identity provider change.", 11.5, 400, c.t["muted"])
    W, H = 170, 64
    c.node("users", 30, 90, W, H, "People", "browser", "aws/users.svg", icon_size=30)
    c.node("web", 300, 90, W, H, "web", "Next.js · BFF\ncookie httpOnly", "tech/next-js.svg")
    c.node("api", 570, 90, W, H, "api", "Fastify · authZ\nuploads · queries", "tech/fastify.svg", accent=True)
    c.node("rag", 840, 90, W, H, "rag-engine", "FastAPI · hybrid\n+ RRF + citations", "tech/fastapi.svg", accent=True)
    c.node("s3", 30, 270, W, H, "S3", "SeaweedFS locally\nfiles and figures", "aws/s3.svg")
    c.node("sqs", 570, 270, W, H, "SQS", "ElasticMQ locally\nqueue + DLQ", "aws/sqs.svg")
    c.node("pg", 840, 270, W, 64, "PostgreSQL", "pgvector · RLS", "tech/postgresql.svg")
    c.node("worker", 570, 430, W, H, "ingest-worker", "Python · validate,\nparse, graph, embed", "tech/python.svg", accent=True)
    c.node("clam", 570, 570, W, H, "ClamAV", "antimalware scan", "aws/server.svg", icon_size=30)
    c.node("ocr", 840, 570, 214, H, "Textract · Transcribe", "OCR and speech to text\n(optional)", "aws/textract.svg")
    # ai-gateway
    c.node("gw", 1110, 90, 170, 400, "ai-gateway", "ModelRegistry\nresidency policy\nbounded fallback\nbudgets", "tech/python.svg")
    c.group(1100, 530, 190, 124, "Model providers")
    for i, (ic, label) in enumerate([("aws/bedrock.svg", "Amazon Bedrock"), ("tech/ollama.svg", "Ollama (on-prem)"), ("tech/python.svg", "Local, deterministic")]):
        c.icon(ic, 1114, 556 + i * 31, 24)
        c.text(1148, 573 + i * 31, label, 11.5)

    P = c.pt
    c.edge([P("users", "r"), P("web", "l")], "HTTPS")
    c.edge([P("web", "r"), P("api", "l")], "id_token")
    c.edge([P("api", "r"), P("rag", "l")], "60 s token")
    c.edge([P("rag", "r"), (1110, 122)], "models", label_at=(1060, 122))
    c.edge([P("users", "b", 0.5), P("s3", "t", 0.5)], "presigned PUT", dashed=True)
    c.edge([P("api", "b", 0.25), P("sqs", "t", 0.25)], "enqueues")
    c.edge([P("rag", "b", 0.5), P("pg", "t", 0.5)], "FTS + vector")
    c.edge([(720, 154), (720, 215), (880, 215), (880, 270)], "SQL with RLS", label_at=(800, 215))
    c.edge([P("sqs", "b", 0.25), P("worker", "t", 0.25)], "message")
    c.edge([(570, 462), (115, 462), P("s3", "b", 0.5)], "reads and writes objects", label_at=(340, 462))
    c.edge([(740, 446), (910, 446), (910, 334)], "chunks + index", label_at=(825, 446))
    c.edge([(740, 470), (1110, 470)], "embeddings · VLM", label_at=(980, 470))
    c.edge([P("worker", "b", 0.5), P("clam", "t", 0.5)], "scan")
    c.edge([(740, 486), (925, 486), P("ocr", "t", 0.5)], "OCR · audio", label_at=(830, 486))
    c.edge([(1195, 490), (1195, 530)])
    c.text(24, 660, "Solid line: service call · dotted: direct browser access with a URL presigned by the API.", 11, 400, c.t["muted"])


def aws_pilot(c: Canvas) -> None:
    c.text(24, 34, "Pilot on AWS · us-east-2 (Ohio)", 17, 700)
    c.node("users", 22, 266, 112, 60, "People", "", "aws/users.svg", icon_size=30)
    c.group(150, 48, 1090, 710, "AWS Cloud · pilot project", "aws/group-aws-cloud.svg", stroke="#232F3E")
    c.group(170, 88, 1050, 650, "Region us-east-2", "aws/group-region.svg", dashed=True, stroke="#00A4A6")
    c.group(190, 128, 640, 560, "Default VPC", "aws/group-vpc.svg", stroke="#8C4FFF")
    c.group(210, 168, 620, 500, "Public subnet", "aws/group-public-subnet.svg", stroke="#7AA116")
    c.group(330, 208, 480, 410, "EC2 · m7i-flex.large · Ubuntu 24.04 · 30 GB encrypted gp3", "aws/ec2.svg", stroke="#ED7100")
    c.node("eip", 216, 266, 108, 60, "Fixed IP", "elastic", "aws/elastic-ip.svg", icon_size=26)
    c.text(350, 258, "docker compose (infra/docker/compose.pilot.yml)", 10.5, 500, c.t["muted"])
    L, R, W, H = 350, 580, 210, 60
    c.node("caddy", L, 266, W, H, "caddy", "automatic TLS · 80/443", None)
    c.node("web", L, 356, W, H, "web", "Next.js · in-app login", "tech/next-js.svg")
    c.node("api", L, 446, W, H, "api", "Fastify · authZ", "tech/fastify.svg", accent=True)
    c.node("rag", L, 536, W, H, "rag-engine", "FastAPI · query", "tech/fastapi.svg", accent=True)
    c.node("clam", R, 266, W, H, "clamav", "antimalware", "aws/server.svg", icon_size=26)
    c.node("worker", R, 356, W, H, "ingest-worker", "Python · ingestion", "tech/python.svg", accent=True)
    c.node("pg", R, 446, W, 150, "postgres", "pgvector · RLS\nEBS volume", "tech/postgresql.svg")
    # servicios regionales
    X, SW = 880, 300
    c.node("cognito", X, 128, SW, 60, "Cognito", "invited accounts · password + challenge", "aws/cognito.svg")
    c.node("s3", X, 208, SW, 60, "S3 documents", "versioned · SSE-KMS · private", "aws/s3.svg")
    c.node("sqs", X, 288, SW, 60, "SQS ingestion + DLQ", "encrypted with KMS", "aws/sqs.svg")
    c.node("kms", X, 368, SW, 60, "KMS", "annual rotation · S3, SQS and EBS", "aws/kms.svg")
    c.node("ecr", X, 448, SW, 60, "Private ECR", "4 repositories · immutable tags", "aws/ecr.svg")
    c.node("ssm", X, 528, SW, 60, "Systems Manager", "Session Manager · no SSH", "aws/systems-manager.svg")
    c.node("iam", X, 608, SW, 60, "IAM · role ragsis-pilot-ec2", "least privilege per resource", "aws/iam.svg")

    P = c.pt
    c.edge([P("users", "r"), (216, 296)], "HTTPS", label_at=(176, 280))
    c.edge([P("eip", "r"), P("caddy", "l")])
    c.edge([P("caddy", "b", 0.5), P("web", "t", 0.5)])
    c.edge([P("web", "b", 0.5), P("api", "t", 0.5)])
    c.edge([P("api", "b", 0.5), P("rag", "t", 0.5)])
    c.edge([P("api", "r", 0.5), P("pg", "l", 0.2)])
    c.edge([P("rag", "r", 0.5), P("pg", "l", 0.85)])
    c.edge([P("worker", "t", 0.5), P("clam", "b", 0.5)])
    c.edge([P("worker", "b", 0.5), P("pg", "t", 0.5)])
    c.edge([(810, 158), (880, 158)], "login", both=True, label_at=(845, 158))
    c.edge([(810, 238), (880, 238)], "", both=True)
    c.edge([(810, 318), (880, 318)], "", both=True)
    c.edge([(880, 478), (810, 478)], "pull", label_at=(845, 478))
    c.edge([(880, 558), (810, 558)], "", dashed=True)
    c.text(24, 770, "The browser only talks to Caddy. Everything else lives on the instance or in managed regional services.", 11, 400, c.t["muted"])


def environments(c: Canvas) -> None:
    c.text(24, 36, "Three environments, one rule: emulator first, then AWS", 17, 700)
    cols = [
        (24, "1 · Local", "tech/docker.svg", "make up · Docker Compose",
         [("tech/postgresql.svg", "Postgres + pgvector"), ("aws/s3.svg", "SeaweedFS (S3 API)"), ("aws/sqs.svg", "ElasticMQ (SQS API)"),
          ("tech/python.svg", "Python and Fastify services"), ("tech/next-js.svg", "web with development login")]),
        (464, "2 · Rehearsal in AWS Emulator", "aws/server.svg", "make rehearse · Terraform → 127.0.0.1:9297",
         [("aws/ec2.svg", "EC2 left out for now (API gap)"), ("aws/s3.svg", "S3, SQS, KMS, SSM"), ("aws/cognito.svg", "Cognito and IAM"),
          ("aws/ecr.svg", "ECR and network resources"), ("tech/terraform.svg", "the same pilot modules")]),
        (904, "3 · Real AWS", "aws/group-aws-cloud.svg", "terraform apply · ragsis-pilot profile",
         [("aws/ec2.svg", "EC2 m7i-flex.large + EBS"), ("aws/s3.svg", "S3, SQS, KMS, ECR"), ("aws/cognito.svg", "Cognito (invited accounts)"),
          ("aws/systems-manager.svg", "Session Manager"), ("tech/terraform.svg", "same modules · FREE plan")]),
    ]
    for x, title, icon, sub, rows in cols:
        c.group(x, 70, 330, 330, "")
        c.icon(icon, x + 14, 82, 40, 40)
        c.text(x + 64, 104, title, 14, 700)
        c.text(x + 14, 148, sub, 11.5, 500, c.t["muted"])
        for i, (ic, label) in enumerate(rows):
            y = 176 + i * 44
            c.icon(ic, x + 18, y, 28)
            c.text(x + 58, y + 19, label, 12.5)
    c.edge([(354, 235), (464, 235)], "same Terraform\nmodules", color=c.t["accent"], label_at=(409, 235))
    c.edge([(794, 235), (904, 235)], "only if the\nrehearsal passes", color=c.t["accent"], label_at=(849, 235))
    c.add(f'<rect x="24" y="430" width="1210" height="70" rx="10" fill="{c.t["accent_soft"]}" stroke="{c.t["accent"]}" stroke-width="1.3"/>')
    c.text(44, 458, "Working rule", 13, 700, c.t["accent"])
    c.text(44, 480, "All AWS infrastructure and changes are created first in AWS Emulator with scripts/aws-rehearsal.sh. Only after a clean rehearsal are they applied to real AWS.", 12.5)


def _mini_graph(c: Canvas, nodes: list[tuple[float, float, float, str]], edges: list[tuple[int, int]],
                dashed: tuple[int, ...] = ()) -> None:
    for i, (a, b) in enumerate(edges):
        c.link(nodes[a][:2], nodes[b][:2], dashed=i in dashed)
    for x, y, r, m in nodes:
        c.dot(x, y, r, m)


def rag_pipeline(c: Canvas) -> None:
    t = c.t
    c.icon("../brand/ragis-logo.svg", 24, 16, 30)
    c.text(64, 37, "How Ragis answers: multimodal RAG over a cross-modal knowledge graph", 17, 700)
    c.text(64, 57, "Each file becomes typed content units, a dual knowledge graph and one vector space; a question is answered "
           "only from evidence the person is allowed to read.", 11.5, 400, t["muted"])

    # ── Sources ─────────────────────────────────────────────────────────────────────────────
    c.group(20, 84, 156, 640, "Sources", dashed=True)
    files = [("PDF", None), ("DOCX", None), ("PPTX", None), ("XLSX", None), ("PNG · JPEG", "figure"),
             ("HTML · Markdown", None), ("TXT · CSV", None), ("MP3 · WAV", "audio"), ("M4A · OGG · FLAC", "audio")]
    for i, (label, m) in enumerate(files):
        y = 112 + i * 40
        s, f = c.mod(m) if m else (t["card_stroke"], t["card"])
        c.box(34, y, 128, 30, s, f, rx=6)
        c.text(98, y + 19, label, 11.5, 600, s if m else t["text"], "middle")
    c.text(34, 494, "Connectors", 11.5, 600, t["muted"])
    for i, ic in enumerate(["tech/gmail.svg", "tech/slack.svg", "tech/clickup.svg"]):
        c.icon(ic, 36 + i * 40, 506, 26)
    c.text(34, 562, "Presigned upload\nstraight to S3,\nin quarantine.", 11, 400, t["muted"])
    c.text(34, 626, "Folders only\norganize; access\nis the document ACL.", 11, 400, t["muted"])

    # ── 1 · Parsing ─────────────────────────────────────────────────────────────────────────
    c.group(196, 84, 384, 640, "1 · Multimodal content parsing", stroke=t["accent"])
    c.node("gate", 210, 108, 274, 48, "Validate and scan", "magic bytes, MIME, macros, ClamAV", "ragis/verify.svg", icon_size=26)
    rows = [
        ("text", "Hierarchical text", "sections and pages,\nPII redacted"),
        ("figure", "Figures", "caption + VLM description\nwith context, S3 asset, bbox"),
        ("equation", "Equations", "LaTeX + optional AI analysis\nof what it computes"),
        ("table", "Tables", "cells as Markdown,\nverified AI summary"),
        ("audio", "Recordings", "speech to text with [mm:ss]\nand speaker labels"),
    ]
    for i, (m, title, sub) in enumerate(rows):
        y = 170 + i * 92
        c.node(f"p{i}", 210, y, 274, 78, title, sub, f"ragis/{m}.svg", icon_size=30)
        cy = y + 39
        c.edge([(484, cy), (506, cy)])
        for k in range(2):
            s, f = c.mod(m)
            c.box(510, cy - 27 + k * 28, 26, 24, s, f, rx=5)
    c.text(523, 162, "units", 10.5, 600, t["muted"], "middle")
    c.node("ocr", 210, 640, 274, 60, "Scans: OCR", "Textract, or local Docling", "aws/textract.svg", icon_size=28)
    c.text(523, 676, "page\nbbox\nt_start", 10, 400, t["muted"], "middle")
    c.edge([c.pt("gate", "b", 0.5), c.pt("p0", "t", 0.5)])

    # ── 2 · Dual graph + vectors ────────────────────────────────────────────────────────────
    c.group(600, 84, 470, 640, "2 · Dual-graph grounding and index", stroke=t["accent"])
    c.box(614, 108, 442, 336, t["group_stroke"], t["bg"], dashed=True)
    c.text(626, 128, "Knowledge graph", 12, 600)
    # text graph
    c.box(626, 140, 206, 132, t["card_stroke"], t["card"])
    c.text(638, 158, "Text graph", 11.5, 600)
    c.text(638, 172, "entities and relations per chunk", 10, 400, t["muted"])
    _mini_graph(c, [(660, 212, 8, "text"), (712, 196, 7, "text"), (760, 226, 8, "text"), (700, 246, 6, "text"),
                    (804, 200, 6, "text"), (648, 252, 5, "text")],
                [(0, 1), (1, 2), (0, 3), (3, 2), (2, 4), (0, 5)])
    # cross-modal graph
    c.box(626, 284, 206, 148, t["card_stroke"], t["card"])
    c.text(638, 302, "Cross-modal graph", 11.5, 600)
    c.text(638, 316, "anchor per figure, table, equation", 10, 400, t["muted"])
    _mini_graph(c, [(676, 372, 12, "figure"), (650, 344, 5, "text"), (642, 392, 5, "text"), (700, 412, 5, "text"),
                    (770, 366, 12, "table"), (750, 336, 5, "text"), (806, 344, 5, "text"), (808, 402, 5, "text"),
                    (738, 414, 9, "equation")],
                [(1, 0), (2, 0), (3, 0), (5, 4), (6, 4), (7, 4), (3, 8), (0, 4)], dashed=(7,))
    c.text(729, 428, "belongs_to · row / column / cell", 9.5, 400, t["muted"], "middle")
    # merge
    c.add(f'<polyline points="832,206 872,206 872,358 832,358" fill="none" stroke="{t["line"]}" stroke-width="1.5"/>')
    c.edge([(872, 286), (892, 286)])
    c.box(892, 140, 152, 292, t["card_stroke"], t["card"])
    c.text(904, 158, "Workspace graph", 11.5, 600)
    c.text(904, 172, "merged by entity name", 10, 400, t["muted"])
    _mini_graph(c, [(968, 232, 10, "text"), (930, 206, 6, "text"), (1012, 204, 7, "text"), (928, 268, 11, "figure"),
                    (1000, 272, 9, "text"), (1020, 320, 11, "table"), (950, 320, 6, "text"), (912, 350, 5, "text"),
                    (978, 372, 9, "equation"), (1024, 380, 5, "text"), (944, 402, 9, "audio")],
                [(0, 1), (0, 2), (0, 3), (0, 4), (4, 5), (3, 6), (6, 7), (6, 8), (5, 9), (8, 9), (7, 10), (4, 6)])
    # vectors
    c.box(614, 456, 442, 178, t["group_stroke"], t["bg"], dashed=True)
    c.text(626, 476, "Vector index · pgvector + Spanish full-text", 12, 600)
    for j, (label, mods) in enumerate([("Chunk vectors", ["text", "figure", "table", "audio"]),
                                       ("Entity and relation\nvectors", ["graph", "graph", "vector"])]):
        x = 640 + j * 170
        for k, m in enumerate(mods):
            s, f = c.mod(m)
            c.add(f'<path d="M{x} {552 - k * 9} l50 -14 l50 14 l-50 14 Z" fill="{f}" stroke="{s}" stroke-width="1.2"/>')
        c.text(x + 50, 594, label, 11, 500, t["text"], "middle")
    c.icon("ragis/vector.svg", 958, 516, 30)
    c.text(973, 566, "one space", 10.5, 600, t["text"], "middle")
    c.text(973, 580, "per model", 10.5, 400, t["muted"], "middle")
    c.box(614, 646, 442, 64, t["accent"], t["accent_soft"])
    c.icon("ragis/verify.svg", 626, 662, 30)
    c.text(666, 670, "Every chunk, entity, relation and vector keeps its source", 11.5, 600)
    c.text(666, 686, "chunk; the document ACL decides who sees it (RLS forced).", 11.5, 400, t["muted"])
    c.edge([(536, 314), (600, 314)], "graph", label_at=(558, 300))
    c.edge([(536, 546), (600, 546)], "embed", label_at=(558, 532))

    # ── 3 · Query ───────────────────────────────────────────────────────────────────────────
    c.group(1090, 84, 330, 640, "3 · Cross-modal hybrid retrieval", stroke=t["accent"])
    qs, qf = c.mod("query")
    c.box(1104, 108, 302, 46, qs, qf, rx=10, dashed=True)
    c.text(1255, 128, "“What does the 2024 margin table", 11.5, 500, qs, "middle")
    c.text(1255, 144, "say about the north region?”", 11.5, 500, qs, "middle")
    c.node("auth", 1104, 166, 302, 46, "Tenant and permissions", "membership, ACL applied in SQL", "ragis/verify.svg", icon_size=24)
    c.node("cues", 1104, 222, 302, 46, "Modality cues", "table · figure · formula · recording", "ragis/search.svg", icon_size=24)
    for k, label in enumerate(["Full-text", "Vectors", "Graph seeds"]):
        c.node(f"r{k}", 1104 + k * 102, 280, 98, 40, label)
    c.node("fuse", 1104, 334, 302, 46, "RRF fusion + rerank", "bonus for the asked modality", accent=True)
    c.node("evid", 1104, 392, 302, 50, "Evidence + graph facts", "selected chunks [n] and their cells", "ragis/text.svg", icon_size=24)
    c.node("llm", 1104, 454, 302, 46, "Language model", "chosen by data classification", "ragis/llm.svg", icon_size=24)
    c.node("ver", 1104, 512, 302, 46, "Citation verifier", "every [n] and figure in the evidence", "ragis/verify.svg", icon_size=24)
    c.box(1104, 572, 302, 70, t["accent"], t["accent_soft"], rx=10)
    c.text(1255, 596, "Answer with citations [1] [2]", 12.5, 700, t["text"], "middle")
    c.text(1255, 614, "p. 7 · Table 3 · Listen from 04:12", 11, 500, t["accent"], "middle")
    c.text(1255, 630, "or an explicit abstention", 11, 400, t["muted"], "middle")
    c.text(1104, 664, "restricted data never leaves the network;\nno silent fallback to the cloud.", 10.5, 400, t["muted"])
    P = c.pt
    c.edge([(1255, 154), P("auth", "t")])
    c.edge([P("auth", "b"), P("cues", "t")])
    for k in range(3):
        c.edge([(1153 + k * 102, 268), P(f"r{k}", "t")])
        c.edge([P(f"r{k}", "b"), (1153 + k * 102, 334)])
    c.edge([P("fuse", "b"), P("evid", "t")])
    c.edge([P("evid", "b"), P("llm", "t")])
    c.edge([P("llm", "b"), P("ver", "t")])
    c.edge([P("ver", "b"), (1255, 572)])
    c.add(f'<polyline points="1056,286 1078,286 1078,560 1056,560" fill="none" stroke="{t["line"]}" stroke-width="1.5" stroke-dasharray="5 4"/>')
    c.edge([(1078, 300), (1104, 300)], dashed=True)
    c.text(24, 752, "Structure inspired by RAG-Anything (Guo et al., 2025), implemented inside PostgreSQL. Decisions: ADR-018 "
           "(multimodal), ADR-019 (graph), ADR-029 (cross-modal graph), ADR-030 (audio).", 11, 400, t["muted"])


def ingest(c: Canvas) -> None:
    c.text(24, 36, "Ingesting a document", 17, 700)
    W, H = 212, 96
    xs = [30 + i * 242 for i in range(5)]
    row1 = [
        ("aws/s3.svg", "1 · Presigned upload", "The browser uploads the file\nto quarantine in S3"),
        ("tech/fastify.svg", "2 · Record", "API saves version + job in\nPostgres, enqueues to SQS"),
        ("tech/python.svg", "3 · Validation", "Magic bytes, MIME, macros,\nZIP bomb and limits"),
        ("aws/server.svg", "4 · Antimalware", "ClamAV scans the object;\nmalware = rejected"),
        ("aws/textract.svg", "5 · Parse, OCR, audio", "Native or Docling; OCR for\nscans; speech to text"),
    ]
    row2 = [
        ("ragis/figure.svg", "6 · Multimodal units", "Figures (VLM), tables,\nequations, transcript spans"),
        ("ragis/text.svg", "7 · Chunking and PII", "Chunks with page, bbox or\ntime range; PII redacted"),
        ("ragis/graph.svg", "8 · Knowledge graph", "Text + cross-modal graph,\ntable cells (if enabled)"),
        ("ragis/vector.svg", "9 · Embeddings", "Chunks, entities, relations;\ntenant's model policy"),
        ("tech/postgresql.svg", "10 · Index and done", "pgvector + FTS, ACL kept;\nstatus indexed, audit"),
    ]
    for i, (ic, t, s) in enumerate(row1):
        c.node(f"a{i}", xs[i], 70, W, H, t, s, ic, accent=(i == 2))
    for i, (ic, t, s) in enumerate(row2):
        c.node(f"b{i}", xs[i], 250, W, H, t, s, ic, accent=(i == 3))
    for i in range(4):
        c.edge([c.pt(f"a{i}", "r"), c.pt(f"a{i+1}", "l")])
        c.edge([c.pt(f"b{i}", "r"), c.pt(f"b{i+1}", "l")])
    c.edge([c.pt("a4", "b", 0.5), (xs[4] + W / 2, 200), (xs[0] + W / 2, 200), c.pt("b0", "t", 0.5)], "", label_at=(640, 200))
    c.node("err", 30, 400, 1180, 64, "Errors", "Permanent (invalid file, malware, policy, page or audio limit, no speech) → failed / rejected, no retry.  Transient (DB, S3, model, ClamAV) → retries, DLQ after 4 receives.", "aws/sqs.svg", icon_size=28)
    c.text(24, 490, "Processing is idempotent per job and version. Reindexing reuses the originals in S3 (runbook reindex.md).", 11, 400, c.t["muted"])


def query(c: Canvas) -> None:
    c.text(24, 36, "Query with verifiable citations", 17, 700)
    W, H = 212, 96
    xs = [30 + i * 242 for i in range(5)]
    row1 = [
        ("aws/users.svg", "1 · Question", "From the web or with a\nservice key rsk_…"),
        ("tech/fastify.svg", "2 · Tenant and role", "Verified membership;\nnever from the client"),
        ("tech/fastify.svg", "3 · Internal token", "60 s JWT to the\nrag-engine (ADR-009)"),
        ("ragis/search.svg", "4 · Retrieval", "FTS + vectors + graph;\nACL applied in SQL"),
        ("tech/fastapi.svg", "5 · Fusion", "RRF + modality bonus;\nrerank per plan"),
    ]
    row2 = [
        ("ragis/llm.svg", "6 · Generation", "Escaped evidence + graph\nfacts tied to their [n]"),
        ("ragis/verify.svg", "7 · Verifier", "Each citation and figure\nmust be in the cited text"),
        ("tech/postgresql.svg", "8 · Record", "query_run: tokens + cost;\nquestion kept as SHA-256"),
        ("aws/documents.svg", "9 · Answer", "Text with citations or\nexplicit abstention"),
    ]
    for i, (ic, t, s) in enumerate(row1):
        c.node(f"a{i}", xs[i], 70, W, H, t, s, ic, accent=(i == 3))
    for i, (ic, t, s) in enumerate(row2):
        c.node(f"b{i}", xs[i], 250, W, H, t, s, ic, accent=(i == 1))
    for i in range(4):
        c.edge([c.pt(f"a{i}", "r"), c.pt(f"a{i+1}", "l")])
    for i in range(3):
        c.edge([c.pt(f"b{i}", "r"), c.pt(f"b{i+1}", "l")])
    c.edge([c.pt("a4", "b", 0.5), (xs[4] + W / 2, 200), (xs[0] + W / 2, 200), c.pt("b0", "t", 0.5)])
    c.node("gate", 30, 396, 454, 64, "Model policy", "restricted never calls external APIs; no silent fallback to the cloud", "aws/iam.svg", icon_size=28)
    c.edge([c.pt("b0", "b", 0.5), c.pt("gate", "t", 0.23)], "applies", dashed=True)
    c.text(24, 490, "If the evidence is not enough, the system abstains instead of making things up. Pilot metrics (accuracy, citations, ACL leakage = 0) come from make e2e.", 11, 400, c.t["muted"])


def auth(c: Canvas) -> None:
    c.text(24, 36, "In-app sign-in (Cognito only stores the accounts)", 17, 700)
    xs = {"br": 130, "web": 400, "cog": 700, "api": 1000}
    heads = [("br", "Browser", "aws/users.svg", "Ragis /login page"), ("web", "web", "tech/next-js.svg", "BFF · /api/auth/password"),
             ("cog", "Cognito", "aws/cognito.svg", "InitiateAuth (public client)"), ("api", "api", "tech/fastify.svg", "validates id_token (JWKS)")]
    for k, t, ic, s in heads:
        c.node(k, xs[k] - 100, 66, 200, 64, t, s, ic, icon_size=30)
        c.add(f'<line x1="{xs[k]}" y1="130" x2="{xs[k]}" y2="520" stroke="{c.t["group_stroke"]}" stroke-width="1.3" stroke-dasharray="4 5"/>')
    msgs = [
        ("br", "web", 170, "POST email + password", False),
        ("web", "cog", 210, "USER_PASSWORD_AUTH (HTTPS)", False),
        ("cog", "web", 250, "id_token  ·  or NEW_PASSWORD_REQUIRED challenge", True),
        ("web", "br", 290, "Set-Cookie ragsis_session (httpOnly)", True),
        ("br", "web", 340, "GET /app  (cookie)", False),
        ("web", "api", 380, "Authorization: Bearer id_token", False),
        ("api", "cog", 420, "public keys (JWKS), once an hour", True),
        ("api", "web", 460, "tenant data, by membership and role", True),
    ]
    for i, (a, b, y, label, dashed) in enumerate(msgs):
        c.edge([(xs[a], y), (xs[b], y)], label, dashed=dashed, label_at=((xs[a] + xs[b]) / 2, y - 12))
        c.step(xs[a] + (18 if xs[b] > xs[a] else -18), y, i + 1)
    c.text(24, 556, "The id_token never reaches JavaScript: it lives in an httpOnly cookie. \"Forgot your password?\" uses ForgotPassword; the code arrives by email.", 11, 400, c.t["muted"])


DIAGRAMS = {
    "rag-pipeline": (rag_pipeline, 1440, 776, "How Ragis answers", "Multimodal parsing into typed content units, a dual text and cross-modal knowledge graph with a vector index, and cross-modal hybrid retrieval with verified citations."),
    "containers": (containers, 1310, 690, "Ragis containers", "Web, API, RAG engine, ingestion worker, Postgres, S3, SQS and model providers, and their connections."),
    "aws-pilot": (aws_pilot, 1260, 790, "Pilot on AWS", "One EC2 instance running Docker Compose behind an Elastic IP, plus S3, SQS, KMS, ECR, Cognito and Systems Manager in us-east-2."),
    "environments": (environments, 1260, 524, "Environments", "Local with Docker Compose, rehearsal in AWS Emulator and real AWS, with the rule of rehearsing in the emulator first."),
    "ingest": (ingest, 1240, 510, "Ingestion pipeline", "Ten steps from the presigned upload to the indexed document, including OCR, speech to text and the knowledge graph."),
    "query": (query, 1240, 510, "Query flow", "Nine steps from the question to the answer with verified citations."),
    "auth": (auth, 1180, 580, "Sign-in flow", "The login form lives in the web app and talks to Cognito from the server; the session is an httpOnly cookie."),
}


def main() -> None:
    for name, (fn, w, h, title, desc) in DIAGRAMS.items():
        for theme, suffix in (("light", ""), ("dark", "-dark")):
            c = Canvas(w, h, theme, title, desc)
            fn(c)
            (OUT / f"{name}{suffix}.svg").write_text(c.render(), encoding="utf-8")
            print(f"{name}{suffix}.svg")


if __name__ == "__main__":
    main()
