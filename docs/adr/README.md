# Registro de decisiones (ADR)

Las ADR-001 a ADR-007 vienen del Plan Maestro (sección 17). Las ADR-008+ documentan decisiones
tomadas durante la implementación de F1/F2.

| ADR | Decisión | Motivo | Revisar cuando… |
|---|---|---|---|
| 001 | ECS Fargate > EKS en MVP | Menor complejidad operativa | Se necesite scheduling especializado / GPU a escala |
| 002 | RDS PostgreSQL + pgvector | Una BD, ACL transaccional, RLS | Corpus/QPS supere benchmark (HNSW saturado) |
| 003 | Bedrock vía AI Gateway propio | Multi-modelo, gobierno de IA | Costo/latencia o residencia lo exijan |
| 004 | Motor RAG detrás de adapter | Evitar lock-in con RAG-Anything/LightRAG | Migración de framework |
| 005 | GraphRAG no por defecto | Costo de mantener relaciones | Multi-hop supere híbrido en golden set |
| 006 | Pool seguro; dedicated premium | Economías de escala | Requisitos regulatorios / no-isolation |
| 007 | Read-only retrieval en MVP | Riesgo de agentes con herramientas | Exista control de permisos y aprobación |

## ADR-008 · ACL aplicada en la base de datos, no solo en la app

**Decisión.** Toda tabla con datos de cliente tiene RLS **forzada**. Para `ragsis_app` (API y
rag-engine) las políticas de `documents`, `document_versions`, `chunks` y `chunk_embeddings`
exigen tenant **y** un principal del usuario en `document_acl`. El worker (`ragsis_worker`) solo
tiene frontera de tenant. Ningún rol de aplicación tiene `BYPASSRLS`.

**Motivo.** Sección 05 del plan: "la segregación de datos no equivale a autorización fuerte".
Un bug en un `WHERE` de la app no puede filtrar documentos entre tenants ni dentro del tenant.
El retrieval además filtra por principals explícitamente (defensa en profundidad).

**Consecuencia.** Agregados tenant-wide (cuotas) usan funciones `SECURITY DEFINER` que solo
devuelven números del tenant activo (`app.tenant_corpus_stats`).

## ADR-009 · Token interno API → rag-engine

**Decisión.** La API resuelve identidad, membresía, tenant y principals, y emite un JWT HS256
de 60 s (`aud=ragsis-rag`). rag-engine no acepta tenant/principals de otra fuente.

**Revisar cuando** haya más servicios internos: migrar a mTLS de Service Connect o tokens
firmados con KMS (asimétricos).

## ADR-010 · Proveedor local determinista para desarrollo y on-prem mínimo

**Decisión.** El AI Gateway incluye `local-hash-1024@v1` (embeddings por feature hashing),
`local-extractive@v1` (respuesta extractiva con citas) y `local-lexical-rerank@v1`.

**Motivo.** Permite correr todo el sistema, los tests y la evaluación sin red, sin GPU ni
credenciales, y ofrece una ruta 100 % offline. **No es semántico**: en producción se usa
Bedrock (Titan v2 / Cohere multilingual, Nova/Claude) u Ollama (BGE-M3, Qwen3).

**Consecuencia.** Todos los modelos de embeddings admitidos producen 1024 dimensiones;
`model_version` separa espacios vectoriales y nunca se mezclan (sin fallback de embeddings).

## ADR-011 · Claude en Bedrock vía SDK oficial de Anthropic

**Decisión.** Modelos Claude en Bedrock se invocan con `AnthropicBedrockMantle` (SDK
`anthropic`); Nova y embeddings vía `bedrock-runtime` (Converse / InvokeModel).
Rechazos (`stop_reason=refusal`) activan el fallback del gateway **solo** a modelos permitidos
por la política del tenant; si no queda ninguno, la consulta se abstiene.

## ADR-012 · SeaweedFS como S3 local

**Decisión.** MinIO dejó de publicar imágenes comunitarias; el entorno local usa SeaweedFS
(S3 compatible, URLs prefirmadas y CORS). En AWS se usa S3 real (módulo `storage`).

## ADR-013 · Chunking y tokenización sin tiktoken

**Decisión.** Estimación de tokens por palabras/caracteres (conservadora) para chunking y
presupuestos; el conteo exacto lo reporta el proveedor. Evita depender de la caché de tiktoken
en despliegues desconectados (riesgo listado en la sección 03).

## ADR-014 · Claves de API de servicio (API-01)

**Decisión.** Formato `rsk_<prefijo>_<secreto>`; en BD solo prefijo + SHA-256 del secreto. Cada clave tiene
scopes (`query`, `documents:read`, `documents:write` ⊇ read), lista de workspaces, expiración (≤ 365 días) y
revocación inmediata. Se resuelve con `app.resolve_api_key` (SECURITY DEFINER) antes de conocer el tenant y
actúa como un usuario de servicio (`users.identity_provider='ragsis-apikey'`) con principals solo de sus
workspaces: nunca ve documentos restringidos a grupos. Las rutas declaran `config.scopes`; sin scopes la ruta
no acepta claves (administración, miembros, auditoría, creación de claves).

## ADR-015 · Login web OIDC en el BFF (Authorization Code + PKCE)

