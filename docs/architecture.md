# Architecture

Ragsis turns internal documents into answers with verifiable citations. Every answer respects the tenant, workspace,
groups and document permission of the person asking. This document describes the pieces, how they talk to each other and
why they are the way they are. The substantial decisions are in the [ADRs](adr/README.md).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="diagrams/containers-dark.svg">
  <img alt="Ragsis containers: web, api, rag-engine, ingest-worker, Postgres, S3, SQS and model providers" src="diagrams/containers.svg">
</picture>

## Components

| Component | Technology | Responsibility | Port |
|---|---|---|---|
| `apps/web` | Next.js 16 | UI and BFF. Keeps the session in an `httpOnly` cookie; the browser never sees the `id_token`. | 3000 |
| `apps/api` | TypeScript, Fastify | Control plane: tenant and roles, ACL, presigned uploads, queries, agents, workflows, signatures, connectors. | 4000 |
| `services/rag-engine` | Python, FastAPI | Orchestrates the query: hybrid retrieval, fusion, generation and citation verification. Only accepts the API's internal token. | 8080 (internal) |
| `services/ingest-worker` | Python | Consumes SQS: validates, scans, parses, chunks, redacts PII, embeds and indexes. | no port |
| `services/ai-gateway` | Python (library) | `ModelRegistry`, residency policy by data classification, bounded fallback and budgets. | n/a |
| `packages/ragsis-core` | Python | Settings, DB connection with RLS context, internal token, telemetry and text utilities. | n/a |
| `packages/contracts` | OpenAPI | Public contract of API v1 (`openapi.yaml`). | n/a |
| PostgreSQL 17 + pgvector | Postgres | Single database: data, ACL, vectors, full-text search and graph. | 5432 |
| S3 | S3 (SeaweedFS locally) | Originals, figures and artifacts. Versioned and encrypted. | 8333 locally |
| SQS | SQS (ElasticMQ locally) | Ingestion queue with DLQ. | 9324 locally |
| ClamAV | ClamAV | Worker antimalware. | 3310 |

