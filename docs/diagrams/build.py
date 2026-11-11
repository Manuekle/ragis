#!/usr/bin/env python3
"""Genera los diagramas de docs/diagrams/*.svg (variantes clara y oscura).

    python3 docs/diagrams/build.py

Edita las funciones de abajo y vuelve a ejecutar. Los iconos salen de docs/assets/icons
(ver docs/assets/icons/README.md para licencias y origen).
"""
from __future__ import annotations

from pathlib import Path

from lib import Canvas

OUT = Path(__file__).resolve().parent


def containers(c: Canvas) -> None:
    c.text(24, 36, "Ragsis · contenedores y flujo de datos", 17, 700)
    c.text(24, 56, "Mismos servicios en local (Docker Compose) y en AWS; solo cambian S3/SQS y el proveedor de identidad.", 11.5, 400, c.t["muted"])
    W, H = 170, 64
    c.node("users", 30, 90, W, H, "Personas", "navegador", "aws/users.svg", icon_size=30)
    c.node("web", 300, 90, W, H, "web", "Next.js · BFF\ncookie httpOnly", "tech/next-js.svg")
    c.node("api", 570, 90, W, H, "api", "Fastify · authZ\nuploads · consultas", "tech/fastify.svg", accent=True)
    c.node("rag", 840, 90, W, H, "rag-engine", "FastAPI · híbrido\n+ RRF + citas", "tech/fastapi.svg", accent=True)
    c.node("s3", 30, 270, W, H, "S3", "SeaweedFS en local\ndocumentos y figuras", "aws/s3.svg")
    c.node("sqs", 570, 270, W, H, "SQS", "ElasticMQ en local\ncola + DLQ", "aws/sqs.svg")
    c.node("pg", 840, 270, W, 64, "PostgreSQL", "pgvector · RLS forzada", "tech/postgresql.svg")
    c.node("worker", 570, 430, W, H, "ingest-worker", "Python · validar,\nparsear, embeber", "tech/python.svg", accent=True)
    c.node("clam", 570, 570, W, H, "ClamAV", "análisis antimalware", "aws/server.svg", icon_size=30)
    c.node("ocr", 840, 570, W, H, "Textract", "OCR (opcional)", "aws/textract.svg")
    # ai-gateway
    c.node("gw", 1110, 90, 170, 400, "ai-gateway", "ModelRegistry\npolítica de residencia\nfallback acotado\npresupuestos", "tech/python.svg")
    c.group(1100, 530, 190, 124, "Proveedores de modelos")
    for i, (ic, label) in enumerate([("aws/bedrock.svg", "Amazon Bedrock"), ("tech/ollama.svg", "Ollama (on-prem)"), ("tech/python.svg", "Local determinista")]):
        c.icon(ic, 1114, 556 + i * 31, 24)
        c.text(1148, 573 + i * 31, label, 11.5)

    P = c.pt
    c.edge([P("users", "r"), P("web", "l")], "HTTPS")
    c.edge([P("web", "r"), P("api", "l")], "id_token")
    c.edge([P("api", "r"), P("rag", "l")], "token 60 s")
    c.edge([P("rag", "r"), (1110, 122)], "modelos", label_at=(1060, 122))
    c.edge([P("users", "b", 0.5), P("s3", "t", 0.5)], "PUT prefirmado", dashed=True)
    c.edge([P("api", "b", 0.25), P("sqs", "t", 0.25)], "encola")
    c.edge([P("rag", "b", 0.5), P("pg", "t", 0.5)], "FTS + vector")
    c.edge([(720, 154), (720, 215), (880, 215), (880, 270)], "SQL con RLS", label_at=(800, 215))
    c.edge([P("sqs", "b", 0.25), P("worker", "t", 0.25)], "mensaje")
    c.edge([(570, 462), (115, 462), P("s3", "b", 0.5)], "lee y escribe objetos", label_at=(340, 462))
    c.edge([(740, 446), (910, 446), (910, 334)], "chunks + índice", label_at=(825, 446))
    c.edge([(740, 470), (1110, 470)], "embeddings · VLM", label_at=(980, 470))
    c.edge([P("worker", "b", 0.5), P("clam", "t", 0.5)], "escaneo")
    c.edge([(740, 486), (925, 486), P("ocr", "t", 0.5)], "OCR", label_at=(830, 486))
    c.edge([(1195, 490), (1195, 530)])
    c.text(24, 660, "Línea continua: llamada de servicio · punteada: acceso directo del navegador con URL prefirmada por la API.", 11, 400, c.t["muted"])


