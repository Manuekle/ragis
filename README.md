<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/brand/ragis-logo-dark.svg">
    <img alt="Ragis logo" src="docs/assets/brand/ragis-logo.svg" height="72">
  </picture>
</p>

<h1 align="center">Ragis</h1>

<p align="center"><strong>Answers cited to the page, from your company's documents.</strong></p>

Enterprise B2B RAG platform: turns internal documents, spreadsheets, slides, images and recordings into **verifiable
answers with citations**, respecting permissions per tenant, workspace, group and document. It implements phases
**F1 (Core SaaS)**, the technical part of **F2 (quality)** and **F3 multimodal (OCR, figures, tables, equations and
audio)** of the *Master Plan — Enterprise RAG Platform on AWS* v1.0. The code name of the repository, packages, database
roles and environment variables is `ragsis`.

<p>
  <img alt="TypeScript" src="docs/assets/icons/tech/typescript.svg" height="30">
  <img alt="Node.js" src="docs/assets/icons/tech/node-js.svg" height="30">
  <img alt="Next.js" src="docs/assets/icons/tech/next-js.svg" height="30">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/icons/tech/fastify-dark.svg">
    <img alt="Fastify" src="docs/assets/icons/tech/fastify.svg" height="30">
  </picture>
  <img alt="Python" src="docs/assets/icons/tech/python.svg" height="30">
  <img alt="FastAPI" src="docs/assets/icons/tech/fastapi.svg" height="30">
  <img alt="PostgreSQL" src="docs/assets/icons/tech/postgresql.svg" height="30">
  <img alt="Docker" src="docs/assets/icons/tech/docker.svg" height="30">
  <img alt="Terraform" src="docs/assets/icons/tech/terraform.svg" height="30">
  &nbsp;·&nbsp;
  <img alt="Amazon EC2" src="docs/assets/icons/aws/ec2.svg" height="30">
  <img alt="Amazon S3" src="docs/assets/icons/aws/s3.svg" height="30">
  <img alt="Amazon SQS" src="docs/assets/icons/aws/sqs.svg" height="30">
  <img alt="Amazon Cognito" src="docs/assets/icons/aws/cognito.svg" height="30">
  <img alt="Amazon Bedrock" src="docs/assets/icons/aws/bedrock.svg" height="30">
</p>

## How it answers

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/rag-pipeline-dark.svg">
  <img alt="How Ragis answers: multimodal parsing into typed units, a dual text and cross-modal knowledge graph with a vector index, and cross-modal hybrid retrieval with verified citations" src="docs/diagrams/rag-pipeline.svg">
</picture>

1. **Multimodal content parsing.** Each file is validated and scanned, then split into typed units that keep where they
   came from: text with its section and page, figures (caption plus a description written by a vision model), equations,
   tables and recording transcripts with their time range.
2. **Dual-graph grounding and index.** Text chunks feed a text knowledge graph; every figure, table and equation becomes an
   anchor node linked to the entities found in it. Both graphs merge by entity name into one workspace graph. Chunks,
   entities and relations are embedded in the same vector space, next to Spanish full-text search, all in PostgreSQL.
3. **Cross-modal hybrid retrieval.** The question is checked against the person's permissions, read for modality cues
   ("the table", "the figure", "the recording"), and searched three ways (full text, vectors, graph). Results are fused
   with RRF, the requested modality gets a bonus, and the model answers only from that evidence. A verifier checks every
   citation; without evidence the system abstains.