**Decisión.** El BFF Next.js ejecuta el flujo (state, nonce, PKCE S256), verifica el `id_token` con el JWKS del
IdP (issuer, audiencia = client_id, nonce) y lo guarda en cookie httpOnly; el navegador nunca ve tokens. La API
revalida el mismo `id_token` en cada llamada y exige `email_verified` y `token_use=id` (Cognito).
Logout RP-initiated vía `end_session_endpoint` si el IdP lo publica. `apps/api/src/scripts/mock-oidc.ts`
emula un IdP para desarrollo y pruebas.

**Revisar cuando** se requieran sesiones largas: agregar refresh tokens cifrados server-side.

## ADR-016 · OCR con Amazon Textract como primera ruta multimodal (F3)

**Decisión.** Páginas con < 40 caracteres de texto digital se envían a Textract asíncrono sobre el objeto S3
existente. Quality gate: líneas con confianza < 60 se descartan; se guardan proveedor y confianza media por
versión y se contabilizan `ocr_pages`. Textract es un servicio cloud registrado en `ModelRegistry`
(`aws-textract@v1`): la política de datos del tenant decide (restringido = nunca). Sin OCR habilitado, un PDF
mayoritariamente escaneado falla con `ocr_required` en vez de indexarse vacío.

**Revisar cuando** se necesite OCR offline (Docling/PaddleOCR en worker GPU) o tablas/figuras (RAG-04).

## ADR-017 · Trazas OpenTelemetry manuales

**Decisión.** Instrumentación manual (sin auto-instrumentación de módulos ESM): span por request en la API con
ruta plantilla, spans por etapa en rag-engine (`rag.embed/retrieve/rerank/generate/verify/persist`) y por job en
el worker. Propagación W3C: API → rag-engine por header y API → worker por campo `traceparent` del mensaje SQS.
Atributos solo pseudónimos (UUIDs, modelos, conteos); prueba automática verifica ausencia de texto y emails.
Exportación OTLP/HTTP solo si `OTEL_EXPORTER_OTLP_ENDPOINT` está definido (local: Jaeger; AWS: ADOT collector).

## ADR-018 · Contenido multimodal (RAG-04) dentro del pipeline propio, no con RAG-Anything

**Decisión.** Se toman las ideas de RAG-Anything (lista de bloques tipados texto/figura/tabla/ecuación con página,
bbox y caption; procesadores por modalidad; contexto del documento al describir figuras; consulta VLM-enhanced)
pero se implementan en el pipeline existente, no como dependencia: su almacenamiento es LightRAG, fuera de
pgvector y de las RLS/ACL (ADR-004, ADR-008).

- **Parsers nativos sin dependencias**: DOCX (figuras + texto alternativo, gráficos nativos, ecuaciones OMML,
  captions), PPTX (diapositiva = página, bbox de imágenes/tablas, gráficos, notas del orador), XLSX (hojas
  visibles, fechas y porcentajes según estilo), PNG/JPEG como documento e imágenes JPEG/PNG de PDFs digitales.
  Los gráficos nativos de Office se convierten a **tabla con las cifras de su caché**: números exactos y
  citables sin VLM. Destinos externos de relaciones OOXML nunca se resuelven (SSRF).
- **Docling opcional** (`PARSER_PREFERENCE=docling`, paquete `docling` instalado en la imagen del worker): layout, estructura de tablas, fórmulas y
  figuras con bbox. Si falla o no está instalado se usa el parser nativo con advertencia. Su OCR es local
  (`DOCLING_OCR=true`): ruta de OCR offline para tenants `restricted`. MinerU no se adopta por su licencia (AGPL)
  en un SaaS; revisar si cambia.
- **Figuras**: filtro por tamaño mínimo, duplicados (SHA-256), tope por documento y límite de píxeles (bombas);
  descripción con el VLM de `AI_VISION_MODEL` filtrado por la política del tenant (sin VLM permitido → solo
  caption/alt text; nunca se envía una imagen de un tenant restringido a la nube). La imagen se guarda en
  `tenants/<org>/assets/<doc>/<ver>/<sha>.<ext>` (CHECK en BD impide salir del prefijo del tenant); el borrado
  purga el prefijo. Un reindexado full reutiliza descripciones por SHA-256.
- **Tablas**: resumen opcional (`INGEST_TABLE_SUMMARIES`) cuyas oraciones con cifras que no estén en la tabla se
  descartan antes de indexar.
- **Consulta VLM-enhanced** (`RAG_VLM_ENHANCED=auto`): si el generador tiene visión, se adjuntan (máx. 3) las
  imágenes de figuras **ya seleccionadas como evidencia** —autorizadas por RLS + ACL—, etiquetadas con su [n].
  El verificador de citas **no se relaja**: toda cifra de la respuesta debe estar en el texto de la evidencia
  (descripción incluida); lo que el modelo lea solo en la imagen y no esté en el texto se descarta.
- **Transparencia**: las citas exponen `kind`, `bbox`, `caption`, `has_asset` y `ai_generated`; la web marca la
  evidencia generada por IA y muestra la figura con URL firmada corta (`GET /chunks/{chunk}/asset`, auditada).

**Revisar cuando** el golden set real (F0/F2) mida el aporte de la descripción VLM frente a solo caption, o se
necesite bbox de figuras en PDF sin Docling (requiere interpretar el content stream).

## ADR-019 · GraphRAG (RAG-05) dentro de Postgres con ACL derivada de los chunks