def aws_pilot(c: Canvas) -> None:
    c.text(24, 34, "Piloto en AWS · us-east-2 (Ohio)", 17, 700)
    c.node("users", 22, 266, 112, 60, "Personas", "", "aws/users.svg", icon_size=30)
    c.group(150, 48, 1090, 710, "Nube AWS · proyecto piloto", "aws/group-aws-cloud.svg", stroke="#232F3E")
    c.group(170, 88, 1050, 650, "Región us-east-2", "aws/group-region.svg", dashed=True, stroke="#00A4A6")
    c.group(190, 128, 640, 560, "VPC por defecto", "aws/group-vpc.svg", stroke="#8C4FFF")
    c.group(210, 168, 620, 500, "Subred pública", "aws/group-public-subnet.svg", stroke="#7AA116")
    c.group(330, 208, 480, 410, "EC2 · m7i-flex.large · Ubuntu 24.04 · gp3 30 GB cifrado", "aws/ec2.svg", stroke="#ED7100")
    c.node("eip", 216, 266, 108, 60, "IP fija", "elástica", "aws/elastic-ip.svg", icon_size=26)
    c.text(350, 258, "docker compose (infra/docker/compose.pilot.yml)", 10.5, 500, c.t["muted"])
    L, R, W, H = 350, 580, 210, 60
    c.node("caddy", L, 266, W, H, "caddy", "TLS automático · 80/443", None)
    c.node("web", L, 356, W, H, "web", "Next.js · login en la app", "tech/next-js.svg")
    c.node("api", L, 446, W, H, "api", "Fastify · authZ", "tech/fastify.svg", accent=True)
    c.node("rag", L, 536, W, H, "rag-engine", "FastAPI · consulta", "tech/fastapi.svg", accent=True)
    c.node("clam", R, 266, W, H, "clamav", "antimalware", "aws/server.svg", icon_size=26)
    c.node("worker", R, 356, W, H, "ingest-worker", "Python · ingesta", "tech/python.svg", accent=True)
    c.node("pg", R, 446, W, 150, "postgres", "pgvector · RLS\nvolumen en EBS", "tech/postgresql.svg")
    # servicios regionales
    X, SW = 880, 300
    c.node("cognito", X, 128, SW, 60, "Cognito", "cuentas invitadas · clave + reto", "aws/cognito.svg")
    c.node("s3", X, 208, SW, 60, "S3 documentos", "versionado · SSE-KMS · privado", "aws/s3.svg")
    c.node("sqs", X, 288, SW, 60, "SQS ingesta + DLQ", "cifrada con KMS", "aws/sqs.svg")
    c.node("kms", X, 368, SW, 60, "KMS", "rotación anual · S3, SQS y EBS", "aws/kms.svg")
    c.node("ecr", X, 448, SW, 60, "ECR privado", "4 repositorios · tags inmutables", "aws/ecr.svg")
    c.node("ssm", X, 528, SW, 60, "Systems Manager", "Session Manager · sin SSH", "aws/systems-manager.svg")
    c.node("iam", X, 608, SW, 60, "IAM · rol ragsis-pilot-ec2", "mínimo privilegio por recurso", "aws/iam.svg")

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
    c.text(24, 770, "El navegador solo habla con Caddy. Todo lo demás vive en la instancia o en servicios regionales administrados.", 11, 400, c.t["muted"])


