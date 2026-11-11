# Security

Summary of the controls, where they live and how they are tested. The non-negotiable goal: **zero leakage between
tenants** (`ACL leakage = 0` in the golden set and in the isolation tests).

## Tenant isolation and permissions

| Control | Where | How it is tested |
|---|---|---|
| The tenant is resolved **only** by verified membership, never from the client. Non-member: 404. | `apps/api/src/lib/tenant.ts` | `apps/api/test/api.test.ts` |
| RLS **forced** on every customer table. | `db/migrations/0001_init.sql` | `tests/python/test_isolation.py` |
| Roles `ragsis_app` and `ragsis_worker` without `BYPASSRLS`. | `infra/docker/postgres/`, runbook [db-bootstrap](../ops/runbooks/db-bootstrap.md) | `test_isolation.py` |
| Document ACL applied **in SQL** before retrieval (ADR-008). | `services/rag-engine/…/retrieval.py` | `test_rag_flow.py`, adversarial golden set |
| Bounded `SECURITY DEFINER` functions. | `db/migrations/0002_member_lookup.sql` | `test_isolation.py` |
| The graph inherits the ACL of the source chunks (ADR-019). | `services/ingest-worker/…/graph.py` | `tests/python/test_graph_acl.py` |
| Graph vectors (`entity_source_embeddings`, `relation_source_embeddings`) follow the RLS of their provenance row and are deleted with it (ADR-029). | `db/migrations/0015_graph_embeddings.sql` | `tests/python/test_crossmodal_graph.py` |
| Recording transcripts are chunks: the transcript endpoint passes RLS + document ACL; a restricted tenant cannot send audio to a cloud transcriber (ADR-030). | `apps/api/src/routes/documents.ts`, `ragsis_ingest/pipeline.py` | `apps/api/test/folders.test.ts` (transcript case), `tests/python/test_audio.py` |
| Folders never grant access; counts and suggestions are computed under RLS, and document summary vectors follow the document ACL (ADR-031). | `db/migrations/0017_folders.sql`, `apps/api/src/routes/folders.ts` | `apps/api/test/folders.test.ts` |

What to do when a leak is suspected: [incident-cross-tenant.md](../ops/runbooks/incident-cross-tenant.md).

## Identity and session

- The `id_token` lives in an `httpOnly` cookie; JavaScript cannot read it. See [authentication.md](authentication.md).
- The API revalidates the token on every call: signature, issuer, audience, `token_use=id` and `email_verified`.
- Cognito accounts are invitation only; the role in each organization is granted separately.
- Internal API → rag-engine token: 60 s HS256 JWT, audience `ragsis-rag` (ADR-009).
- `rsk_…` service keys with scopes, workspace scoping, expiration, revocation and audit (ADR-014).
- Sign-in rejects non-JSON requests and does not distinguish between a nonexistent account and a wrong password.

## Documents and models

- **Upload:** presigned URL straight to S3; quarantine; magic byte and MIME validation (audio by container signature);
  macros and ZIP bombs; ClamAV.
- **Prompt:** document content is delimited and escaped; a document cannot give instructions to the system.
- **Citations:** the verifier requires every citation and every figure to be in the cited text; otherwise the system
  abstains.
- **Model policy by data classification:** `restricted` never calls external APIs and there is no silent fallback to the
  cloud. OCR (Textract) and transcription (Transcribe) are registered models and go through the same check, so a
  restricted tenant cannot send a scan or a recording to them.
- **AI-written text is labelled:** figure descriptions, table summaries, equation analyses and transcripts carry
  `ai_generated` or a notice in the source card, and numbers that are not in the source are removed from AI summaries.
- **PII:** redaction during ingestion and JSON logs with redaction. `query_runs` stores questions only as SHA-256. Ask
  history does store the text, private to its author, deletable and re-filtered by ACL on reload (ADR-028).
- **Audit:** per-tenant hash chain (`audit_events`).
- **Signatures:** Ed25519 seal, signature image with fingerprint in the certificate, public verifier that does not
  receive the files.
- **Connectors:** OAuth tokens encrypted with AES-GCM (AAD), PKCE and single-use `state`; Gmail visible only to its
  owner; on disconnect, access is revoked and indexed content is removed (ADR-025).

## Infrastructure

| Control | Where |
|---|---|
| Private, versioned S3 with SSE-KMS, TLS-only policy, public access block | `infra/terraform/modules/storage` |
| SQS and DLQ encrypted with KMS | same module |
| KMS with annual rotation | `envs/pilot/main.tf` |
| EC2 with IMDSv2 required and encrypted disk | `envs/pilot/main.tf` |
| Only 80 and 443 open (Caddy); no SSH, access through Session Manager | `envs/pilot/main.tf` |
| Least-privilege IAM per resource and per `tenants/*` prefix | `aws_iam_role_policy.runtime` |
| ECR with immutable tags and scan on push | `envs/pilot/main.tf` |
| Images by digest, not by tag | `infra/docker/compose.pilot.yml` |
| Trivy on the API image in CI (CRITICAL and HIGH) | `.github/workflows/ci.yml` |
| WAF with rate limiting and flow logs in the reference environment | `modules/edge`, `modules/network` |

## Secrets

- Never in Git. `.env`, `.env.*` and `*.tfvars` are ignored; only `.env.example` and `.env.pilot.example` are versioned.
- A key pasted in a chat, a ticket or a terminal history **is considered compromised**: rotate it before using it.
- External model provider keys: AWS Secrets Manager (≈ USD 0.40 per secret per month) or SSM Parameter Store with
  `SecureString` (no cost). The EC2 reads them with its role; the `.env.pilot` file holds the reference, not the value.
- `INTERNAL_SERVICE_SECRET` and the Postgres passwords must be kept when updating images so as not to break token
  signing or access to the volume.

## Open before production

Validate Textract, Transcribe and Bedrock (including Nova and Claude vision) in the real account and Region; add the
Transcribe IAM permissions to Terraform before turning audio on; validate Docling and its
local OCR in the worker image; session refresh tokens; ADOT collector on ECS; CloudFront; permissions pentest; and the
legal and privacy gates of the Master Plan checklist (section 20). The full status list is in the
[README](../README.md#status-against-the-master-plan).