**Contexto.** ADR-005 deja GraphRAG fuera por defecto; ADR-004/018 descartan LightRAG/RAG-Anything como
dependencia porque su grafo y sus resúmenes viven fuera de pgvector y de las RLS/ACL. El riesgo propio de un grafo
es la **fuga entre documentos con ACL distinta**: una entidad o un resumen global construido con el documento A
(público) y el B (restringido) revela B a quien solo puede leer A.

**Decisión.** Se toman las ideas de LightRAG (extracción de entidades/relaciones por chunk, modos local/global/
hybrid) y se implementan en Postgres (`db/migrations/0005_graphrag.sql`) bajo este modelo de ACL:

- **Procedencia obligatoria.** `entities` y `relations` guardan solo su clave (`normalized_name`; par de extremos),
  función determinista de cualquiera de sus menciones. Nombre visible, tipo, descripción, keywords y peso viven en
  `entity_sources` / `relation_sources`: una fila por chunk fuente con el `document_id` del chunk. Un trigger
  impide atar una procedencia a un documento/tenant/workspace distinto del de su chunk.
- **Visibilidad derivada.** RLS forzada en las 4 tablas. Una fuente es visible si el usuario puede leer el
  documento de su chunk (misma regla que `chunks`); una entidad/relación es visible solo si tiene **al menos una
  fuente visible** (EXISTS explícito contra `document_acl`, sin depender de RLS anidada). El worker ve por tenant;
  `ragsis_app` solo lee.
- **Nada global.** No hay descripciones fusionadas, resúmenes de comunidad ni grados precomputados. Todo lo
  servible —nombre mostrado, descripción agregada, puntajes, grado de vecinos, nombres puente— se calcula en la
  consulta solo con fuentes visibles para ese usuario. Una entidad compartida entre A y B, vista por un lector de A,
  solo muestra menciones de A.
- **Borrado.** Las fuentes caen en cascada con su chunk (borrado, reindexado full, fallo); el worker recolecta
  las claves huérfanas (ya invisibles) en el mismo commit.
- **Extracción** (`ragsis_ingest/graph.py`) tras el chunking, un `AIGateway.generate` por chunk (texto/tabla)
  con `AI_GRAPH_MODEL` y la política del tenant: sin modelo permitido (p. ej. `restricted` con modelo cloud) o con
  el proveedor caído → sin grafo y advertencia en la auditoría (`graph_skipped_policy`), la ingesta sigue. Solo se
  aceptan menciones que aparecen literalmente en el chunk y relaciones entre ellas. `local-graph-heuristic@v1`
  (nombres propios y siglas) es la ruta determinista offline (ADR-010).
- **Consulta** (`retrieval.graph_search`): *local* = entidades que coinciden con la pregunta + relaciones y vecinos
  a 1 salto; *global* = relaciones que coinciden por keywords/descripción + sus extremos; *hybrid* = ambas. Cada
  lista de chunks entra al mismo RRF que vector + full-text y vuelve a pasar por todos los filtros (tenant,
  workspace, activo, versión vigente, ACL, `as_of`). Las **citas siguen siendo chunks** y el verificador no cambia.
- **Evidencia de salto.** Puente = entidad mencionada en la evidencia fuerte cuya mención visible (descripción de
  esa fuente) es la más pertinente a la pregunta sin estar ya nombrada en ella (máx. 3). Un chunk que llega solo
  por el grafo y no supera el umbral entra (máx. 2) únicamente si menciona un puente. Sin evidencia fuerte se
  abstiene igual que antes. Los nombres puente (`GenerationRequest.hints`) solo los usa el generador extractivo
  local para elegir la oración del segundo salto (debe compartir algún término con la pregunta); no entran al
  prompt de un LLM.
- **Habilitación.** `plans.graph_enabled` (team=false; business/private=true) con override
  `organizations.graph_mode` (`inherit|on|off`) vía `PATCH /v1/organizations/:org/settings` (admin, auditado). La
  API firma el claim `graph`; el cliente solo elige `mode` (`auto|off|local|global|hybrid`). Activarlo no
  reprocesa: backfill con `make reindex ARGS="--org <uuid> --mode graph"`.

**Pruebas.** `tests/python/test_graph_acl.py`: un usuario sin el grupo no ve entidades/relaciones/procedencia
derivadas solo del documento restringido (ni pidiéndolas por nombre), la entidad compartida solo agrega menciones
visibles, `graph_search` (3 modos) y los puentes nunca alcanzan sus chunks aunque la app pasara principals de más
(la RLS de sesión manda), la respuesta no filtra su contenido, aislamiento entre tenants y control positivo con el
grupo. Golden set: preguntas multi-hop (q19–q21, q23) y ACL multi-hop (q22); `multi_hop_accuracy` informativa.

**Revisar cuando** el golden set real mida multi-hop frente al híbrido (criterio de ADR-005), el costo de
extracción por LLM lo exija (cuotas por plan), o se necesite emparejar entidades por embeddings por fuente
(hoy coinciden por full-text) o desambiguación de homónimos.

## ADR-020 · Onboarding sectorial y Agent Studio (hitos A, B, D de la especificación de agentes)

**Contexto.** `Especificacion_Claude_Onboarding_Agentes_RAG.md` v1.0 pide onboarding adaptativo por sector y un
Agent Studio con agentes declarativos, versionados y con herramientas gobernadas, antes de workflows, firma y envío.
ADR-007 (retrieval read-only en el MVP) sigue vigente para todo lo que tenga efectos reales.

