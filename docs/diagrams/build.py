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
    c.text(24, 36, "Ragsis · containers and data flow", 17, 700)
    c.text(24, 56, "Same services locally (Docker Compose) and on AWS; only S3/SQS and the identity provider change.", 11.5, 400, c.t["muted"])
    W, H = 170, 64
    c.node("users", 30, 90, W, H, "People", "browser", "aws/users.svg", icon_size=30)
    c.node("web", 300, 90, W, H, "web", "Next.js · BFF\ncookie httpOnly", "tech/next-js.svg")
    c.node("api", 570, 90, W, H, "api", "Fastify · authZ\nuploads · queries", "tech/fastify.svg", accent=True)
    c.node("rag", 840, 90, W, H, "rag-engine", "FastAPI · hybrid\n+ RRF + citations", "tech/fastapi.svg", accent=True)
    c.node("s3", 30, 270, W, H, "S3", "SeaweedFS locally\ndocuments and figures", "aws/s3.svg")
    c.node("sqs", 570, 270, W, H, "SQS", "ElasticMQ locally\nqueue + DLQ", "aws/sqs.svg")
    c.node("pg", 840, 270, W, 64, "PostgreSQL", "pgvector · forced RLS", "tech/postgresql.svg")
    c.node("worker", 570, 430, W, H, "ingest-worker", "Python · validate,\nparse, embed", "tech/python.svg", accent=True)
    c.node("clam", 570, 570, W, H, "ClamAV", "antimalware scan", "aws/server.svg", icon_size=30)
    c.node("ocr", 840, 570, W, H, "Textract", "OCR (optional)", "aws/textract.svg")
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
    c.edge([(740, 486), (925, 486), P("ocr", "t", 0.5)], "OCR", label_at=(830, 486))
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
    c.text(24, 36, "Three environments, one rule: Floci first, then AWS", 17, 700)
    cols = [
        (24, "1 · Local", "tech/docker.svg", "make up · Docker Compose",
         [("tech/postgresql.svg", "Postgres + pgvector"), ("aws/s3.svg", "SeaweedFS (S3 API)"), ("aws/sqs.svg", "ElasticMQ (SQS API)"),
          ("tech/python.svg", "Python and Fastify services"), ("tech/next-js.svg", "web with development login")]),
        (464, "2 · Rehearsal in Floci", "aws/server.svg", "make rehearse · Terraform → localhost:4566",
         [("aws/ec2.svg", "EC2 as a Docker container"), ("aws/s3.svg", "S3, SQS, KMS, SSM"), ("aws/cognito.svg", "Cognito and IAM"),
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
    c.text(44, 480, "All AWS infrastructure and changes are created first in Floci with scripts/aws-rehearsal.sh. Only after a clean rehearsal are they applied to real AWS.", 12.5)


def ingest(c: Canvas) -> None:
    c.text(24, 36, "Ingesting a document", 17, 700)
    W, H = 212, 96
    xs = [30 + i * 242 for i in range(5)]
    row1 = [
        ("aws/s3.svg", "1 · Presigned upload", "The browser uploads the file\nto quarantine in S3"),
        ("tech/fastify.svg", "2 · Record", "API saves version + job in\nPostgres, enqueues to SQS"),
        ("tech/python.svg", "3 · Validation", "Magic bytes, MIME, macros,\nZIP bomb and limits"),
        ("aws/server.svg", "4 · Antimalware", "ClamAV scans the object;\nmalware = rejected"),
        ("aws/textract.svg", "5 · Parsing and OCR", "Native parser or Docling;\nOCR for scans"),
    ]
    row2 = [
        ("aws/bedrock.svg", "6 · Multimodal", "Figures (VLM), tables,\nequations with bbox"),
        ("tech/python.svg", "7 · Chunking and PII", "Fragments with page;\nPII redaction"),
        ("aws/bedrock.svg", "8 · Embeddings", "Via ai-gateway with the\ntenant's residency policy"),
        ("tech/postgresql.svg", "9 · Index", "pgvector + FTS + graph\nwith the document's ACL"),
        ("aws/documents.svg", "10 · Done", "Status indexed;\naudit event"),
    ]
    for i, (ic, t, s) in enumerate(row1):
        c.node(f"a{i}", xs[i], 70, W, H, t, s, ic, accent=(i == 2))
    for i, (ic, t, s) in enumerate(row2):
        c.node(f"b{i}", xs[i], 250, W, H, t, s, ic, accent=(i == 3))
    for i in range(4):
        c.edge([c.pt(f"a{i}", "r"), c.pt(f"a{i+1}", "l")])
        c.edge([c.pt(f"b{i}", "r"), c.pt(f"b{i+1}", "l")])
    c.edge([c.pt("a4", "b", 0.5), (xs[4] + W / 2, 200), (xs[0] + W / 2, 200), c.pt("b0", "t", 0.5)], "", label_at=(640, 200))
    c.node("err", 30, 400, 1180, 64, "Errors", "Permanent (invalid file, malware, policy, page limit) → failed / rejected with no retry.  Transient (DB, S3, model, ClamAV) → retries and DLQ after 4 receives.", "aws/sqs.svg", icon_size=28)
    c.text(24, 490, "Processing is idempotent per job and version. Reindexing reuses the originals in S3 (runbook reindex.md).", 11, 400, c.t["muted"])


def query(c: Canvas) -> None:
    c.text(24, 36, "Query with verifiable citations", 17, 700)
    W, H = 212, 96
    xs = [30 + i * 242 for i in range(5)]
    row1 = [
        ("aws/users.svg", "1 · Question", "From the web or with a\nservice key rsk_…"),
        ("tech/fastify.svg", "2 · Tenant and role", "Verified membership;\nnever from the client"),
        ("tech/fastify.svg", "3 · Internal token", "60 s JWT to the\nrag-engine (ADR-009)"),
        ("tech/postgresql.svg", "4 · Retrieval", "Spanish FTS + pgvector\nwith ACL applied in SQL"),
        ("tech/fastapi.svg", "5 · Fusion", "RRF and rerank per plan;\ngraph if active"),
    ]
    row2 = [
        ("aws/bedrock.svg", "6 · Generation", "Prompt with delimited\nand escaped evidence"),
        ("tech/fastapi.svg", "7 · Verifier", "Each citation and figure\nmust be in the cited text"),
        ("tech/postgresql.svg", "8 · Record", "query_run: tokens + cost;\nquestion stored as a SHA-256"),
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
    heads = [("br", "Browser", "aws/users.svg", "Ragsis /login page"), ("web", "web", "tech/next-js.svg", "BFF · /api/auth/password"),
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
    "containers": (containers, 1310, 690, "Ragsis containers", "Web, API, RAG engine, ingestion worker, Postgres, S3, SQS and model providers, and their connections."),
    "aws-pilot": (aws_pilot, 1260, 790, "Pilot on AWS", "One EC2 instance running Docker Compose behind an Elastic IP, plus S3, SQS, KMS, ECR, Cognito and Systems Manager in us-east-2."),
    "environments": (environments, 1260, 524, "Environments", "Local with Docker Compose, rehearsal in Floci and real AWS, with the rule of rehearsing in Floci first."),
    "ingest": (ingest, 1240, 510, "Ingestion pipeline", "Ten steps from the presigned upload to the indexed document."),
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