The structure follows the RAG-Anything paper (Guo et al., 2025), implemented inside PostgreSQL instead of with that
library ([ADR-004](docs/adr/README.md), [ADR-029](docs/adr/README.md#adr-029--cross-modal-graph-and-modality-aware-retrieval-ideas-from-rag-anything)).
Step by step: [docs/architecture.md](docs/architecture.md).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/containers-dark.svg">
  <img alt="Ragis containers: web, api, rag-engine, ingest-worker, Postgres, S3, SQS and model providers" src="docs/diagrams/containers.svg">
</picture>

## What it does

- **Answers with verifiable citations.** Every citation and every figure must appear in the cited text; if evidence is
  missing, the system abstains.
- **Real permissions.** The tenant is resolved by membership, RLS is forced in the database and the document ACL is
  applied in SQL before anything is retrieved.
- **Real documents.** PDF, DOCX, PPTX, XLSX, images, HTML, Markdown, TXT, CSV and audio recordings, with OCR, tables,
  equations, figures and transcripts with timestamps. A citation can open a recording at the cited second.
- **An organized library.** Folders with content-based suggestions; folders never change who can see a document.
- **More than search.** GraphRAG, agents with a deny-by-default policy, workflows with human review, e-signature and
  connectors to Gmail, Slack and ClickUp. See [docs/features.md](docs/features.md).
- **Works offline.** The local model provider is deterministic; Bedrock and Ollama are optional.

## Quick start

Requirements: Docker, `uv`, `pnpm` (Node 24 or later).

```bash
make up        # generates .env with random secrets and brings up the stack
make up-obs    # same, with Jaeger and OpenTelemetry traces (http://localhost:16686)
```

- Web: <http://localhost:3000> (development login: sign in with any email)
- `make seed`: creates the "ACME Demo (local)" organization with `prueba@ragsis.test` and nine documents to try Ask
  ([details and sample questions](docs/development.md#test-user-and-data))
- `make seed-judicial` then `make seed-judicial-week`: a law firm that looks like it has used Ragis for over a week,
  for demos and recordings ([people and what each one shows](docs/development.md#judicial-demo-for-recordings-and-sales-demos))
- API: <http://localhost:4000>, with the contract in [`packages/contracts/openapi.yaml`](packages/contracts/openapi.yaml)

More commands, tests and conventions: [docs/development.md](docs/development.md).

## Environments

The rule: **all AWS infrastructure is rehearsed first in AWS Emulator (the official local emulator) and only then created in real AWS.**

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/environments-dark.svg">
  <img alt="Local with Docker Compose, rehearsal in AWS Emulator and real AWS" src="docs/diagrams/environments.svg">
</picture>

| Environment | Command | Details |
|---|---|---|
| Local | `make up` | Docker Compose with SeaweedFS (S3) and ElasticMQ (SQS) |
| Rehearsal | `make emulator-up` + `make rehearse` | Pilot Terraform against AWS Emulator ([guide](docs/guides/aws-emulator.md)) |
| Real AWS | `terraform apply` | Pilot in `us-east-2`: one EC2, S3, SQS, KMS, ECR and Cognito ([runbook](ops/runbooks/piloto-aws.md)) |

Where each piece runs and what the pilot costs on the FREE plan: [docs/environments.md](docs/environments.md).

## Architecture

```
apps/
  web/              Next.js 16: UI and BFF with an httpOnly cookie; login lives here
  api/              TypeScript/Fastify: control plane, authZ, uploads, queries
services/
  rag-engine/       Python/FastAPI: query (full text + vectors + graph, RRF, rerank, citation verification)
  ingest-worker/    Python: SQS → validation → antimalware → parsing (+OCR, audio, multimodal) → chunking → PII → graph → embeddings → index
  ai-gateway/       Python: ModelRegistry, residency policy, bounded fallback, budgets
packages/
  ragsis-core/      Python: settings, DB with RLS context, internal token, text utilities
  contracts/        OpenAPI v1
  policy/           Authorization test index
db/migrations/      Schema, forced RLS and bounded SECURITY DEFINER functions
infra/
  docker/           Local and pilot Compose
  terraform/        AWS modules (network, security, storage, database, compute, edge, observability) and dev and pilot environments
ops/runbooks/       DLQ, reindex, restore, cross-tenant incident, deletion, DB bootstrap, AWS pilot
eval/               Golden set, sample corpus and metrics
docs/               Documentation, ADRs, diagrams and icons
```

How a document and a question flow through the system, with step-by-step diagrams: [docs/architecture.md](docs/architecture.md).

## Documentation

| Topic | Document |
|---|---|
| Index of everything | [docs/README.md](docs/README.md) |
| Architecture, RAG pipeline, data model, ingestion and query | [docs/architecture.md](docs/architecture.md) |
| Public API v1 (OpenAPI) | [packages/contracts/openapi.yaml](packages/contracts/openapi.yaml) |
| Environments, AWS pilot and costs | [docs/environments.md](docs/environments.md) |
| Rehearsing infrastructure in AWS Emulator | [docs/guides/aws-emulator.md](docs/guides/aws-emulator.md) |
| Environment variables and secrets | [docs/configuration.md](docs/configuration.md) |
| Sign-in (inside the app, with Cognito) | [docs/authentication.md](docs/authentication.md) |
| Security | [docs/security.md](docs/security.md) |
| Features: multimodal, audio, GraphRAG, folders, agents, workflows, e-signature, connectors | [docs/features.md](docs/features.md) |
| Development, tests and CI | [docs/development.md](docs/development.md) |
| Decisions (ADR-001 to ADR-031) | [docs/adr/README.md](docs/adr/README.md) |
| Operational runbooks | [ops/runbooks/README.md](ops/runbooks/README.md) |

## Tests

```bash
make test          # pytest + vitest against real Postgres and S3
make e2e           # full stack: provisions 2 tenants, ingests the corpus and evaluates the golden set against targets
make tf-validate   # terraform validate of the dev environment
```

Current E2E result (`eval/golden/sample.yaml`, 18 questions including tables in PPTX and XLSX, local provider):

| Metric | Value | Pilot target |
|---|---|---|
| answer accuracy | 1.00 | ≥ 0.85 |
| evidence hit rate | 1.00 | ≥ 0.85 |
| citation precision | 1.00 | ≥ 0.95 |
| abstention precision / recall | 1.00 / 1.00 | ≥ 0.90 |
| ACL leakage | 0 | 0 |

The sample golden set is synthetic and small; targets must be measured with 100 to 200 real questions per vertical
(F0/F2).

## Security (summary)

- Tenant resolved **only** by verified membership; never from the client. Non-member: 404.
- RLS **forced** on every customer table; document ACL applied in the database before retrieval (ADR-008).
- Roles `ragsis_app` and `ragsis_worker` without `BYPASSRLS`; internal API → rag-engine token with a 60 s lifetime (ADR-009).
- Direct upload to S3 with a presigned URL; quarantine, magic bytes, MIME, encryption, macros, ZIP bomb and ClamAV checks.
- Graph rows, graph vectors, document summary vectors and transcripts inherit the source document's ACL; folders never
  grant access.
- Prompt with delimited and escaped document content; citation and figure verifier; abstention by default.
- Model policy by data classification: `restricted` never calls external APIs; no silent fallback to the cloud.
- Audit log with a per-tenant hash chain; JSON logs with redaction; questions stored only as SHA-256.

Details and infrastructure controls: [docs/security.md](docs/security.md).

## Status against the Master Plan

| ID | Story | Status |
|---|---|---|
| SEC-01 | End-to-end tenant isolation | ✅ negative tests for DB, retrieval, citations, S3 keys |
| DOC-01 | Secure upload and versioning | ✅ |
| RAG-01 | Semantic search with citations + abstention | ✅ |
| RAG-02 | Hybrid + rerank | ✅ (pgvector RRF + Spanish FTS; rerank per plan) |
| OBS-01 | Traces and cost per tenant | ✅ OTel API→rag-engine→worker (W3C), query_runs with tokens/cost |
| OPS-01 | Ingestion resilience | ✅ idempotency, retries, DLQ, runbook |
| AUTH-02 | Roles and groups per workspace | ✅ |
| RAG-03 | Reindex + deletion | ✅ embedding dual-write, full reindex with atomic swap, purge, verifiable deletion |
| API-01 | API v1 and service keys | ✅ scopes, workspace scoping, expiration, revocation, audit |
| AUTH-SSO | Web login | ✅ Cognito with an in-app form ([ADR-026](docs/adr/README.md#adr-026--in-app-login-with-cognito-user_password_auth)); other OIDC IdPs with Authorization Code + PKCE and RP-initiated logout |
| RAG-04 | Multimodal tables/figures | ✅ PPTX/XLSX/images, figures with VLM + S3 asset, charts→table, equations, bbox, VLM-enhanced; Docling optional |
| RAG-05 | GraphRAG | ✅ Entities/relations in Postgres with ACL derived from the chunks (ADR-019), local/global/hybrid modes fused by RRF, multi-hop with citations to chunks; per plan or organization |
| P0-01/02 | Sector profile + 9-step onboarding | ✅ Deterministic versioned presets, resumable state machine, draft spaces and agents without overwriting (ADR-020) |
| P0-04/05 | Agent Studio + Policy Engine | ✅ Declarative definition, deny-by-default, sandbox with real retrieval and simulated writes, publication tied to a test, immutable versions, rollback |
| P1-01…04 | Agent runtime, workflows/HITL, Approval Inbox, bounded delegation, run traces | ✅ Durable runner on Postgres + outbox, approvals tied to hash/version, separation of duties, budget, Activity (ADR-022) |
| P2-01/02 | E-signature and controlled sharing | ✅ Ragsis Sign, approvals, SES invitations, final PDF, sealed certificate and public verification (ADR-024) |
| CON-01 | Connectors | ✅ Gmail (personal, owner only), Slack and ClickUp (company → workspace); OAuth+PKCE, AES-GCM tokens, delta sync with cursor/lease/backoff, tombstones and deletion on disconnect (ADR-025). Open: validate with real OAuth apps |
| HIST-01 | Conversation history | ✅ Ask saves each turn in a private conversation owned by its author (RLS), with a list, reopening via the `?c=` link, rename and delete; on reload, any turn whose cited document is no longer visible is hidden (ADR-028). Open: configurable retention and passing prior context to the model |
| — | Cross-modal graph (RAG-Anything ideas) | ✅ Anchor nodes for figures, tables and equations, intra-table graph, dense graph seeds, modality-aware fusion, graph facts in the prompt (ADR-029) |
| — | Audio recordings | ✅ MP3/WAV/M4A/OGG/FLAC, Amazon Transcribe provider, chunks with time ranges and speakers, player with transcript (ADR-030). Open: Transcribe IAM in Terraform and a local transcriber for restricted tenants |
| — | Library folders | ✅ Nested folders, move, upload into a folder, suggestions by content or name under RLS (ADR-031) |
| — | Teams and requests between teams | ✅ Departments with their own private space (Legal, Treasury…), requests between teams with a board, timeline and assignment, visible only to the people involved (RLS); two-part Inbox: from people and from agents (ADR-035). Open: notifications and attachments on requests |
| INFRA-PILOT | Low-cost pilot on AWS | ✅ Terraform and Compose on one EC2 (us-east-2); prior rehearsal in AWS Emulator (ADR-027, ADR-032). Open: redeploy with the new login |
| ENT-01 | Dedicated tenant IaC | ⏳ P2 · Goal: provision in an isolated account/VPC, with a restore test. Today: Terraform modules (`dev`, `pilot` envs), per-customer CMK planned for the `dedicated_tenant` template, dedicated as a premium option (ADR-006). Open: the dedicated environment itself and the restore test |
| ENT-02 | Offline on-prem install | ⏳ P2 · Goal: runs disconnected, documented and tested. Today: deterministic local provider (ADR-010), Ollama models and Docling local OCR. Open: an offline install guide and an end-to-end test with no network |
| AGT-01 | Supervised agentic RAG | ⏳ P3 · Goal: read-only, step cap, verification and budget. Today: the agent runtime (P1-01…04) already enforces `max_steps`, `usd_per_run`, a sandbox with simulated writes and verification checks. Open: a read-only multi-step retrieval mode in Ask |

Known open items before production: validate Textract, Transcribe and Bedrock (including Nova and Claude vision) in the real account
and Region (here they were tested with test doubles), validate Docling and its local OCR in the worker image, measure the
contribution of VLM descriptions with the real golden set, session refresh tokens, ADOT collector on ECS, CloudFront,
permissions pentest, and the legal and privacy gates of the checklist (section 20).

---

*AWS icons belong to Amazon Web Services and technology logos to their owners; see
[docs/assets/icons/README.md](docs/assets/icons/README.md). Local emulator: [AWS Emulator](https://github.com/aws/aws-emulator) (CC0-1.0).*