**Decisión.**
- **Mismo monolito, límites lógicos.** Rutas nuevas en la API Fastify (`routes/onboarding.ts`, `routes/agents.ts`);
  Policy Engine puro en `lib/policy.ts`; presets en `lib/presets.ts`; sandbox en `lib/agent-sandbox.ts`. Sin servicio
  `agent-runtime` todavía (P1-01): no hay planificador LLM ni acciones externas que lo justifiquen.
- **Datos** (`0006_onboarding_agent_studio.sql`): `organization_profiles`, `onboarding_sessions` (máquina
  `NOT_STARTED → PROFILE_STARTED → DATA_SOURCES → SECURITY → WORKSPACE_READY → PILOT_TESTED → COMPLETED`, más `PAUSED`
  y `NEEDS_REVIEW`), `agents` (draft mutable + `draft_hash`), `agent_versions` y `agent_test_runs`. RLS forzada por
  tenant en todas; versiones y pruebas son **append-only** para `ragsis_app` (solo `SELECT, INSERT`), y un trigger
  impide atar una versión/prueba a un agente de otro tenant.
- **Knowledge Spaces = workspaces existentes.** No se duplica el modelo: los espacios sugeridos se crean como
  workspaces con su ACL actual. El onboarding nunca sobrescribe espacios (match por nombre sin mayúsculas) ni agentes
  (match por slug).
- **Presets deterministas y versionados en código** (`legal-v1`, …): (sector + objetivos + sensibilidad + tipos de
  archivo + despliegue + plan) → espacios, perfil RAG, agentes sugeridos, política de modelo y avisos. El snapshot
  (`template_version` + recomendación) se guarda en la sesión. Sin LLM en este camino.
- **Política de datos.** El paso 5 solo **endurece** `organizations.data_class` (nunca la relaja); `restricted` +
  modelos cloud se rechaza. `restricted`, `local_only` u on-prem ⇒ agentes con perfil de modelo `local`.
- **Agentes declarativos** (`AgentConfig`, Zod estricto): identidad, instrucciones, conocimiento, perfil de modelo
  (no marca), allowlist de herramientas, autonomía (`suggest | draft_only | safe_execute | approval_required`),
  disparadores, límites y casos de prueba. Hash canónico (claves ordenadas) para atar pruebas y versiones.
- **Policy Engine deny-by-default.** Catálogo con riesgo y disponibilidad: firma, envío, email, borrado y cambio de
  ACL existen en el catálogo pero **no están disponibles** (fase F o prohibidas en el MVP) y nunca pasan validación.
  Conocimiento = intersección con los workspaces del diseñador (y del ejecutor en runtime), nunca ampliación.
  Instrucciones que piden ignorar políticas, saltar aprobaciones, firmar en nombre de alguien o conceder permisos se
  rechazan (heurística conservadora es/en). Solo disparador `manual` hasta workflows.
- **Sandbox.** `search_documents` se ejecuta de verdad por `runRagQuery` (la misma ruta gobernada que `/query`:
  cuota, rate limit, token interno con principals del usuario) sobre espacios efectivos; toda otra herramienta se
  simula (`mock`) y queda en la traza. El texto recuperado nunca decide herramientas ni argumentos. La pregunta se
  persiste solo como SHA-256 y la traza sin respuesta ni fragmentos.
- **Publicación.** Requiere validación sin errores y un test `passed` sobre el **hash exacto** del draft; versión
  semántica, changelog, diff de permisos (`permissions_expanded`) en la auditoría. Publica el owner del agente o un
  admin; `safe_execute` con escrituras exige admin. Rollback revalida contra la política vigente. Las denegaciones se
  auditan (`agent.publish` / `deny`) en una transacción que sí hace commit.
- **Roles.** Se mantienen `owner/admin/member/viewer`: admin ≈ Knowledge Manager/Admin; member ≈ Agent Designer
  (crea drafts propios); viewer solo lee agentes publicados. Reviewer/Approver/Signatory llegan con el hito E.

**Pruebas.** `apps/api/test/studio.test.ts` (22): reglas puras del Policy Engine y presets; flujo legal completo del
onboarding; caso 10 (Legal → Mixto propone sin sobrescribir); caso 3 (publicar sin test se deniega y audita; test;
1.0.0); escrituras simuladas; herramienta no disponible bloquea; caso 8 parcial (un miembro no amplía alcance y no hay
retrieval sobre espacios ajenos); visibilidad de drafts; viewer sin creación; rollback/pausa; inmutabilidad de
`agent_versions` en la BD.

**Revisar cuando** llegue el hito E (workflows durables + Approval Inbox + roles Reviewer/Approver), cuando un agente
necesite ejecutar fuera del sandbox (runtime P1-01 con presupuesto real y trazas por paso), o cuando la heurística de
instrucciones produzca falsos positivos medibles (sustituir por clasificador evaluado).

## ADR-021 · Calificación comercial en el alta (¿es buen cliente?)

**Contexto.** El onboarding de ADR-020 configura el producto, pero no dice si la organización encaja con el cliente
objetivo ni de dónde llegó. Perfil objetivo: 15–150 empleados, 500+ documentos, 5–30 usuarios iniciales, compra decidida
por gerencia con presupuesto, y señales de dolor (búsquedas repetidas, carpetas/servidores/SharePoint/Drive, información
confidencial, procesos con varias fuentes, pérdida medible).