def environments(c: Canvas) -> None:
    c.text(24, 36, "Tres entornos, una regla: primero Floci, después AWS", 17, 700)
    cols = [
        (24, "1 · Local", "tech/docker.svg", "make up · Docker Compose",
         [("tech/postgresql.svg", "Postgres + pgvector"), ("aws/s3.svg", "SeaweedFS (API S3)"), ("aws/sqs.svg", "ElasticMQ (API SQS)"),
          ("tech/python.svg", "servicios Python y Fastify"), ("tech/next-js.svg", "web con login de desarrollo")]),
        (464, "2 · Ensayo en Floci", "aws/server.svg", "make rehearse · Terraform → localhost:4566",
         [("aws/ec2.svg", "EC2 como contenedor Docker"), ("aws/s3.svg", "S3, SQS, KMS, SSM"), ("aws/cognito.svg", "Cognito e IAM"),
          ("aws/ecr.svg", "ECR y recursos de red"), ("tech/terraform.svg", "los mismos módulos del piloto")]),
        (904, "3 · AWS real", "aws/group-aws-cloud.svg", "terraform apply · perfil ragsis-pilot",
         [("aws/ec2.svg", "EC2 m7i-flex.large + EBS"), ("aws/s3.svg", "S3, SQS, KMS, ECR"), ("aws/cognito.svg", "Cognito (cuentas invitadas)"),
          ("aws/systems-manager.svg", "Session Manager"), ("tech/terraform.svg", "mismos módulos · plan FREE")]),
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
    c.edge([(354, 235), (464, 235)], "mismos módulos\nTerraform", color=c.t["accent"], label_at=(409, 235))
    c.edge([(794, 235), (904, 235)], "solo si el\nensayo pasa", color=c.t["accent"], label_at=(849, 235))
    c.add(f'<rect x="24" y="430" width="1210" height="70" rx="10" fill="{c.t["accent_soft"]}" stroke="{c.t["accent"]}" stroke-width="1.3"/>')
    c.text(44, 458, "Regla de trabajo", 13, 700, c.t["accent"])
    c.text(44, 480, "Toda infraestructura o cambio de AWS se crea primero en Floci con scripts/aws-rehearsal.sh. Solo con el ensayo limpio se aplica en AWS real.", 12.5)


def ingest(c: Canvas) -> None:
    c.text(24, 36, "Ingesta de un documento", 17, 700)
    W, H = 212, 96
    xs = [30 + i * 242 for i in range(5)]
    row1 = [
        ("aws/s3.svg", "1 · Subida prefirmada", "El navegador sube el archivo\na cuarentena en S3"),
        ("tech/fastify.svg", "2 · Registro", "La API crea versión y job en\nPostgres y encola en SQS"),
        ("tech/python.svg", "3 · Validación", "Magic bytes, MIME, macros,\nZIP bomb y límites"),
        ("aws/server.svg", "4 · Antimalware", "ClamAV analiza el objeto;\nmalware = rechazado"),
        ("aws/textract.svg", "5 · Parseo y OCR", "Parser nativo o Docling;\nOCR para escaneados"),
    ]
    row2 = [
        ("aws/bedrock.svg", "6 · Multimodal", "Figuras (VLM), tablas,\necuaciones con bbox"),
        ("tech/python.svg", "7 · Chunking y PII", "Fragmentos con página;\nredacción de PII"),
        ("aws/bedrock.svg", "8 · Embeddings", "Vía ai-gateway con política\nde residencia del tenant"),
        ("tech/postgresql.svg", "9 · Índice", "pgvector + FTS + grafo\ncon ACL del documento"),
        ("aws/documents.svg", "10 · Listo", "Estado indexed; evento\nde auditoría"),
    ]
    for i, (ic, t, s) in enumerate(row1):
        c.node(f"a{i}", xs[i], 70, W, H, t, s, ic, accent=(i == 2))
    for i, (ic, t, s) in enumerate(row2):
        c.node(f"b{i}", xs[i], 250, W, H, t, s, ic, accent=(i == 3))
    for i in range(4):
        c.edge([c.pt(f"a{i}", "r"), c.pt(f"a{i+1}", "l")])
        c.edge([c.pt(f"b{i}", "r"), c.pt(f"b{i+1}", "l")])
    c.edge([c.pt("a4", "b", 0.5), (xs[4] + W / 2, 200), (xs[0] + W / 2, 200), c.pt("b0", "t", 0.5)], "", label_at=(640, 200))
    c.node("err", 30, 400, 1180, 64, "Errores", "Definitivos (archivo inválido, malware, política, límite de páginas) → failed / rejected sin reintento.  Transitorios (BD, S3, modelo, ClamAV) → reintentos y DLQ tras 4 recepciones.", "aws/sqs.svg", icon_size=28)
    c.text(24, 490, "El procesamiento es idempotente por job y versión. Reindexar reutiliza los originales de S3 (runbook reindex.md).", 11, 400, c.t["muted"])


def query(c: Canvas) -> None:
    c.text(24, 36, "Consulta con citas verificables", 17, 700)
    W, H = 212, 96
    xs = [30 + i * 242 for i in range(5)]
    row1 = [
        ("aws/users.svg", "1 · Pregunta", "Desde la web o con una\nclave de servicio rsk_…"),
        ("tech/fastify.svg", "2 · Tenant y rol", "Membresía verificada;\nnunca desde el cliente"),
        ("tech/fastify.svg", "3 · Token interno", "JWT de 60 s hacia\nrag-engine (ADR-009)"),
        ("tech/postgresql.svg", "4 · Recuperación", "FTS español + pgvector\ncon ACL aplicada en SQL"),
        ("tech/fastapi.svg", "5 · Fusión", "RRF y rerank según plan;\ngrafo si está activo"),
    ]
    row2 = [
        ("aws/bedrock.svg", "6 · Generación", "Prompt con evidencia\ndelimitada y escapada"),
        ("tech/fastapi.svg", "7 · Verificador", "Cada cita y cada cifra deben\nestar en el texto citado"),
        ("tech/postgresql.svg", "8 · Registro", "query_run con tokens y costo;\nla pregunta, solo su SHA-256"),
        ("aws/documents.svg", "9 · Respuesta", "Texto con citas o\nabstención explícita"),
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
    c.node("gate", 30, 396, 454, 64, "Política de modelos", "restricted nunca llama a APIs externas; sin fallback silencioso a la nube", "aws/iam.svg", icon_size=28)
    c.edge([c.pt("b0", "b", 0.5), c.pt("gate", "t", 0.23)], "aplica", dashed=True)
    c.text(24, 490, "Si la evidencia no alcanza, el sistema se abstiene en lugar de inventar. Las métricas del piloto (exactitud, citas, fuga de ACL = 0) salen de make e2e.", 11, 400, c.t["muted"])


def auth(c: Canvas) -> None:
    c.text(24, 36, "Inicio de sesión dentro de la app (Cognito solo guarda las cuentas)", 17, 700)
    xs = {"br": 130, "web": 400, "cog": 700, "api": 1000}
    heads = [("br", "Navegador", "aws/users.svg", "página /login de Ragsis"), ("web", "web", "tech/next-js.svg", "BFF · /api/auth/password"),
             ("cog", "Cognito", "aws/cognito.svg", "InitiateAuth (cliente público)"), ("api", "api", "tech/fastify.svg", "valida id_token (JWKS)")]
    for k, t, ic, s in heads:
        c.node(k, xs[k] - 100, 66, 200, 64, t, s, ic, icon_size=30)
        c.add(f'<line x1="{xs[k]}" y1="130" x2="{xs[k]}" y2="520" stroke="{c.t["group_stroke"]}" stroke-width="1.3" stroke-dasharray="4 5"/>')
    msgs = [
        ("br", "web", 170, "POST email + clave", False),
        ("web", "cog", 210, "USER_PASSWORD_AUTH (HTTPS)", False),
        ("cog", "web", 250, "id_token  ·  o reto NEW_PASSWORD_REQUIRED", True),
        ("web", "br", 290, "Set-Cookie ragsis_session (httpOnly)", True),
        ("br", "web", 340, "GET /app  (cookie)", False),
        ("web", "api", 380, "Authorization: Bearer id_token", False),
        ("api", "cog", 420, "claves públicas (JWKS), una vez por hora", True),
        ("api", "web", 460, "datos del tenant, según membresía y rol", True),
    ]
    for i, (a, b, y, label, dashed) in enumerate(msgs):
        c.edge([(xs[a], y), (xs[b], y)], label, dashed=dashed, label_at=((xs[a] + xs[b]) / 2, y - 12))
        c.step(xs[a] + (18 if xs[b] > xs[a] else -18), y, i + 1)
    c.text(24, 556, "El id_token nunca llega a JavaScript: vive en una cookie httpOnly. «¿Olvidaste tu clave?» usa ForgotPassword; el código llega por correo.", 11, 400, c.t["muted"])


DIAGRAMS = {
    "containers": (containers, 1310, 690, "Contenedores de Ragsis", "Web, API, motor RAG, worker de ingesta, Postgres, S3, SQS y proveedores de modelos y sus conexiones."),
    "aws-pilot": (aws_pilot, 1260, 790, "Piloto en AWS", "Una instancia EC2 con Docker Compose detrás de una IP elástica, más S3, SQS, KMS, ECR, Cognito y Systems Manager en us-east-2."),
    "environments": (environments, 1260, 524, "Entornos", "Local con Docker Compose, ensayo en Floci y AWS real, con la regla de ensayar primero en Floci."),
    "ingest": (ingest, 1240, 510, "Pipeline de ingesta", "Diez pasos desde la subida prefirmada hasta el documento indexado."),
    "query": (query, 1240, 510, "Flujo de consulta", "Nueve pasos desde la pregunta hasta la respuesta con citas verificadas."),
    "auth": (auth, 1180, 580, "Flujo de inicio de sesión", "El formulario de login vive en la web y habla con Cognito desde el servidor; la sesión es una cookie httpOnly."),
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
