# Configuración

Toda la configuración llega por **variables de entorno**. Nada de secretos en el repositorio: `.env` está en
`.gitignore` y `scripts/dev-env.sh` lo genera con valores aleatorios. En el piloto los secretos viven en
`/opt/ragsis/.env.pilot` (permisos `0600`) y, cuando se agregue una clave externa, en AWS Secrets Manager o en SSM
Parameter Store.

Las tablas indican el valor por defecto cuando existe. Los nombres en mayúsculas son los de la variable.

## Secretos y base de datos

| Variable | Obligatoria | Descripción |
|---|---|---|
| `POSTGRES_PASSWORD` | sí | Contraseña del propietario `ragsis_owner` (migraciones). |
| `RAGSIS_APP_DB_PASSWORD` | sí | Rol `ragsis_app` (API y rag-engine). Sin `BYPASSRLS`. |
| `RAGSIS_WORKER_DB_PASSWORD` | sí | Rol `ragsis_worker` (ingesta). Sin `BYPASSRLS`. |
| `INTERNAL_SERVICE_SECRET` | sí | Al menos 32 caracteres. Firma el token interno API → rag-engine (60 s). |
| `JWT_DEV_SECRET` | solo `AUTH_MODE=dev` | Firma el token de sesión de desarrollo. |
| `DATABASE_URL` | no | Si está vacía, libpq usa `PGHOST`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` y `PGSSLMODE`. |
| `DB_POOL_MIN` / `DB_POOL_MAX` | no (1 / 10) | Tamaño del pool en los servicios Python. |

## Autenticación

| Variable | Dónde | Descripción |
|---|---|---|
| `AUTH_MODE` | web, API | `dev` (cualquier correo entra) u `oidc`. Por defecto `dev`. |
| `OIDC_ISSUER` | web, API | URL del emisor. Con Cognito: `https://cognito-idp.<región>.amazonaws.com/<pool-id>`. |
| `OIDC_AUDIENCE` | API | Audiencia que valida la API (el `client_id` del IdP). |
| `OIDC_CLIENT_ID` | web | `client_id` del cliente público. En el piloto Compose lo toma de `OIDC_AUDIENCE`. |
| `OIDC_CLIENT_SECRET` | web | Solo para IdP con cliente confidencial. Con Cognito no se usa. |
| `OIDC_SCOPES` | web | Por defecto `openid email profile`. |
| `SESSION_COOKIE_SECURE` | web | Por defecto `true`. Poner `false` solo en `http://localhost`. |
| `PUBLIC_BASE_URL` | web, API | Origen público (por ejemplo `https://piloto.ejemplo.com`). Se usa en redirecciones, invitaciones y enlaces. |

Cómo funciona el inicio de sesión: [authentication.md](authentication.md).

## Web

| Variable | Descripción |
|---|---|
| `API_URL` | URL interna de la API (`http://api:4000` en Compose). |
| `DEMO_BOOKING_URL` | URL HTTPS de reservas o correo para solicitar la demo de la portada. |
| `CONTACT_EMAIL`, `LEGAL_ENTITY` | Datos de contacto y razón social en páginas públicas. |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | Base de datos Turso de `/waitlist` (tabla `waitlist`, creada sola al primer uso). Sin ellas, producción responde 503 y desarrollo solo registra en consola. Un cupo de patrocinio se ocupa al confirmar: `UPDATE waitlist SET status = 'confirmed' WHERE email = '…'`. |
| `WAITLIST_EMAIL_FROM` | Remitente verificado en Amazon SES para confirmar el correo en `/waitlist`. Con él, el registro queda pendiente (tabla `waitlist_pending`) y solo entra en `waitlist` cuando la persona abre el enlace del correo (24 h, un solo uso). La web necesita `AWS_REGION` y permiso `ses:SendEmail` sobre esa identidad. Vacío = los registros se guardan sin confirmar. |
| `WAITLIST_EMAIL_TEST` | `1` = modo de prueba cuando no hay remitente: no se envía correo y el enlace de confirmación aparece en la página y en el log. Es el valor por defecto de `infra/docker/compose.yml`; no usarlo en producción. |

## API (`apps/api/src/config.ts`)