**Decisión.**
- **Dónde vive cada cosa.** *Fuera de la app*, en la pantalla de alta (`/app`, antes de que exista el tenant): la
  calificación comercial, que es información sobre la empresa — sector, tamaño de equipo, quién decide la compra,
  usuarios iniciales, volumen documental, dónde viven los documentos, señales de dolor y canal de origen (Google,
  LinkedIn, Instagram, X, YouTube, Facebook, TikTok, WhatsApp, recomendación, evento). Viaja en
  `POST /v1/organizations` (`qualification`, validada con Zod estricto); el catálogo sectorial sale de
  `GET /v1/onboarding/catalog`. *Dentro de la app*, en Setup: configuración del producto — país/zona horaria, objetivos,
  tipos de documento, privacidad y residencia, espacios, agentes, prueba controlada y activación. El wizard interno ya
  no acepta ni pide campos comerciales.
- **Sin renumerar pasos.** Si el alta trae sector y tamaño, el paso 2 nace resuelto y la recomendación sectorial ya
  está calculada; el wizard salta al primer paso pendiente. El paso 2 sigue editable desde Setup.
- **Sector Logística** y, por sector, **enfoque RAG recomendado y despliegue probable** (`SectorTemplate.approach`,
  `.deployment`). Se muestran como sugerencia; **nunca se preselecciona** la privacidad. Lo aún no construido (SQL
  controlado, conectores operativos) se marca `planned`. «Cloud privado» y «cloud dedicado» comparten el valor
  `private_cloud`; solo cambia la etiqueta.
- **Puntaje determinista e interno** (`lib/lead-fit.ts`, 0–100, `strong ≥ 70`, `possible ≥ 40`, `weak`). Se recalcula en
  cada cambio de perfil y se guarda en `organization_profiles.lead_score/lead_tier` para operaciones. **La API no lo
  devuelve al cliente.** Un perfil sin respuestas comerciales queda sin calificar (`NULL`), no `weak`.
- **Cortes de tamaño** (`0009_team_size_bins.sql`): `1-14 / 15-50 / 51-150 / 151-500 / 500+`, alineados al rango 15–150. Los valores antiguos se reasignaron al corte más cercano (aproximado en los bordes).

**Revisar cuando** haya datos de conversión reales por canal y tier para recalibrar pesos y alinear los cortes de tamaño.

## ADR-022 · Workflows durables con human-in-the-loop (hito E de la especificación de agentes)

**Contexto.** Hito E (P1-02 runner + Approval Inbox, P1-03 delegación limitada, P1-04 trazas): encadenar agentes
publicados con revisión y aprobación humana, sin acciones externas todavía (firma/envío = hito F).

**Decisión.**
- **DSL declarativo** (`lib/workflow-dsl.ts`, Zod estricto): nodos `START | AGENT_TASK | HUMAN_REVIEW | APPROVAL_GATE |
  CONDITION | EXTERNAL_ACTION | WAIT_EVENT | END`, aristas `[from, to]` o `[cond, to, "true"|"false"]` y políticas.
  `deny_on_reject` y `no_external_action_without_approval` son literales `true` (no se pueden apagar). Validación pura:
  un START, DAG sin ciclos, todo alcanzable, una salida por paso (sin paralelismo en v1), condición con ramas
  true/false y fuente previa, agentes publicados y activos, máx. 3 hops por camino (configurable 1–5), toda acción
  externa precedida de un gate. `EXTERNAL_ACTION` y `WAIT_EVENT` existen en el DSL pero no validan hasta la fase F.
- **Versionado.** `workflows` (draft mutable) + `workflow_versions` inmutables; al publicar cada `AGENT_TASK` queda
  **fijado** a la versión publicada vigente del agente (`agent_version_id`): un run nunca cambia de agente a mitad.
- **Runner durable en Postgres** (`lib/workflow-runner.ts`). Cada transición se persiste con `pg_advisory_xact_lock`
  por run antes de la siguiente; los eventos (`WORKFLOW_RUN_STARTED`, `AGENT_RUN_STARTED/COMPLETED`,
  `APPROVAL_REQUESTED/DECIDED`, `WORKFLOW_COMPLETED/FAILED/CANCELLED`) salen por **outbox** en la misma transacción
  (esquema de la sección 14: `event_id`, `correlation_id`, `aggregate_id`, `schema_version`, hash del payload). Un
  `AGENT_TASK` marca `RUNNING`, ejecuta fuera de la transacción y vuelve a persistir; al arrancar la API,
  `resumePending()` (función `SECURITY DEFINER` que solo devuelve ids) reanuda runs a medias. Las esperas humanas no
  ocupan proceso (`WAITING_HUMAN`). En AWS esta clase es la costura para Step Functions Standard (callback de
  aprobación) o un consumidor SQS; el despacho del outbox a EventBridge es un adaptador pendiente.
- **Ejecución de agentes en runs** (`executeAgent`, compartido con el sandbox): permisos del **iniciador resueltos de
  nuevo en cada paso**; `search_documents` real con su ACL; las escrituras quedan como **propuestas sin efecto** (los
  efectos los autoriza un paso humano, nunca el agente). Reintentos con backoff solo para errores recuperables
  (RAG caído/limitado) hasta `max_retries` del agente, sin duplicar el paso ni el evento.
- **Delegación limitada.** El agente siguiente opera sobre (sus espacios ∩ acceso del iniciador) y solo recibe
  fragmentos de esos espacios (`context_received.citations_withheld`); sin espacios en común ⇒ `delegation_denied`
  sin retrieval. Presupuesto por run (`max_agent_calls`, `max_retrieval_calls`): agotado ⇒ `FAILED budget_exhausted`
  y aviso en el Inbox del iniciador.