The Python services share `packages/ragsis-core`; the TypeScript API is independent. The full tree is in the
[development guide](development.md#repository-map).

## Why a single database

PostgreSQL with pgvector stores text, metadata, permissions, vectors and graph in the same transaction. This way the
document ACL is applied **inside the SQL query** before anything is retrieved, and not afterwards in the application
([ADR-002](adr/README.md), [ADR-008](adr/README.md#adr-008--acl-enforced-in-the-database-not-only-in-the-app)).
The trade-off is that the vector index shares resources with everything else; the Master Plan sets when to revisit that.

## Data model

Migrations are in `db/migrations/` (0001 to 0013) and are applied in order with the owner role.

| Domain | Main tables |
|---|---|
| Identity and tenancy | `organizations`, `users`, `memberships`, `workspaces`, `workspace_members`, `groups`, `group_members`, `functional_roles`, `plans` |
| Documents | `documents`, `document_versions`, `document_acl`, `document_lifecycle`, `shares` |
| Index | `chunks`, `chunk_embeddings` (dual-write during reindex), `entities`, `relations`, `entity_sources`, `relation_sources` |
| Ingestion | `ingestion_jobs`, `outbox_events`, `webhook_inbox` |
| Query | `query_runs`, `citations`, `usage_events` |
| Agents and workflows | `agents`, `agent_versions`, `agent_test_runs`, `workflows`, `workflow_versions`, `workflow_runs`, `run_steps`, `approvals`, `external_policies` |
| E-signature | `signature_envelopes`, `signature_invitations`, `local_signatures`, `personal_signatures` |
| Connectors | `connectors`, `connector_credentials`, `connector_items`, `connector_oauth_states` |
| Onboarding and governance | `onboarding_sessions`, `organization_profiles`, `service_api_keys`, `audit_events` |

Rules that do not change:

- **RLS forced** on every customer table. The roles `ragsis_app` and `ragsis_worker` do not have `BYPASSRLS`.
- The tenant **never** comes from the client: it is resolved by verified membership (`apps/api/src/lib/tenant.ts`). A
  non-member gets 404, not 403.
- `SECURITY DEFINER` functions are few and bounded (for example `app.upsert_user` and the membership lookup).
- `audit_events` forms a per-tenant hash chain (`prev_hash` → `hash`).

## Ingestion

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="diagrams/ingest-dark.svg">
  <img alt="Ingestion pipeline in ten steps" src="diagrams/ingest.svg">
</picture>

1. The browser uploads the file to S3 with a presigned URL issued by the API. It lands in quarantine.
2. The API records the version and job in Postgres and enqueues a message in SQS.
3. The worker validates magic bytes, MIME, macros, ZIP bombs and size and page limits.
4. ClamAV scans the object. A positive ends in `rejected`.
5. Parsing: native by default, Docling optional (`PARSER_PREFERENCE`). Scanned files go through OCR (`OCR_PROVIDER`:
   Textract on AWS, or local `DOCLING_OCR`).
6. Multimodal (ADR-018): tables and equations are chunks of their own with page, bbox and caption. Figures are described
   with a VLM (`AI_VISION_MODEL`) and stored as a citable asset. Without a VLM, a figure is indexed only if it has a
   caption.
7. Chunking without tiktoken (ADR-013) and PII redaction.
8. Embeddings through the ai-gateway, respecting the tenant's model policy.
9. Index: pgvector, Spanish full-text search and, if the tenant has the graph, entities and relations with ACL derived
   from the source chunks (ADR-019).
10. The document becomes `indexed` and the audit event is recorded.

**Errors.** Permanent ones (invalid file, malware, model policy, page limit) leave the version in `failed` or
`rejected` and are not retried. Transient ones (DB, S3, model, ClamAV) are retried and, after four receives, the
message goes to the DLQ (runbook [dlq.md](../ops/runbooks/dlq.md)). Processing is idempotent per job and version.

## Query

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="diagrams/query-dark.svg">
  <img alt="Query flow in nine steps" src="diagrams/query.svg">
</picture>

1. The question arrives from the web (session) or with a service key `rsk_…` (scopes `query`, `documents:read`,
   `documents:write` and workspace scoping).
2. The API resolves tenant and role by membership.
3. The API issues a 60 s internal JWT for the rag-engine (ADR-009).
4. The rag-engine retrieves with Spanish full-text search and pgvector. The ACL is applied in SQL.
5. Fusion with RRF and rerank according to the plan. If the graph is active, also `local`, `global` or `hybrid` modes;
   citations still point to chunks.
6. The prompt delimits and escapes document content; the ai-gateway picks the model according to the tenant's policy.
   A `restricted` tenant never calls external APIs, and there is no silent fallback to the cloud.
7. The verifier requires every citation and every figure to be in the cited text. If evidence is missing, the answer is
   an abstention.
8. `query_runs` stores tokens and cost; the question is stored only as a SHA-256.
9. The text with citations, or the abstention, is returned.

**Greetings and pleasantries.** A message that *is* a greeting, a thank-you, a goodbye or "what can you do?"
(`hola`, `gracias`, `hello`, `ayuda`…) is answered with a fixed text, in Spanish or English depending on the phrase,
**before** searching anything: no embeddings, no retrieval, no model and no citations. It returns with
`abstained: true` and `abstain_reason: "smalltalk"` (so agents and workflows do not mistake it for a document answer),
is recorded in `query_runs` and **does not consume the monthly query quota**. A greeting followed by a real question
("hola, ¿cuál es el plazo de pago?") follows the normal path. Code: `services/rag-engine/src/ragsis_rag/smalltalk.py`.

## Model providers

The ai-gateway hides the provider behind identifiers of the form `provider-model@version`.

| Provider | Examples | When |
|---|---|---|
| `local` | `local-hash-1024@v1`, `local-extractive@v1`, `local-lexical-rerank@v1`, `local-graph-heuristic@v1` | Development, tests and offline pilot (ADR-010). Deterministic. |
| `bedrock` | `bedrock-titan-embed-v2-1024@v1`, `bedrock-nova-lite@v1`, `bedrock-claude-sonnet-5-5@v1` | AWS (ADR-003, ADR-011). |
| `ollama` | `ollama-qwen3-8b@v1`, `ollama-qwen3-vl-8b@v1` | On-premises or offline, and restricted tenants. |

Changing the embedding model requires a reindex ([reindex.md](../ops/runbooks/reindex.md)).

## Agents, workflows, signatures and connectors

These are API modules that share the same database and the same permission rules. The functional detail is in
[features.md](features.md).

- **Agent Studio** (ADR-020): declarative definition with a deny-by-default policy, sandbox with real search and
  simulated writes, immutable versions.
- **Workflows** (ADR-022): durable runner on Postgres with an outbox, human review and approvals tied to the hash of what
  was reviewed.
- **Ragsis Sign** (ADR-024): envelopes, signatures, final PDF and a certificate sealed with Ed25519.
- **Connectors** (ADR-025): Gmail (personal), Slack and ClickUp with OAuth + PKCE, tokens encrypted with AES-GCM and
  delta sync. Guide: [connectors-setup.md](connectors-setup.md).

## Observability

Traces are manual OpenTelemetry (ADR-017) with W3C context across API, rag-engine and worker. `make up-obs` adds Jaeger
(<http://localhost:16686>). Logs are JSON with redaction. On AWS, the alarms of the `observability` module cover the DLQ,
load balancer 5xx, database CPU and a monthly budget.

## Infrastructure as code

| Path | Used for |
|---|---|
| `infra/docker/compose.yml` | Full local stack |
| `infra/docker/compose.pilot.yml` | Pilot on one EC2 (images by digest) |
| `infra/terraform/modules/*` | `network`, `security`, `storage`, `database`, `compute`, `edge`, `observability` |
| `infra/terraform/envs/dev` | Reference environment: ECS Fargate, ALB, RDS, WAF |
| `infra/terraform/envs/pilot` | Low-cost pilot: one EC2, S3, SQS, KMS, ECR, Cognito |

The pilot and the reference environment share the `storage` module. How each one is tested is in
[environments.md](environments.md).