| Variable | Por defecto | Descripción |
|---|---|---|
| `RAGSIS_ENV` | `local` | Identifica el entorno en logs y trazas. |
| `PORT` | `4000` | Puerto HTTP. |
| `RAG_ENGINE_URL` | `http://localhost:8080` | Dirección del rag-engine. |
| `AWS_REGION` | `us-east-1` | Región de S3 y SQS. |
| `S3_ENDPOINT` | vacío | Endpoint S3 alternativo (SeaweedFS en local). |
| `S3_PUBLIC_ENDPOINT` | vacío | Endpoint S3 que ve el **navegador** para las URLs prefirmadas. |
| `S3_BUCKET` | `ragsis-documents` | Bucket de documentos. |
| `SQS_ENDPOINT` | vacío | Endpoint SQS alternativo (ElasticMQ en local). |
| `SQS_INGEST_QUEUE_URL` | vacío | Cola de ingesta. |
| `CORS_ORIGINS` | `http://localhost:3000` | Orígenes permitidos, separados por coma. |
| `UPLOAD_URL_TTL_SECONDS` | `600` | Vigencia de la URL prefirmada de subida. |
| `DOWNLOAD_URL_TTL_SECONDS` | `120` | Vigencia de la URL prefirmada de descarga. |
| `ESIGN_PROVIDER` | `native` | `native`, `local` (solo simula, desarrollo) o `disabled`. |
| `ESIGN_WEBHOOK_SECRET` | vacío | Al menos 32 caracteres. |
| `SIGNATURE_SEAL_SECRET` | derivado | Secreto estable del sello Ed25519 (mínimo 32 caracteres). Por defecto se deriva de `INTERNAL_SERVICE_SECRET`. |
| `SIGNATURE_EMAIL_FROM` | vacío | Remitente verificado de SES. Vacío en desarrollo usa la invitación de prueba. |

### Conectores

Guía de alta de las apps OAuth: [connectors-setup.md](connectors-setup.md).

| Variable | Por defecto | Descripción |
|---|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | vacío | Gmail. Sin `client_id` el proveedor aparece como «no configurado». |
| `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` | vacío | Slack. |
| `CLICKUP_CLIENT_ID`, `CLICKUP_CLIENT_SECRET` | vacío | ClickUp. |
| `CONNECTOR_ENCRYPTION_KEY` | derivado | Clave AES-256 en base64 (`openssl rand -base64 32`). Obligatoria en producción. |
| `CONNECTORS_DEMO` | `false` | Proveedores simulados en memoria. Prohibido en producción. |
| `CONNECTOR_SYNC_ENABLED` | `true` | `false` en réplicas que no deben sincronizar. |
| `CONNECTOR_SYNC_INTERVAL_MINUTES` | `30` | Entre 5 y 1440. |

## Servicios Python (`packages/ragsis-core/src/ragsis_core/settings.py`)

Cada campo es una variable en mayúsculas (`ai_embedding_model` → `AI_EMBEDDING_MODEL`).

### Modelos

| Variable | Por defecto | Descripción |
|---|---|---|
| `AI_DEFAULT_PROVIDER` | `local` | Reservada: hoy el modelo se elige con `AI_GENERATION_MODEL` y los demás `AI_*_MODEL`. |
| `AI_EMBEDDING_MODEL` | `local-hash-1024@v1` | Modelo de embeddings. Cambiarlo exige reindexar. |
| `AI_GENERATION_MODEL` | `local-extractive@v1` | Modelo de generación de respuestas. |
| `AI_RERANK_MODEL` | `local-lexical-rerank@v1` | Rerank. |
| `AI_VISION_MODEL` | vacío | VLM que describe figuras en la ingesta. Vacío: solo captions. |
| `AI_GRAPH_MODEL` | vacío | Extracción de entidades y relaciones. Vacío: sin grafo aunque el tenant lo tenga activo. |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Servidor Ollama. |

Para Bedrock: `AI_EMBEDDING_MODEL=bedrock-titan-embed-v2-1024@v1`, `AI_GENERATION_MODEL=bedrock-nova-lite@v1` (o
`bedrock-claude-sonnet-5-5@v1`) y credenciales de AWS en el entorno de los contenedores. En la EC2 del piloto vienen del
rol `ragsis-pilot-ec2`, que hoy no incluye permisos de Bedrock (hay que agregarlos y habilitar los modelos en la cuenta).

### Ingesta y multimodal