- **Aprobaciones con binding.** `approvals.binding` = run, nodo, acción siguiente, propósito, `{document_id,
  version_id}` citados y hash de las salidas; `action_hash` = SHA-256 canónico. Decidir exige: rol funcional asignado,
  el **hash exacto** que la pantalla mostró, vigencia, que ninguna versión citada haya cambiado
  (`app.current_versions`, solo ids) y **separación de funciones** (el iniciador no aprueba su run; desactivable por
  workflow con aviso). Rechazo ⇒ `CANCELLED`, nada aguas abajo corre. Cambio de versión ⇒ `REVOKED` + `FAILED
  approval_invalidated`. Vencida ⇒ `EXPIRED` (perezoso al listar). Denegaciones auditadas con commit.
- **Roles funcionales** (`functional_roles`: reviewer, approver, signatory, auditor, agent_designer,
  knowledge_manager), asignados por admin en *Gobierno → Roles*, además del rol de organización.
- **Visibilidad y redacción.** Un run lo ven iniciador, admin, auditor o quien tiene una aprobación asignada por rol.
  Las salidas de agente se muestran solo si quien mira puede leer **todos** los documentos citados (RLS); si no,
  respuesta y fragmentos se ocultan y se informa cuántas citas.
- **Idempotencia.** `POST …/runs` exige `Idempotency-Key` (único por tenant); repetir devuelve el mismo run (200).

**Pruebas.** `apps/api/test/workflows.test.ts` (15): DSL (agente sin publicar, ciclo, fase F, hops, condición,
políticas fijas); roles; pin de versiones e idempotencia; flujo feliz con SoD, hash viejo y secuencia de eventos;
caso 4 (rechazo detiene); caso 5 (V2→V3 invalida); aprobador sin acceso ve la tarea pero no el contenido; caso 8
(delegación denegada sin retrieval + fragmentos retenidos); caso 9 (budget); reintento sin duplicar; agente pausado;
aislamiento e inmutabilidad de `workflow_versions`.

**Revisar cuando** haya más de una réplica de la API (lease por paso o Step Functions), llegue la fase F (gates
atados a `EXTERNAL_ACTION`, `WAIT_EVENT` con webhooks verificados) o se necesiten ramas paralelas.

## ADR-023 · Firma electrónica y distribución controlada (hito F de la especificación de agentes)

**Contexto.** P2-01 (adapter de firma) y P2-02 (compartición). Reglas de la especificación: la IA nunca firma ni
simula consentimiento; `SIGNED` solo por evento verificado del proveedor; aprobación atada a hash, versión,
destinatarios, acción y vigencia; acciones externas idempotentes; destinatarios en allowlist con caducidad y revocación.

**Decisión.**
- **Adapter `ESignProvider`** (`lib/esign.ts`): `createDraft / send / void / verify / parse / fetchEvidence`.
  - `docusign`: eSignature REST v2.1 con JWT grant (`jose`, RS256) y Connect con HMAC `X-DocuSign-Signature-*`;
    sobres creados con `status: "created"` (borrador) y enviados con `PUT status: "sent"`; evidencia = PDF combinado +
    certificado. Connect no trae id de evento: se deriva `sha256(envelopeId|event|generatedDateTime)`. **Escrito contra
    la documentación pública; pendiente de validar en una cuenta sandbox real.**
  - `local` (solo desarrollo, prohibido en producción): la ceremonia ocurre en la app — el firmante, autenticado con el
    email del sobre, escribe su nombre y consiente — y el proveedor emite el webhook firmado (HMAC + timestamp ±5 min)
    por **el mismo camino de verificación** que un proveedor real. El certificado registra firmantes, consentimiento, IP
    y hashes; el PDF no se estampa y se rotula como sin validez legal.
  - `disabled`: valor por defecto en producción sin configuración; los pasos de firma fallan con `esign_disabled`.
- **Nodos de workflow** (`EXTERNAL_ACTION`, `WAIT_EVENT SIGNATURE_COMPLETED`) ejecutados por el orquestador, nunca por un
  agente (los agentes con herramientas de firma/compartir solo proponen). Validación del grafo: `create_signature_draft`
  exige una revisión humana previa y es único por run; `send_signature_envelope`, `share_document` y `send_email` exigen
  un `APPROVAL_GATE` **inmediatamente antes**; el envío necesita un borrador previo y la espera un envío previo.
- **Binding de la acción.** El gate anterior a una acción externa incluye en su binding (y en el hash) el detalle de lo
  que autoriza: el sobre (id, firmantes, documentos con SHA-256) o los destinatarios normalizados, el artefacto (copia
  firmada o versiones aprobadas) y la caducidad. Al ejecutar se re-verifica: aprobación `APPROVED`, más reciente que
  `approval_max_age_hours`, coincidencia exacta con el sobre/destinatarios y versiones de documento vigentes (si
  cambiaron, el sobre se anula). Aprobar el envío exige MFA (`amr` del IdP) si el tenant lo pide.
- **Ciclo de vida por versión** (`document_lifecycle`): una revisión humana aprobada ⇒ `APPROVED`; envío ⇒
  `SIGNATURE_PENDING`; evento verificado de completado ⇒ `SIGNED`; compartir ⇒ `DISTRIBUTED`; rechazo/anulación del
  sobre ⇒ vuelve a `APPROVED`. Solo se prepara una firma sobre versiones `APPROVED`, leídas con la ACL del iniciador y
  con el SHA-256 verificado contra el registrado en la ingesta.
