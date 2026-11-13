# Configuration

All configuration arrives through **environment variables**. No secrets in the repository: `.env` is in `.gitignore`
and `scripts/dev-env.sh` generates it with random values. In the pilot, secrets live in `/opt/ragsis/.env.pilot`
(permissions `0600`) and, when an external key is added, in AWS Secrets Manager or SSM Parameter Store.

The tables show the default value when there is one. Uppercase names are the variable names.

## Secrets and database

| Variable | Required | Description |
|---|---|---|
| `POSTGRES_PASSWORD` | yes | Password of the `ragsis_owner` owner (migrations). |
| `RAGSIS_APP_DB_PASSWORD` | yes | `ragsis_app` role (API and rag-engine). No `BYPASSRLS`. |
| `RAGSIS_WORKER_DB_PASSWORD` | yes | `ragsis_worker` role (ingestion). No `BYPASSRLS`. |
| `INTERNAL_SERVICE_SECRET` | yes | At least 32 characters. Signs the internal API → rag-engine token (60 s). |
| `JWT_DEV_SECRET` | only `AUTH_MODE=dev` | Signs the development session token. |
| `DATABASE_URL` | no | If empty, libpq uses `PGHOST`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` and `PGSSLMODE`. |
| `DB_POOL_MIN` / `DB_POOL_MAX` | no (1 / 10) | Pool size in the Python services. |

## Authentication

| Variable | Where | Description |
|---|---|---|
| `AUTH_MODE` | web, API | `dev` (any email signs in) or `oidc`. Defaults to `dev`. |
| `OIDC_ISSUER` | web, API | Issuer URL. With Cognito: `https://cognito-idp.<region>.amazonaws.com/<pool-id>`. |
| `OIDC_AUDIENCE` | API | Audience the API validates (the IdP's `client_id`). |
| `OIDC_CLIENT_ID` | web | `client_id` of the public client. In the Compose pilot it is taken from `OIDC_AUDIENCE`. |
| `OIDC_CLIENT_SECRET` | web | Only for IdPs with a confidential client. Not used with Cognito. |
| `OIDC_SCOPES` | web | Defaults to `openid email profile`. |
| `SESSION_COOKIE_SECURE` | web | Defaults to `true`. Set to `false` only on `http://localhost`. |
| `PUBLIC_BASE_URL` | web, API | Public origin (for example `https://pilot.example.com`). Used in redirects, invitations and links. |

How sign-in works: [authentication.md](authentication.md).

## Web

| Variable | Description |
|---|---|
| `API_URL` | Internal API URL (`http://api:4000` in Compose). |
| `DEMO_BOOKING_URL` | HTTPS booking URL or email to request the demo from the landing page. |
| `CONTACT_EMAIL`, `LEGAL_ENTITY` | Contact details and legal entity name on public pages. |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | Turso database for `/waitlist` (`waitlist` table, created automatically on first use). Without them, production responds 503 and development only logs to the console. A sponsorship slot is taken on confirmation: `UPDATE waitlist SET status = 'confirmed' WHERE email = '…'`. |
| `WAITLIST_EMAIL_FROM` | Sender verified in Amazon SES to confirm the email on `/waitlist`. With it, the sign-up stays pending (`waitlist_pending` table) and only enters `waitlist` when the person opens the email link (24 h, single use). The web needs `AWS_REGION` and `ses:SendEmail` permission on that identity. Empty = sign-ups are stored unconfirmed. |
| `WAITLIST_EMAIL_TEST` | `1` = test mode when there is no sender: no email is sent and the confirmation link appears on the page and in the log. It is the default in `infra/docker/compose.yml`; do not use it in production. |

## API (`apps/api/src/config.ts`)

| Variable | Default | Description |
|---|---|---|
| `RAGSIS_ENV` | `local` | Identifies the environment in logs and traces. |
| `PORT` | `4000` | HTTP port. |
| `RAG_ENGINE_URL` | `http://localhost:8080` | Address of the rag-engine. |
| `AWS_REGION` | `us-east-1` | S3 and SQS Region. |
| `S3_ENDPOINT` | empty | Alternate S3 endpoint (SeaweedFS locally). |
| `S3_PUBLIC_ENDPOINT` | empty | S3 endpoint the **browser** sees for presigned URLs. |
| `S3_BUCKET` | `ragsis-documents` | Documents bucket. |
| `SQS_ENDPOINT` | empty | Alternate SQS endpoint (ElasticMQ locally). |
| `SQS_INGEST_QUEUE_URL` | empty | Ingestion queue. |
| `CORS_ORIGINS` | `http://localhost:3000` | Allowed origins, comma-separated. |
| `UPLOAD_URL_TTL_SECONDS` | `600` | Lifetime of the presigned upload URL. |
| `DOWNLOAD_URL_TTL_SECONDS` | `120` | Lifetime of the presigned download URL. |
| `ESIGN_PROVIDER` | `native` | `native`, `local` (simulates only, development) or `disabled`. |
| `ESIGN_WEBHOOK_SECRET` | empty | At least 32 characters. |
| `SIGNATURE_SEAL_SECRET` | derived | Stable secret for the Ed25519 seal (minimum 32 characters). Derived from `INTERNAL_SERVICE_SECRET` by default. |
| `SIGNATURE_EMAIL_FROM` | empty | Verified SES sender. Empty in development uses the test invitation. |

### Connectors

OAuth app setup guide: [connectors-setup.md](connectors-setup.md).

| Variable | Default | Description |
|---|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | empty | Gmail. Without `client_id` the provider appears as "not configured". |
| `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` | empty | Slack. |
| `CLICKUP_CLIENT_ID`, `CLICKUP_CLIENT_SECRET` | empty | ClickUp. |
| `CONNECTOR_ENCRYPTION_KEY` | derived | AES-256 key in base64 (`openssl rand -base64 32`). Required in production. |
| `CONNECTORS_DEMO` | `false` | In-memory simulated providers. Forbidden in production. |
| `CONNECTOR_SYNC_ENABLED` | `true` | `false` on replicas that must not sync. |
| `CONNECTOR_SYNC_INTERVAL_MINUTES` | `30` | Between 5 and 1440. |

## Python services (`packages/ragsis-core/src/ragsis_core/settings.py`)

Each field is an uppercase variable (`ai_embedding_model` → `AI_EMBEDDING_MODEL`).

### Models

| Variable | Default | Description |
|---|---|---|
| `AI_DEFAULT_PROVIDER` | `local` | Reserved: today the model is chosen with `AI_GENERATION_MODEL` and the other `AI_*_MODEL` variables. |
| `AI_EMBEDDING_MODEL` | `local-hash-1024@v1` | Embedding model. Changing it requires a reindex. |
| `AI_GENERATION_MODEL` | `local-extractive@v1` | Answer generation model. |
| `AI_RERANK_MODEL` | `local-lexical-rerank@v1` | Rerank. |
| `AI_VISION_MODEL` | empty | VLM that describes figures and uploaded photos during ingestion. Empty: captions only, and photos with no text fail with `no_extractable_text`. Muse options: `meta-muse-spark-1.3-vision@v1`, `meta-muse-spark-1.3-contributor-vision@v1` (Meta may train on the images; test data only). These are separate from the generation models, so turning vision on does not change how answers are built. |
| `AI_GRAPH_MODEL` | empty (`local-graph-heuristic@v1` in local Compose) | Entity and relation extraction. Empty: no graph even if the tenant has it enabled. |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server. |
| `OLLAMA_NUM_CTX` | `8192` | Context window requested from Ollama. Its own default (4096) silently drops the start of long RAG prompts: the rules and the first sources. Each new value reloads the model. |
| `META_MODEL_API_KEY` | empty | Key for the Meta Model API (Muse). Only in `.env`, never in Git. |
| `META_REASONING_EFFORT` | `low` | Muse reasoning effort (`minimal`, `low`, `medium`, `high`). RAG extracts and cites; more effort adds latency and cost. |
| `AI_ALLOW_TRAINING_MODELS` | `false` | Allows models whose provider may train on what is sent (`meta-muse-spark-1.3-contributor@v1`). Never for `confidential` or `restricted` organizations. |

For Bedrock: `AI_EMBEDDING_MODEL=bedrock-titan-embed-v2-1024@v1`, `AI_GENERATION_MODEL=bedrock-nova-lite@v1` (or
`bedrock-claude-sonnet-5-5@v1`) and AWS credentials in the containers' environment. On the pilot EC2 they come from the
`ragsis-pilot-ec2` role, which today does not include Bedrock permissions (they must be added and the models enabled in
the account).

For Meta Muse (cloud, outside AWS; AWS credits do not cover it): `AI_GENERATION_MODEL=meta-muse-spark-1.3@v1` and
`META_MODEL_API_KEY`. Retrieved evidence is sent to Meta. The `-contributor` variant costs about 12 times less per input
token because Meta may train on the content, so it also needs `AI_ALLOW_TRAINING_MODELS=true` and is only for
non-sensitive test data (ADR-033). If Muse fails, the answer falls back to `local-extractive@v1`, never to Ollama.

### Ingestion and multimodal

| Variable | Default | Description |
|---|---|---|
| `S3_ENDPOINT`, `S3_BUCKET`, `AWS_REGION` | see API | Same as the API. |
| `SQS_ENDPOINT`, `SQS_INGEST_QUEUE_URL`, `SQS_INGEST_DLQ_URL` | empty | Ingestion queue and DLQ. |
| `MALWARE_SCANNER` | `none` | `none` or `clamav`. Production and the pilot use `clamav`. |
| `CLAMAV_HOST`, `CLAMAV_PORT` | `clamav`, `3310` | ClamAV service. |
| `OCR_PROVIDER` | `none` | `none` or `textract`. |
| `OCR_TIMEOUT_SECONDS` | `600` | OCR limit. |
| `OCR_MIN_LINE_CONFIDENCE` | `60.0` | Minimum confidence per line. |
| `PARSER_PREFERENCE` | `native` | `native` or `docling` (requires the `docling` package in the image). |
| `DOCLING_OCR` | `false` | Docling local OCR, no network. |
| `DOCLING_ARTIFACTS_PATH` | empty | Docling models downloaded in advance. |
| `VISION_MAX_IMAGES_PER_DOC` | `40` | Cap on figures per document. |
| `VISION_MIN_IMAGE_BYTES` / `VISION_MIN_IMAGE_SIDE` | `2048` / `64` | Discards icons and bullets. |
| `VISION_MAX_IMAGE_BYTES` / `VISION_MAX_IMAGE_PIXELS` | `3750000` / `40000000` | Per-image limits (Bedrock Converse and defense against decompression bombs). |
| `INGEST_TABLE_SUMMARIES` | `false` | Summarizes tables with the generation model, verifying figures. |
| `INGEST_EQUATION_ANALYSIS` | `false` | Explains equations with the generation model and nearby text, verifying figures. |
| `GRAPH_MAX_CHUNKS_PER_DOC` | `200` | Cap on chunks that feed the graph. |
| `TRANSCRIPTION_PROVIDER` | `none` | `none` or `transcribe` (Amazon Transcribe). With `none`, recordings fail with `transcription_required` (ADR-030). |
| `TRANSCRIPTION_LANGUAGE` | empty | Fixed language code (e.g. `es-US`). Empty: automatic detection. |
| `TRANSCRIPTION_LANGUAGE_OPTIONS` | `es-US,es-ES,en-US,pt-BR` | Candidates for automatic language detection. |
| `TRANSCRIPTION_MAX_SPEAKERS` | `10` | Speaker separation; below `2` turns it off. |
| `TRANSCRIPTION_MIN_WORD_CONFIDENCE` | `0.4` | Words below this confidence are dropped from the transcript. |
| `TRANSCRIPTION_TIMEOUT_SECONDS` | `3600` | Limit to wait for a transcription job. |
| `AUDIO_MAX_SECONDS` | `14400` | Longest recording accepted (4 h); longer ones fail with `audio_too_long`. |

### Query

| Variable | Default | Description |
|---|---|---|
| `RAG_VLM_ENHANCED` | `auto` | Attaches images of cited figures if the generator has vision (`auto`, `on`, `off`). |
| `RAG_VLM_MAX_IMAGES` | `3` | Maximum images per query. |
| `RAG_GRAPH_CONTEXT_TOKENS` | `500` | Budget for graph facts of the selected evidence added to the prompt; `0` turns it off. |
| `RAG_DOCUMENT_MAX_OUTPUT_TOKENS` | `3000` | Output tokens for a document written from the chat (ADR-034); answers keep their own limit. |
| `DOCS_PAGE_SIZE` | `A4` | Page size of generated PDF and Word files (`A4` or `LETTER`). |
| `INTERNAL_TOKEN_AUDIENCE`, `INTERNAL_TOKEN_ISSUER` | `ragsis-rag`, `ragsis-api` | Claims of the internal token. |

### Public records (ADR-036)

Only the rag-engine reads these. Organizations turn the feature on in Connected apps; they never see the key.

| Variable | Default | Description |
|---|---|---|
| `CROMA_API_KEY` | empty | Croma organization key (`croma_live_…`, from platform.usecroma.com). A secret: Secrets Manager in AWS, never in Git. Empty = "Not set up". |
| `CROMA_DEMO` | `false` | `1` = labelled sample records instead of live lookups (development only). |
| `CROMA_BASE_URL` | `https://api.croma.run` | Croma host (HTTPS only). |
| `CROMA_TIMEOUT_SECONDS` | `25` | Per-lookup timeout; slower async lookups are reported as still processing. |
| `CROMA_MAX_CALLS` | `2` | Lookups per question (the API also caps it at 2 and at the organization's remaining monthly limit). |
| `CROMA_CONTEXT_TOKENS` | `3500` | Prompt budget for public evidence. |

### Operations

| Variable | Default | Description |
|---|---|---|
| `LOG_LEVEL` | `INFO` | Log level (JSON). |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | empty | Empty: no traces. With `make up-obs`: `http://jaeger:4318`. |
| `OTEL_SERVICE_NAME` | per service | For example `ragsis-api`. |
| `PIPELINE_VERSION` | `ingest-2026.11.3` | Pipeline version; stored with each chunk. |

## AWS pilot (`/opt/ragsis/.env.pilot`)

Template: [`infra/docker/.env.pilot.example`](../infra/docker/.env.pilot.example). Network and resource values come from
`terraform output -json runtime`.

| Variable | Source |
|---|---|
| `AWS_REGION`, `PILOT_HOSTNAME`, `S3_BUCKET`, `SQS_INGEST_QUEUE_URL` | `terraform output -json runtime` |
| `OIDC_ISSUER`, `OIDC_AUDIENCE` | `terraform output -json runtime` (the second is the Cognito `client_id`) |
| `API_IMAGE`, `WEB_IMAGE`, `RAG_ENGINE_IMAGE`, `INGEST_WORKER_IMAGE` | ECR references by digest (`repo@sha256:…`) |
| `POSTGRES_PASSWORD`, `RAGSIS_APP_DB_PASSWORD`, `RAGSIS_WORKER_DB_PASSWORD`, `INTERNAL_SERVICE_SECRET` | A different value per variable: `openssl rand -hex 32` on the host. Keep them when updating images. |

The pilot fixes `AUTH_MODE=oidc`, `SESSION_COOKIE_SECURE=true`, `MALWARE_SCANNER=clamav`, `OCR_PROVIDER=none`, `TRANSCRIPTION_PROVIDER=none` and local
models (`local-extractive@v1`, `local-hash-1024@v1`).

## Terraform

| Environment | Variables | Notes |
|---|---|---|
| `envs/pilot` | `aws_account_id`, `pilot_hostname` | Fixed Region `us-east-2`. The provider only accepts that account. |
| `envs/dev` | `region` (`us-east-1`), `env`, `image_tag`, plus those in `terraform.tfvars.example` | Remote state in S3 with `use_lockfile`; `bucket/key/region` via `-backend-config`. |

For Ragsis Sign with email on AWS, `envs/dev` accepts `signature_email_from` and `signature_email_identity_arn` (a
verified SES identity in the API's Region with production access). With a direct installation, the API receives
`SIGNATURE_EMAIL_FROM`, credentials with `ses:SendEmail` and `PUBLIC_BASE_URL` with HTTPS.

## Rehearsal script variables

`REHEARSAL_ENV`, `REHEARSAL_HOSTNAME`, `REHEARSAL_INSTANCE_TYPE`, `REHEARSAL_TARGETS` and the `EMULATOR_*` variables: see [guides/aws-emulator.md](guides/aws-emulator.md).
