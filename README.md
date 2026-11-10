# ragsis

Plataforma B2B de RAG empresarial: convierte documentos internos en **respuestas verificables con citas**,
respetando permisos por tenant, workspace, grupo y documento. Implementación de las fases **F1 (Core SaaS)**,
la parte técnica de **F2 (calidad)** y **F3 multimodal (OCR, figuras, tablas, ecuaciones — RAG-04)** del
*Plan Maestro — Plataforma RAG Empresarial AWS* v1.0.

```
apps/
  web/              Next.js 16 (UX + BFF con cookie httpOnly)
  api/              TypeScript/Fastify · control plane, authZ, uploads, query API
services/
  rag-engine/       Python/FastAPI · query orchestrator (híbrido + RRF + rerank + verificación de citas)
  ingest-worker/    Python · SQS → validación → antimalware → parsing (+OCR, multimodal/VLM) → chunking → PII → embeddings → índice
  ai-gateway/       Python · ModelRegistry, política de residencia, fallback acotado, presupuestos
packages/
  ragsis-core/      Python · settings, BD con contexto RLS, token interno, utilidades de texto
  contracts/        OpenAPI v1
  policy/           Índice de pruebas de autorización
db/migrations/      Esquema + RLS forzada + funciones SECURITY DEFINER acotadas
infra/
  docker/           Compose local (Postgres+pgvector, SeaweedFS S3, ElasticMQ SQS, servicios)
  terraform/        Módulos AWS: network, security, storage, database, compute, edge, observability
ops/runbooks/       DLQ, reindex, restore, incidente cross-tenant, borrado, bootstrap de BD
eval/               Golden set, corpus de muestra y harness de métricas
docs/adr/           ADR-001…023
```

## Arranque local

Requisitos: Docker, `uv`, `pnpm` (Node 24+).

```bash
make up        # genera .env con secretos aleatorios y levanta el stack
make up-obs    # igual + Jaeger con trazas OpenTelemetry (UI http://localhost:16686)
```

- Web: http://localhost:3000 (login de desarrollo por email)
- API: http://localhost:4000 · contrato en `packages/contracts/openapi.yaml`

Por defecto todo corre **sin red ni credenciales** con el proveedor local determinista (ADR-010).
Para Bedrock: `AI_EMBEDDING_MODEL=bedrock-titan-embed-v2-1024@v1`, `AI_GENERATION_MODEL=bedrock-nova-lite@v1`
(o `bedrock-claude-sonnet-5-5@v1`) y credenciales AWS en el entorno de los contenedores.
Para on-prem/offline: modelos `ollama-*` con `OLLAMA_BASE_URL`.

**SSO (OIDC).** Con `AUTH_MODE=oidc`, `OIDC_ISSUER` y `OIDC_AUDIENCE` (= client_id) la web usa Authorization Code
+ PKCE y la API valida el `id_token`. Para probar sin IdP real: `make mock-oidc` (issuer `http://localhost:9000`,
client_id `ragsis-web`). En AWS se usa Cognito (Hosted UI) u otro IdP corporativo.

**Integraciones.** Admins crean claves `rsk_…` en *Gobierno* (o `POST /v1/organizations/{org}/api-keys`) con
scopes `query`, `documents:read`, `documents:write` y alcance por workspace.

**OCR.** `OCR_PROVIDER=textract` habilita OCR de PDFs escaneados e imágenes en AWS (respeta la política de datos del tenant).

**Multimodal (RAG-04, ADR-018).** Formatos: PDF, DOCX, PPTX, XLSX, PNG/JPEG, HTML, Markdown, TXT, CSV.
- Tablas (incluidos gráficos nativos de Office convertidos a tabla con sus cifras) y ecuaciones son chunks propios con
  página, bbox y caption; funcionan sin ningún modelo extra.
- Figuras: `AI_VISION_MODEL=bedrock-nova-lite@v1` (o `bedrock-claude-sonnet-5-5@v1`, u `ollama-qwen3-vl-8b@v1` para
  tenants restringidos/on-prem) las describe con contexto del documento y las guarda como activo S3 citable. Sin VLM,
  una figura se indexa solo si tiene caption o texto alternativo.
- `PARSER_PREFERENCE=docling` (con `docling` instalado en la imagen del worker) añade layout, tablas de PDF, fórmulas y
  bbox; `DOCLING_OCR=true` da OCR local sin red.
- Consulta: con un generador con visión, las imágenes de las figuras citadas se adjuntan al modelo (`RAG_VLM_ENHANCED`);
  el verificador de citas sigue exigiendo que toda cifra esté en el texto de la evidencia.