- **Webhooks** (`POST /v1/webhooks/signatures/:provider`, cuerpo crudo): HMAC antes de leer nada; sobre localizado por
  función `SECURITY DEFINER` que solo devuelve ids; `webhook_inbox (provider, event_id)` garantiza **un efecto por
  evento** (caso E2E 6); transiciones monótonas (`DRAFT < SENT < DELIVERED < COMPLETED|DECLINED|VOIDED`, terminales
  inmutables); la evidencia se descarga antes de consumir el evento (si falla, el proveedor reintenta). Un evento
  terminal reanuda o termina el run que espera (`signal`).
- **Compartición** (`shares`): un enlace por artefacto, token de 256 bits del que solo se guarda el SHA-256; el token no
  se registra: "Get link" **rota** el token y lo muestra una vez (iniciador/admin). Caducidad ≤ `share_max_days`,
  revocación inmediata, acceso público por función `SECURITY DEFINER` que valida y **audita cada intento**, y entrega
  una URL prefirmada de 60 s. Destinatarios solo de `allowed_domains` (exacto o subdominio; vacío bloquea todo),
  verificados al iniciar el run y otra vez al ejecutar (caso E2E 7, denegación auditada como `share.denied`); DLP:
  documentos `restricted` nunca salen.
- **Email** (`send_email`) sigue no disponible: el adapter SES añadiría una dependencia nueva (`@aws-sdk/client-sesv2`);
  hasta entonces el enlace se entrega manualmente desde *Signatures → Shared links*.

**Pruebas.** `apps/api/test/signatures.test.ts` (11): allowlist y HMAC/frescura; política solo admin y caso 7 al
iniciar; revisión ⇒ `APPROVED` ⇒ sobre `DRAFT` con gate atado al sobre; rol signatory y MFA; webhook falsificado o viejo
no cambia nada; ceremonia ⇒ webhook verificado ⇒ `COMPLETED` + certificado ⇒ el run continúa; caso 6 (repetición ⇒ un
efecto); distribución del documento firmado, rotación de token, revocación (410) y auditoría de accesos; caso 7 en
ejecución tras endurecer la política; anular un sobre termina el run.

**Revisar cuando** se valide DocuSign en sandbox (tabs de firma, Connect por cuenta, reconciliación periódica de sobres),
se necesite enviar email (SES + plantillas), o un tenant requiera firma digital cualificada por jurisdicción (eIDAS,
leyes locales): **revisión legal por país antes de ofrecerlo como servicio**.

## ADR-024 · Ragsis Sign

Ragsis gestiona la firma electrónica dentro de la app. La integración DocuSign del ADR-023 queda retirada.
Los sobres históricos conservan su proveedor y su evidencia. El simulador `ESIGN_PROVIDER=local` sigue
disponible en desarrollo para probar los webhooks del hito F.

- **Preparación y envío.** La app congela los bytes y el SHA-256 de cada PDF. Un signatory o admin distinto
  del autor aprueba los sobres manuales. Los sobres de workflow pasan por sus gates humanos. Se comprueba que
  las versiones sigan vigentes y se exige MFA para aprobar cuando la política del tenant lo indica.
- **Identidad.** Los miembros usan su cuenta con email verificado. Para externos, la allowlist y la clasificación
  se comprueban en cada acceso. La invitación se envía por SES, caduca en siete días y puede regenerarse. La
  regeneración invalida el token anterior. La anulación bloquea la ceremonia y las futuras descargas.
- **Cierre.** El bloqueo del sobre serializa las respuestas y la anulación. La última firma genera el PDF con una
  hoja de firmas y un certificado JSON con el consentimiento, el método de identificación, las fechas y las
  huellas de los documentos. El sello Ed25519 autentica el certificado de la plataforma. El estado y el evento
  del workflow se registran en la misma transacción. El certificado conserva el texto exacto de los nombres.
- **Verificación.** `/sign/verify` compara el PDF y el certificado opcional con sus huellas en Ragsis, sin
  transmitir los archivos. La consulta pública requiere el ID aleatorio del sobre y devuelve solo huellas,
  identificador de clave y fecha. El sello cubre el certificado adjunto al PDF como archivo separado.
- **Correo.** La cola de invitaciones en Postgres reintenta fallos de SES y envía un aviso cuando se completa
  el sobre. SES puede aceptar un correo antes de que el API registre el envío. Un reinicio en ese intervalo
  puede duplicar el aviso con el mismo enlace. La operación de firma permanece idempotente.

## ADR-025 · Conectores Gmail, Slack y ClickUp (CON-01)

**Contexto.** CON-01 pide traer al corpus fuentes vivas con delta sync, cursores, backoff, límites de tasa, tombstones y
permisos. Prioridad del usuario: Gmail, Slack y ClickUp, **indexados** (no herramientas en vivo). Gmail es correo
personal; Slack y ClickUp son espacios de empresa.