| Variable | Por defecto | Descripción |
|---|---|---|
| `S3_ENDPOINT`, `S3_BUCKET`, `AWS_REGION` | ver API | Igual que la API. |
| `SQS_ENDPOINT`, `SQS_INGEST_QUEUE_URL`, `SQS_INGEST_DLQ_URL` | vacío | Cola de ingesta y DLQ. |
| `MALWARE_SCANNER` | `none` | `none` o `clamav`. Producción y piloto usan `clamav`. |
| `CLAMAV_HOST`, `CLAMAV_PORT` | `clamav`, `3310` | Servicio ClamAV. |
| `OCR_PROVIDER` | `none` | `none` o `textract`. |
| `OCR_TIMEOUT_SECONDS` | `600` | Límite del OCR. |
| `OCR_MIN_LINE_CONFIDENCE` | `60.0` | Confianza mínima por línea. |
| `PARSER_PREFERENCE` | `native` | `native` o `docling` (requiere el paquete `docling` en la imagen). |
| `DOCLING_OCR` | `false` | OCR local de Docling, sin red. |
| `DOCLING_ARTIFACTS_PATH` | vacío | Modelos de Docling descargados de antemano. |
| `VISION_MAX_IMAGES_PER_DOC` | `40` | Tope de figuras por documento. |
| `VISION_MIN_IMAGE_BYTES` / `VISION_MIN_IMAGE_SIDE` | `2048` / `64` | Descarta iconos y viñetas. |
| `VISION_MAX_IMAGE_BYTES` / `VISION_MAX_IMAGE_PIXELS` | `3750000` / `40000000` | Límites por imagen (Bedrock Converse y defensa ante bombas de descompresión). |
| `INGEST_TABLE_SUMMARIES` | `false` | Resume tablas con el modelo de generación, verificando cifras. |
| `GRAPH_MAX_CHUNKS_PER_DOC` | `200` | Tope de chunks que alimentan el grafo. |

### Consulta

| Variable | Por defecto | Descripción |
|---|---|---|
| `RAG_VLM_ENHANCED` | `auto` | Adjunta imágenes de figuras citadas si el generador tiene visión (`auto`, `on`, `off`). |
| `RAG_VLM_MAX_IMAGES` | `3` | Máximo de imágenes por consulta. |
| `INTERNAL_TOKEN_AUDIENCE`, `INTERNAL_TOKEN_ISSUER` | `ragsis-rag`, `ragsis-api` | Claims del token interno. |

### Operación

| Variable | Por defecto | Descripción |
|---|---|---|
| `LOG_LEVEL` | `INFO` | Nivel de log (JSON). |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | vacío | Vacío: sin trazas. Con `make up-obs`: `http://jaeger:4318`. |
| `OTEL_SERVICE_NAME` | por servicio | Por ejemplo `ragsis-api`. |
| `PIPELINE_VERSION` | `ingest-2026.11.2` | Versión del pipeline; se guarda con cada chunk. |

## Piloto en AWS (`/opt/ragsis/.env.pilot`)

Plantilla: [`infra/docker/.env.pilot.example`](../infra/docker/.env.pilot.example). Los valores de red y recursos salen
de `terraform output -json runtime`.

| Variable | Origen |
|---|---|
| `AWS_REGION`, `PILOT_HOSTNAME`, `S3_BUCKET`, `SQS_INGEST_QUEUE_URL` | `terraform output -json runtime` |
| `OIDC_ISSUER`, `OIDC_AUDIENCE` | `terraform output -json runtime` (el segundo es el `client_id` de Cognito) |
| `API_IMAGE`, `WEB_IMAGE`, `RAG_ENGINE_IMAGE`, `INGEST_WORKER_IMAGE` | Referencias de ECR por digest (`repo@sha256:…`) |
| `POSTGRES_PASSWORD`, `RAGSIS_APP_DB_PASSWORD`, `RAGSIS_WORKER_DB_PASSWORD`, `INTERNAL_SERVICE_SECRET` | Un valor distinto por variable: `openssl rand -hex 32` en el host. Consérvalos al actualizar imágenes. |

El piloto fija `AUTH_MODE=oidc`, `SESSION_COOKIE_SECURE=true`, `MALWARE_SCANNER=clamav`, `OCR_PROVIDER=none` y modelos
locales (`local-extractive@v1`, `local-hash-1024@v1`).

## Terraform

| Entorno | Variables | Notas |
|---|---|---|
| `envs/pilot` | `aws_account_id`, `pilot_hostname` | Región fija `us-east-2`. El proveedor solo acepta esa cuenta. |
| `envs/dev` | `region` (`us-east-1`), `env`, `image_tag`, más las de `terraform.tfvars.example` | Estado remoto en S3 con `use_lockfile`; `bucket/key/region` por `-backend-config`. |

Para Ragsis Sign con correo en AWS, `envs/dev` acepta `signature_email_from` y `signature_email_identity_arn` (una
identidad SES verificada en la región de la API y con acceso de producción). Con una instalación directa, la API recibe
`SIGNATURE_EMAIL_FROM`, credenciales con `ses:SendEmail` y `PUBLIC_BASE_URL` con HTTPS.

## Variables del script de ensayo

`REHEARSAL_ENV`, `FLOCI_ENDPOINT`, `REHEARSAL_HOSTNAME` y `REHEARSAL_TARGETS`: ver [guides/floci.md](guides/floci.md).