**GraphRAG (RAG-05, ADR-019).** Habilitado por plan (business/private) o por organización
(`PATCH /v1/organizations/{org}/settings {"graph_mode": "on"|"off"|"inherit"}`). La ingesta extrae entidades y
relaciones por chunk con `AI_GRAPH_MODEL` (por defecto `local-graph-heuristic@v1`, offline; o un LLM permitido por la
política del tenant). Toda entidad/relación es visible solo si el usuario puede leer al menos un chunk fuente, y sus
descripciones se arman solo con fuentes visibles. Consulta: `mode` = `auto|off|local|global|hybrid`; las citas siguen
siendo chunks. Backfill tras activarlo: `make reindex ARGS="--org <uuid> --mode graph"`.

**Reindexado.** `make reindex ARGS="--org <uuid> --mode embeddings --model <id> --dry-run"` (ver `ops/runbooks/reindex.md`).

## Onboarding y Agent Studio

El [ADR-020](docs/adr/README.md#adr-020--onboarding-sectorial-y-agent-studio-hitos-a-b-d-de-la-especificación-de-agentes) documenta el onboarding y Agent Studio. Al crear una organización la web abre
**Setup** (`/app/{org}/onboarding`): 9 pasos reanudables (sector, objetivos, documentos, privacidad, espacios, agentes
sugeridos, prueba controlada, activar). Las recomendaciones salen de presets deterministas por sector; activar no
publica agentes ni habilita acciones externas. La calificación comercial (sector, tamaño, comprador, usuarios iniciales, fuentes documentales, señales de dolor, canal de origen) se pregunta en la pantalla de alta, antes de entrar a la app, y produce un puntaje interno que la API no expone (ADR-021). **Agent Studio** (`/app/{org}/agents`) crea agentes desde plantillas o
en blanco, valida la definición contra la política del tenant, la prueba en sandbox (búsqueda real con tu ACL,
escrituras simuladas) y publica versiones semánticas inmutables.

**Workflows** (`/app/{org}/workflows`) encadenan agentes publicados con revisión humana, gates de aprobación y
condiciones; cada versión fija la versión de sus agentes. Los runs se inician con `Idempotency-Key`, se ejecutan con
los permisos de quien los inicia y esperan en el **Inbox** de quien tenga el rol funcional (asignado en *Gobierno →
Roles*). Una aprobación queda atada al hash de lo revisado y a las versiones de documento citadas; un rechazo
detiene el run. **Activity** muestra la línea de tiempo, decisiones y eventos de cada run.

**Ragsis Sign** (`/app/{org}/signatures`) permite crear sobres con PDF de la Biblioteca o generarlos desde un workflow.
Un segundo usuario con permiso aprueba el envío. Cada firmante revisa la copia fijada del documento, escribe su
nombre y acepta firmar con su cuenta verificada o mediante una invitación personal por email. Al finalizar, la app
genera un PDF con la hoja de firmas y un certificado de auditoría sellado con Ed25519. El verificador público
`/sign/verify` compara los archivos con las huellas registradas sin subirlos. Los enlaces compartidos y las
invitaciones externas respetan los dominios autorizados en *Gobierno → External sharing*.

En **Signatures → My signatures** puedes guardar hasta seis imágenes PNG o JPG y elegir una al firmar.
También puedes cargar una imagen para un solo sobre, incluso como invitado. La imagen queda incorporada
a la hoja final y el certificado registra su huella.

Si ya tienes el stack local levantado, actualiza la API y la web con
`docker compose -f infra/docker/compose.yml --env-file .env up -d --build --wait api web`.
Compose aplica la migración antes de iniciar la API. Los sobres del simulador siguen disponibles como historial.

Para enviar invitaciones y avisos de finalización en AWS, configura `signature_email_from` y
`signature_email_identity_arn` en Terraform con una identidad SES verificada en la región del API y con acceso de
producción. En una instalación directa, el API recibe `SIGNATURE_EMAIL_FROM`, credenciales con `ses:SendEmail` y
`PUBLIC_BASE_URL` con HTTPS. El modo de desarrollo ofrece enlaces de prueba al regenerar una invitación.

## Pruebas

```bash
make test      # pytest + vitest contra Postgres/S3 reales
make e2e       # stack completo: provisiona 2 tenants, ingesta corpus, evalúa golden set con metas
make tf-validate
```

Resultado actual del E2E (`eval/golden/sample.yaml`, 18 preguntas incl. tablas en PPTX/XLSX, proveedor local):

| Métrica | Valor | Meta piloto |
|---|---|---|
| answer accuracy | 1.00 | ≥ 0.85 |
| evidence hit rate | 1.00 | ≥ 0.85 |
| citation precision | 1.00 | ≥ 0.95 |
| abstention precision / recall | 1.00 / 1.00 | ≥ 0.90 |
| ACL leakage | 0 | 0 |

El golden set de muestra es sintético y pequeño; las metas deben medirse con 100–200 preguntas reales por vertical (F0/F2).

## Seguridad (resumen)

- Tenant resuelto **solo** por membresía verificada; nunca desde el cliente. No miembro → 404.
- RLS **forzada** en todas las tablas de cliente; ACL de documento aplicada en la BD antes del retrieval (ADR-008).
- Roles `ragsis_app` / `ragsis_worker` sin `BYPASSRLS`; token interno API→rag-engine de 60 s (ADR-009).
- Upload directo a S3 con URL prefirmada; cuarentena, magic bytes, MIME, cifrado, macros, ZIP bomb y ClamAV.
- Prompt con contenido documental delimitado y escapado; verificador de citas y cifras; abstención por defecto.
- Política de modelos por clasificación de datos: `restricted` nunca llama APIs externas; sin fallback silencioso a la nube.
- Auditoría con cadena de hashes por tenant; logs JSON con redacción; preguntas guardadas solo como SHA-256.

## Estado frente al Plan Maestro

| ID | Historia | Estado |
|---|---|---|
| SEC-01 | Aislamiento tenant end-to-end | ✅ tests negativos BD, retrieval, citas, S3 keys |
| DOC-01 | Upload y versionado seguro | ✅ |
| RAG-01 | Búsqueda semántica con citas + abstención | ✅ |
| RAG-02 | Híbrido + rerank | ✅ (RRF pgvector + FTS español; rerank por plan) |
| OBS-01 | Trazas y costo por tenant | ✅ OTel API→rag-engine→worker (W3C), query_runs con tokens/costo |
| OPS-01 | Resiliencia de ingesta | ✅ idempotencia, reintentos, DLQ, runbook |
| AUTH-02 | Roles y grupos por workspace | ✅ |
| RAG-03 | Reindex + deletion | ✅ dual-write de embeddings, full con swap atómico, purga, borrado verificable |
| API-01 | API v1 y claves de servicio | ✅ scopes, alcance por workspace, expiración, revocación, auditoría |
| AUTH-SSO | Login OIDC en la web | ✅ Authorization Code + PKCE, logout RP-initiated |
| RAG-04 | Tablas/figuras multimodales | ✅ PPTX/XLSX/imágenes, figuras con VLM + activo S3, gráficos→tabla, ecuaciones, bbox, VLM-enhanced; Docling opcional |
| RAG-05 | GraphRAG | ✅ Entidades/relaciones en Postgres con ACL derivada de los chunks (ADR-019), modos local/global/hybrid fusionados por RRF, multi-hop con citas a chunks; por plan u organización |
| P0-01/02 | Perfil sectorial + onboarding de 9 pasos | ✅ Presets deterministas versionados, máquina de estados reanudable, espacios y agentes draft sin sobrescribir (ADR-020) |
| P0-04/05 | Agent Studio + Policy Engine | ✅ Definición declarativa, deny-by-default, sandbox con retrieval real y escrituras simuladas, publicación atada a test, versiones inmutables, rollback |
| P1-01…04 | Runtime de agentes, workflows/HITL, Approval Inbox, delegación limitada, trazas de run | ✅ Runner durable en Postgres + outbox, aprobaciones atadas a hash/versión, separación de funciones, budget, Activity (ADR-022) |
| P2-01/02 | Firma electrónica y compartición controlada | ✅ Ragsis Sign, aprobaciones, invitaciones SES, PDF final, certificado sellado y verificación pública (ADR-024) |
| CON-01 | Conectores | ✅ Gmail (personal, solo su dueño), Slack y ClickUp (empresa → workspace); OAuth+PKCE, tokens AES-GCM, delta sync con cursor/lease/backoff, tombstones y borrado al desconectar (ADR-025). Pendiente: validar con apps OAuth reales |
| ENT-01/02, AGT-01 | Dedicado, offline, agentic | ⏳ P2/P3 |

Pendientes conocidos antes de producción: validar Textract y Bedrock (incl. visión de Nova/Claude) en la cuenta/región
AWS real (aquí se probaron con dobles de prueba), validar Docling y su OCR local en la imagen del worker,
medir el aporte de las descripciones VLM con el golden set real, refresh tokens de sesión, colector ADOT en
ECS, CloudFront, pentest de permisos, y los gates legales/privacidad de la checklist (sección 20).