**Decisión.**
- **Cada elemento es un documento normal.** `source_id = con:<connector>:<item>`, versión nueva solo si cambia el SHA-256
  del contenido renderizado, y entrada por el pipeline existente (S3 + `ingestion_jobs` + SQS). Así heredan parsing,
  ACL por RLS, citas, versiones, cuotas del plan y borrado verificable. Granularidad: Gmail = hilo (sin texto citado) +
  un documento por adjunto admitido; Slack = canal × día UTC con los hilos dentro del mensaje que los abre; ClickUp =
  tarea (descripción + comentarios) y Doc (páginas en Markdown).
- **Permisos.** Gmail es `personal`: ACL `user:<dueño>`, `confidential`; ni los admins lo ven (RLS también oculta la
  conexión). Slack/ClickUp son `organization`: los conecta un admin para **un workspace** y la ACL es
  `workspace:<id>`. No se replican los permisos finos del origen: por eso los canales privados de Slack solo aparecen si
  el bot fue invitado y los espacios privados de ClickUp requieren selección explícita, con aviso en la UI. Se recomienda
  conectar ClickUp con una cuenta de servicio que solo vea lo que debe compartirse.
- **OAuth.** PKCE (Google) y `state` de un solo uso, 10 min, guardado como SHA-256 y ligado a persona + organización.
  Redirect único `<PUBLIC_BASE_URL>/connect/callback`: página de cliente que completa con la sesión (la cookie
  `SameSite=strict` no viaja en la navegación cross-site, sí en el fetch same-origin). Tokens cifrados AES-256-GCM con
  AAD `org:connector` (`CONNECTOR_ENCRYPTION_KEY`, obligatoria en producción; en dev se deriva con HKDF). Gmail usa
  solo `gmail.readonly`; Slack un bot con scopes de lectura; ClickUp no tiene scopes (lee lo que ve quien autoriza).
- **Planificador en la API** (como las invitaciones de firma): cada minuto `app.due_connectors()` (SECURITY DEFINER, solo
  IDs) → lease de 10 min en la fila (seguro con varias réplicas; `CONNECTOR_SYNC_ENABLED=false` lo apaga) → pasada
  acotada (4 min / 150 cambios) que guarda el cursor tras cada página. El trabajo corre con RLS del dueño y el principal
  de la ACL del conector. Errores: token revocado ⇒ `reconnect_needed`; 429 ⇒ reprograma con `Retry-After`; cuota ⇒
  reintento en 6 h; otros ⇒ backoff exponencial y `error` tras 8 fallos.
- **Delta y borrados.** Gmail: History API; si el `historyId` caduca, carga completa + barrido de lo no visto. Slack:
  avance diario por canal releyendo ayer y hoy (ediciones, borrados y respuestas recientes). ClickUp: `date_updated_gt`
  + reconciliación de IDs cada 24 h (ClickUp no expone borrados); Docs se listan cada pasada y solo se descargan si
  cambió `date_updated`. Deseleccionar un canal/espacio retira sus documentos. Desconectar revoca el token (mejor
  esfuerzo), marca todo como `deleting` (el worker purga chunks, embeddings y objetos) y borra credenciales. Si el dueño
  de un Gmail deja la organización, su correo sale del corpus en la siguiente pasada. Un elemento borrado a mano desde la
  biblioteca no se recrea.
- **Gobierno.** `organizations.allowed_connectors` (admin): desactivar una app pausa sus conexiones sin borrar nada.
  Auditoría: conexión, cambios, sincronizaciones con cambios, fallos que requieren acción y desconexión.
- **Modo demo** (`CONNECTORS_DEMO=1`, prohibido en producción): emulador en memoria de las APIs usadas, con datos de
  ejemplo; el mismo emulador sostiene los tests.

**Riesgos conocidos.**
- **Slack (mayo 2025):** apps distribuidas comercialmente fuera del Slack Marketplace tienen `conversations.history` y
  `conversations.replies` limitados a 1 llamada/min y 15 mensajes; las apps internas de un solo workspace mantienen los
  límites normales. Además, los términos actualizados de Slack restringen el uso de datos de su API; revisar con legal
  si se permite indexar mensajes en un producto SaaS multi-tenant. Opciones: app interna por cliente (despliegue
  dedicado) o publicación en el Marketplace.
- **Google:** `gmail.readonly` es un scope restringido: para usuarios externos exige verificación de Google y evaluación
  de seguridad (CASA). Una app "Internal" de Google Workspace no la necesita.
- Borrados antiguos de Slack (fuera de la ventana de relectura) y respuestas nuevas en hilos viejos no se detectan sin
  Events API.

**Pruebas.** `apps/api/test/connectors.test.ts` (20) contra Postgres real y APIs emuladas: cifrado con AAD; PKCE, state
de un solo uso y de la misma persona; Gmail solo visible para su dueño (ni el admin ve correo ni conexión), sin spam ni
promociones, delta con versión nueva, hilo borrado ⇒ tombstone, historial caducado ⇒ recarga sin duplicados, token
revocado ⇒ reconectar, desconexión ⇒ revocación + retirada; Slack pendiente de canales, privados solo con el bot dentro,
documento por canal-día visible para el workspace, deseleccionar ⇒ retirar; ClickUp espacios no privados por defecto,
edición ⇒ versión, borrado ⇒ reconciliación, privados por selección, política de la organización.

**Revisar cuando** haya apps OAuth reales (validar respuestas y límites), se necesiten permisos finos por canal/espacio
(mapear miembros del origen a usuarios ragsis), Events API/webhooks para borrados inmediatos, o más proveedores (Drive,
SharePoint): el contrato `ProviderAdapter` + `SyncSink` es el punto de extensión.
