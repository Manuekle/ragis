# Decision records (ADR)

ADR-001 to ADR-007 come from the Master Plan (section 17). ADR-008 onward document decisions made during the
implementation of F1/F2.

| ADR | Decision | Reason | Revisit when… |
|---|---|---|---|
| 001 | ECS Fargate > EKS in the MVP | Lower operational complexity | Specialized scheduling / GPU at scale is needed |
| 002 | RDS PostgreSQL + pgvector | One DB, transactional ACL, RLS | Corpus/QPS exceeds the benchmark (HNSW saturated) |
| 003 | Bedrock through our own AI Gateway | Multi-model, AI governance | Cost/latency or residency demand it |
| 004 | RAG engine behind an adapter | Avoid lock-in with RAG-Anything/LightRAG | Framework migration |
| 005 | GraphRAG not on by default | Cost of maintaining relations | Multi-hop beats hybrid on the golden set |
| 006 | Secure pool; dedicated as premium | Economies of scale | Regulatory requirements / no-isolation |
| 007 | Read-only retrieval in the MVP | Risk of agents with tools | Permission control and approval exist |

## ADR-008 · ACL enforced in the database, not only in the app

**Decision.** Every table with customer data has **forced** RLS. For `ragsis_app` (API and rag-engine) the policies of
`documents`, `document_versions`, `chunks` and `chunk_embeddings` require the tenant **and** a principal of the user in
`document_acl`. The worker (`ragsis_worker`) only has the tenant boundary. No application role has `BYPASSRLS`.

**Reason.** Plan section 05: "data segregation is not the same as strong authorization". A bug in an app `WHERE` clause
cannot leak documents between tenants or within a tenant. Retrieval also filters by principals explicitly (defense in
depth).

**Consequence.** Tenant-wide aggregates (quotas) use `SECURITY DEFINER` functions that only return numbers for the
active tenant (`app.tenant_corpus_stats`).

## ADR-009 · Internal API → rag-engine token

**Decision.** The API resolves identity, membership, tenant and principals, and issues a 60 s HS256 JWT
(`aud=ragsis-rag`). The rag-engine does not accept tenant/principals from any other source.

**Revisit when** there are more internal services: migrate to Service Connect mTLS or KMS-signed (asymmetric) tokens.

## ADR-010 · Deterministic local provider for development and minimal on-prem

**Decision.** The AI Gateway includes `local-hash-1024@v1` (embeddings by feature hashing), `local-extractive@v1`
(extractive answer with citations) and `local-lexical-rerank@v1`.

**Reason.** It lets the whole system, the tests and the evaluation run with no network, GPU or credentials, and offers a
100 % offline path. It is **not semantic**: production uses Bedrock (Titan v2 / Cohere multilingual, Nova/Claude) or
Ollama (BGE-M3, Qwen3).

**Consequence.** All supported embedding models produce 1024 dimensions; `model_version` separates vector spaces and they
are never mixed (no embedding fallback).

## ADR-011 · Claude on Bedrock through the official Anthropic SDK

**Decision.** Claude models on Bedrock are invoked with `AnthropicBedrockMantle` (`anthropic` SDK); Nova and embeddings
through `bedrock-runtime` (Converse / InvokeModel). Refusals (`stop_reason=refusal`) trigger the gateway fallback
**only** to models allowed by the tenant's policy; if none is left, the query abstains.

## ADR-012 · SeaweedFS as local S3

**Decision.** MinIO stopped publishing community images; the local environment uses SeaweedFS (S3 compatible, presigned
URLs and CORS). On AWS, real S3 is used (`storage` module).

## ADR-013 · Chunking and tokenization without tiktoken

**Decision.** Token estimation by words/characters (conservative) for chunking and budgets; the exact count is reported
by the provider. This avoids depending on the tiktoken cache in disconnected deployments (risk listed in section 03).

## ADR-014 · Service API keys (API-01)

**Decision.** Format `rsk_<prefix>_<secret>`; the DB stores only the prefix + SHA-256 of the secret. Each key has scopes
(`query`, `documents:read`, `documents:write` ⊇ read), a list of workspaces, an expiration (≤ 365 days) and immediate
revocation. It is resolved with `app.resolve_api_key` (SECURITY DEFINER) before the tenant is known and acts as a service
user (`users.identity_provider='ragsis-apikey'`) with principals only from its workspaces: it never sees documents
restricted to groups. Routes declare `config.scopes`; a route without scopes does not accept keys (administration,
members, audit, key creation).

## ADR-015 · Web OIDC login in the BFF (Authorization Code + PKCE)

**Decision.** The Next.js BFF runs the flow (state, nonce, PKCE S256), verifies the `id_token` with the IdP's JWKS
(issuer, audience = client_id, nonce) and stores it in an httpOnly cookie; the browser never sees tokens. The API
revalidates the same `id_token` on every call and requires `email_verified` and `token_use=id` (Cognito). RP-initiated
logout through `end_session_endpoint` if the IdP publishes it. `apps/api/src/scripts/mock-oidc.ts` emulates an IdP for
development and tests.

**Revisit when** long sessions are required: add server-side encrypted refresh tokens.

**Update.** With Cognito the sign-in form lives in the app itself; this redirect flow remains for other OIDC IdPs. See
[ADR-026](#adr-026--in-app-login-with-cognito-user_password_auth).

## ADR-016 · OCR with Amazon Textract as the first multimodal path (F3)

**Decision.** Pages with < 40 characters of digital text are sent to asynchronous Textract over the existing S3 object.
Quality gate: lines with confidence < 60 are discarded; the provider and mean confidence are stored per version and
`ocr_pages` are counted. Textract is a cloud service registered in `ModelRegistry` (`aws-textract@v1`): the tenant's data
policy decides (restricted = never). Without OCR enabled, a mostly scanned PDF fails with `ocr_required` instead of being
indexed empty.

**Revisit when** offline OCR (Docling/PaddleOCR on a GPU worker) or tables/figures (RAG-04) are needed.

## ADR-017 · Manual OpenTelemetry traces

**Decision.** Manual instrumentation (no auto-instrumentation of ESM modules): one span per request in the API with the
route template, spans per stage in the rag-engine (`rag.embed/retrieve/rerank/generate/verify/persist`) and per job in
the worker. W3C propagation: API → rag-engine by header and API → worker by the `traceparent` field of the SQS message.
Attributes are pseudonymous only (UUIDs, models, counts); an automated test verifies the absence of text and emails.
OTLP/HTTP export only if `OTEL_EXPORTER_OTLP_ENDPOINT` is defined (local: Jaeger; AWS: ADOT collector).

## ADR-018 · Multimodal content (RAG-04) inside our own pipeline, not with RAG-Anything

**Decision.** The ideas of RAG-Anything are adopted (a list of typed text/figure/table/equation blocks with page, bbox
and caption; processors per modality; document context when describing figures; VLM-enhanced query) but implemented in
the existing pipeline, not as a dependency: its storage is LightRAG, outside pgvector and the RLS/ACL (ADR-004,
ADR-008).

- **Native parsers with no dependencies**: DOCX (figures + alt text, native charts, OMML equations, captions), PPTX
  (slide = page, bbox of images/tables, charts, speaker notes), XLSX (visible sheets, dates and percentages according to
  style), PNG/JPEG as a document, and JPEG/PNG images from digital PDFs. Native Office charts are converted to a **table
  with the figures from their cache**: exact, citable numbers without a VLM. External targets of OOXML relationships
  are never resolved (SSRF).
- **Optional Docling** (`PARSER_PREFERENCE=docling`, `docling` package installed in the worker image): layout, table
  structure, formulas and figures with bbox. If it fails or is not installed, the native parser is used with a warning.
  Its OCR is local (`DOCLING_OCR=true`): an offline OCR path for `restricted` tenants. MinerU is not adopted because of
  its license (AGPL) in a SaaS; revisit if that changes.
- **Figures**: filter by minimum size, duplicates (SHA-256), per-document cap and pixel limit (bombs); description with
  the VLM from `AI_VISION_MODEL` filtered by the tenant's policy (no allowed VLM → caption/alt text only; an image from
  a restricted tenant is never sent to the cloud). The image is stored at
  `tenants/<org>/assets/<doc>/<ver>/<sha>.<ext>` (a DB CHECK prevents leaving the tenant prefix); deletion purges the
  prefix. A full reindex reuses descriptions by SHA-256.
- **Tables**: optional summary (`INGEST_TABLE_SUMMARIES`) in which sentences with figures that are not in the table are
  discarded before indexing.
- **VLM-enhanced query** (`RAG_VLM_ENHANCED=auto`): if the generator has vision, the images of figures **already
  selected as evidence** (authorized by RLS + ACL) are attached (max. 3), labeled with their [n]. The citation verifier
  is **not relaxed**: every figure in the answer must be in the evidence text (description included); whatever the model
  reads only in the image and is not in the text is discarded.
- **Transparency**: citations expose `kind`, `bbox`, `caption`, `has_asset` and `ai_generated`; the web marks
  AI-generated evidence and shows the figure with a short signed URL (`GET /chunks/{chunk}/asset`, audited).

**Revisit when** the real golden set (F0/F2) measures the contribution of the VLM description versus caption only, or
figure bbox is needed in PDFs without Docling (requires interpreting the content stream).

## ADR-019 · GraphRAG (RAG-05) inside Postgres with ACL derived from the chunks

**Context.** ADR-005 leaves GraphRAG off by default; ADR-004/018 reject LightRAG/RAG-Anything as a dependency because
their graph and summaries live outside pgvector and the RLS/ACL. A graph's own risk is **leakage between documents with
different ACLs**: an entity or a global summary built from document A (public) and B (restricted) reveals B to someone
who can only read A.

**Decision.** The ideas of LightRAG (per-chunk entity/relation extraction, local/global/hybrid modes) are adopted and
implemented in Postgres (`db/migrations/0005_graphrag.sql`) under this ACL model:

- **Mandatory provenance.** `entities` and `relations` store only their key (`normalized_name`; pair of endpoints), a
  deterministic function of any of their mentions. Display name, type, description, keywords and weight live in
  `entity_sources` / `relation_sources`: one row per source chunk with the chunk's `document_id`. A trigger prevents
  tying a provenance row to a document/tenant/workspace different from that of its chunk.
- **Derived visibility.** RLS forced on the 4 tables. A source is visible if the user can read the document of its chunk
  (same rule as `chunks`); an entity/relation is visible only if it has **at least one visible source** (explicit
  EXISTS against `document_acl`, without relying on nested RLS). The worker sees per tenant; `ragsis_app` only reads.
- **Nothing global.** There are no merged descriptions, community summaries or precomputed degrees. Everything servable
  (display name, aggregated description, scores, neighbor degree, bridge names) is computed at query time using only
  sources visible to that user. An entity shared between A and B, seen by a reader of A, only shows mentions from A.
- **Deletion.** Sources cascade with their chunk (deletion, full reindex, failure); the worker collects the orphaned
  keys (already invisible) in the same commit.
- **Extraction** (`ragsis_ingest/graph.py`) after chunking, one `AIGateway.generate` per chunk (text/table;
  figure/equation since ADR-029) with `AI_GRAPH_MODEL` and the tenant's policy: with no allowed model (e.g. `restricted` with a cloud model) or with the
  provider down → no graph and a warning in the audit (`graph_skipped_policy`); ingestion continues. Only mentions that
  appear literally in the chunk and relations between them are accepted. `local-graph-heuristic@v1` (proper nouns and
  acronyms) is the deterministic offline path (ADR-010).
- **Query** (`retrieval.graph_search`): *local* = entities that match the question + relations and 1-hop neighbors;
  *global* = relations that match by keywords/description + their endpoints; *hybrid* = both. Each list of chunks enters
  the same RRF as vector + full-text and goes through all the filters again (tenant, workspace, active, current version,
  ACL, `as_of`). **Citations are still chunks** and the verifier does not change.
- **Hop evidence.** Bridge = entity mentioned in the strong evidence whose visible mention (description from that
  source) is the most relevant to the question without already being named in it (max. 3). A chunk that arrives only
  through the graph and does not pass the threshold enters (max. 2) only if it mentions a bridge. Without strong
  evidence it abstains as before. Bridge names (`GenerationRequest.hints`) are used only by the local extractive
  generator to choose the second-hop sentence (it must share some term with the question); they do not enter an LLM
  prompt.
- **Enablement.** `plans.graph_enabled` (team=false; business/private=true) with the override
  `organizations.graph_mode` (`inherit|on|off`) through `PATCH /v1/organizations/:org/settings` (admin, audited). The
  API signs the `graph` claim; the client only chooses `mode` (`auto|off|local|global|hybrid`). Enabling it does not
  reprocess: backfill with `make reindex ARGS="--org <uuid> --mode graph"`.

**Tests.** `tests/python/test_graph_acl.py`: a user without the group does not see entities/relations/provenance derived
only from the restricted document (not even by asking for them by name), the shared entity only adds visible mentions,
`graph_search` (3 modes) and the bridges never reach their chunks even if the app passed extra principals (session RLS
rules), the answer does not leak its content, tenant isolation and a positive control with the group. Golden set:
multi-hop questions (q19–q21, q23) and multi-hop ACL (q22); `multi_hop_accuracy` is informational.

**Revisit when** the real golden set measures multi-hop against hybrid (ADR-005 criterion), the LLM extraction cost
demands it (quotas per plan), or entities need to be matched by embeddings per source (today they match by full-text) or
homonym disambiguation is needed.

## ADR-020 · Sector onboarding and Agent Studio (milestones A, B, D of the agent specification)

**Context.** `Especificacion_Claude_Onboarding_Agentes_RAG.md` v1.0 (the onboarding and agents specification) asks for
adaptive onboarding by sector and an Agent Studio with declarative, versioned agents and governed tools, before
workflows, signatures and sending. ADR-007 (read-only retrieval in the MVP) remains in force for anything with real
effects.

**Decision.**
- **Same monolith, logical boundaries.** New routes in the Fastify API (`routes/onboarding.ts`, `routes/agents.ts`); a
  pure Policy Engine in `lib/policy.ts`; presets in `lib/presets.ts`; sandbox in `lib/agent-sandbox.ts`. No
  `agent-runtime` service yet (P1-01): there is no LLM planner or external action to justify it.
- **Data** (`0006_onboarding_agent_studio.sql`): `organization_profiles`, `onboarding_sessions` (state machine
  `NOT_STARTED → PROFILE_STARTED → DATA_SOURCES → SECURITY → WORKSPACE_READY → PILOT_TESTED → COMPLETED`, plus `PAUSED`
  and `NEEDS_REVIEW`), `agents` (mutable draft + `draft_hash`), `agent_versions` and `agent_test_runs`. RLS forced per
  tenant on all of them; versions and tests are **append-only** for `ragsis_app` (only `SELECT, INSERT`), and a trigger
  prevents tying a version/test to an agent of another tenant.
- **Knowledge Spaces = existing workspaces.** The model is not duplicated: suggested spaces are created as workspaces
  with their current ACL. Onboarding never overwrites spaces (case-insensitive name match) or agents (slug match).
- **Deterministic presets versioned in code** (`legal-v1`, …): (sector + goals + sensitivity + file types + deployment +
  plan) → spaces, RAG profile, suggested agents, model policy and notices. The snapshot (`template_version` +
  recommendation) is stored in the session. No LLM on this path.
- **Data policy.** Step 5 only **tightens** `organizations.data_class` (never relaxes it); `restricted` + cloud models is
  rejected. `restricted`, `local_only` or on-prem ⇒ agents with the `local` model profile.
- **Declarative agents** (`AgentConfig`, strict Zod): identity, instructions, knowledge, model profile (not brand),
  tool allowlist, autonomy (`suggest | draft_only | safe_execute | approval_required`), triggers, limits and test cases.
  Canonical hash (sorted keys) to tie tests and versions.
- **Deny-by-default Policy Engine.** Catalog with risk and availability: signing, sending, email, deletion and ACL
  change exist in the catalog but are **not available** (phase F or forbidden in the MVP) and never pass validation.
  Knowledge = intersection with the designer's workspaces (and the executor's at runtime), never an expansion.
  Instructions that ask to ignore policies, skip approvals, sign on someone's behalf or grant permissions are rejected
  (conservative es/en heuristic). Only the `manual` trigger until workflows.
- **Sandbox.** `search_documents` really runs through `runRagQuery` (the same governed path as `/query`: quota, rate
  limit, internal token with the user's principals) over effective spaces; every other tool is simulated (`mock`) and
  recorded in the trace. Retrieved text never decides tools or arguments. The question is persisted only as a SHA-256
  and the trace has no answer or fragments.
- **Publishing.** Requires validation with no errors and a `passed` test on the **exact hash** of the draft; semantic
  version, changelog, permission diff (`permissions_expanded`) in the audit. The agent owner or an admin publishes;
  `safe_execute` with writes requires an admin. Rollback revalidates against the current policy. Denials are audited
  (`agent.publish` / `deny`) in a transaction that does commit.
- **Roles.** `owner/admin/member/viewer` are kept: admin ≈ Knowledge Manager/Admin; member ≈ Agent Designer (creates own
  drafts); viewer only reads published agents. Reviewer/Approver/Signatory arrive with milestone E.

**Tests.** `apps/api/test/studio.test.ts` (22): pure Policy Engine and preset rules; full legal onboarding flow; case 10
(Legal → Mixed proposes without overwriting); case 3 (publishing without a test is denied and audited; test; 1.0.0);
simulated writes; an unavailable tool blocks; partial case 8 (a member does not widen scope and there is no retrieval
over foreign spaces); draft visibility; viewer cannot create; rollback/pause; immutability of `agent_versions` in the
DB.

**Revisit when** milestone E arrives (durable workflows + Approval Inbox + Reviewer/Approver roles), when an agent needs
to run outside the sandbox (P1-01 runtime with a real budget and per-step traces), or when the instruction heuristic
produces measurable false positives (replace with an evaluated classifier).

## ADR-021 · Commercial qualification at sign-up (is this a good customer?)

**Context.** The onboarding of ADR-020 configures the product, but does not say whether the organization fits the target
customer or where it came from. Target profile: 15–150 employees, 500+ documents, 5–30 initial users, purchase decided
by management with a budget, and pain signals (repeated searches, folders/servers/SharePoint/Drive, confidential
information, processes with several sources, measurable loss).

**Decision.**
- **Where each thing lives.** *Outside the app*, on the sign-up screen (`/app`, before the tenant exists): the commercial
  qualification, which is information about the company — sector, team size, who decides the purchase, initial users,
  document volume, where the documents live, pain signals and origin channel (Google, LinkedIn, Instagram, X, YouTube,
  Facebook, TikTok, WhatsApp, referral, event). It travels in `POST /v1/organizations` (`qualification`, validated with
  strict Zod); the sector catalog comes from `GET /v1/onboarding/catalog`. *Inside the app*, in Setup: product
  configuration — country/time zone, goals, document types, privacy and residency, spaces, agents, controlled test and
  activation. The internal wizard no longer accepts or asks for commercial fields.
- **No step renumbering.** If sign-up brings sector and size, step 2 is born resolved and the sector recommendation is
  already computed; the wizard jumps to the first pending step. Step 2 remains editable from Setup.
- **Logistics sector** and, per sector, **recommended RAG approach and likely deployment** (`SectorTemplate.approach`,
  `.deployment`). They are shown as a suggestion; privacy is **never preselected**. What is not yet built (controlled
  SQL, operational connectors) is marked `planned`. "Private cloud" and "dedicated cloud" share the value
  `private_cloud`; only the label changes.
- **Deterministic, internal score** (`lib/lead-fit.ts`, 0–100, `strong ≥ 70`, `possible ≥ 40`, `weak`). It is recomputed
  on every profile change and stored in `organization_profiles.lead_score/lead_tier` for operations. **The API does not
  return it to the client.** A profile without commercial answers stays unqualified (`NULL`), not `weak`.
- **Size bins** (`0009_team_size_bins.sql`): `1-14 / 15-50 / 51-150 / 151-500 / 500+`, aligned to the 15–150 range. Old
  values were reassigned to the nearest bin (approximate at the edges).

**Revisit when** there is real conversion data per channel and tier to recalibrate weights and align the size bins.

## ADR-022 · Durable workflows with human-in-the-loop (milestone E of the agent specification)

**Context.** Milestone E (P1-02 runner + Approval Inbox, P1-03 bounded delegation, P1-04 traces): chain published agents
with human review and approval, with no external actions yet (signing/sending = milestone F).

**Decision.**
- **Declarative DSL** (`lib/workflow-dsl.ts`, strict Zod): nodes `START | AGENT_TASK | HUMAN_REVIEW | APPROVAL_GATE |
  CONDITION | EXTERNAL_ACTION | WAIT_EVENT | END`, edges `[from, to]` or `[cond, to, "true"|"false"]` and policies.
  `deny_on_reject` and `no_external_action_without_approval` are literal `true` (they cannot be turned off). Pure
  validation: one START, a DAG without cycles, everything reachable, one exit per step (no parallelism in v1), a
  condition with true/false branches and a prior source, published and active agents, max. 3 hops per path
  (configurable 1–5), every external action preceded by a gate. `EXTERNAL_ACTION` and `WAIT_EVENT` exist in the DSL but
  do not validate until phase F.
- **Versioning.** `workflows` (mutable draft) + immutable `workflow_versions`; on publish each `AGENT_TASK` is **pinned**
  to the agent's current published version (`agent_version_id`): a run never changes agent midway.
- **Durable runner on Postgres** (`lib/workflow-runner.ts`). Each transition is persisted with a per-run
  `pg_advisory_xact_lock` before the next one; events (`WORKFLOW_RUN_STARTED`, `AGENT_RUN_STARTED/COMPLETED`,
  `APPROVAL_REQUESTED/DECIDED`, `WORKFLOW_COMPLETED/FAILED/CANCELLED`) go out through an **outbox** in the same
  transaction (section 14 schema: `event_id`, `correlation_id`, `aggregate_id`, `schema_version`, payload hash). An
  `AGENT_TASK` marks `RUNNING`, executes outside the transaction and persists again; when the API starts,
  `resumePending()` (a `SECURITY DEFINER` function that only returns ids) resumes half-finished runs. Human waits do not
  occupy a process (`WAITING_HUMAN`). On AWS this class is the seam for Step Functions Standard (approval callback) or an
  SQS consumer; dispatching the outbox to EventBridge is a pending adapter.
- **Agent execution in runs** (`executeAgent`, shared with the sandbox): permissions of the **initiator re-resolved at
  every step**; real `search_documents` with their ACL; writes remain as **proposals with no effect** (effects are
  authorized by a human step, never by the agent). Retries with backoff only for recoverable errors (RAG down/limited)
  up to the agent's `max_retries`, without duplicating the step or the event.
- **Bounded delegation.** The next agent operates on (its spaces ∩ the initiator's access) and only receives fragments
  from those spaces (`context_received.citations_withheld`); no spaces in common ⇒ `delegation_denied` without
  retrieval. Budget per run (`max_agent_calls`, `max_retrieval_calls`): exhausted ⇒ `FAILED budget_exhausted` and a
  notice in the initiator's Inbox.
- **Approvals with binding.** `approvals.binding` = run, node, next action, purpose, cited `{document_id, version_id}` and
  hash of the outputs; `action_hash` = canonical SHA-256. Deciding requires: an assigned functional role, the **exact
  hash** the screen showed, validity, that no cited version has changed (`app.current_versions`, ids only) and
  **separation of duties** (the initiator does not approve their own run; can be disabled per workflow with a notice).
  Rejection ⇒ `CANCELLED`, nothing downstream runs. Version change ⇒ `REVOKED` + `FAILED approval_invalidated`. Past due
  ⇒ `EXPIRED` (lazy on listing). Denials are audited with commit.
- **Functional roles** (`functional_roles`: reviewer, approver, signatory, auditor, agent_designer, knowledge_manager),
  assigned by an admin in *Governance → Roles*, in addition to the organization role.
- **Visibility and redaction.** A run is seen by the initiator, an admin, an auditor or whoever has an approval assigned by
  role. Agent outputs are shown only if the viewer can read **all** cited documents (RLS); otherwise the answer and
  fragments are hidden and the number of citations is reported.
- **Idempotency.** `POST …/runs` requires `Idempotency-Key` (unique per tenant); repeating returns the same run (200).

**Tests.** `apps/api/test/workflows.test.ts` (15): DSL (unpublished agent, cycle, phase F, hops, condition, fixed
policies); roles; version pinning and idempotency; happy path with SoD, stale hash and event sequence; case 4 (rejection
stops); case 5 (V2→V3 invalidates); an approver without access sees the task but not the content; case 8 (delegation
denied without retrieval + withheld fragments); case 9 (budget); retry without duplicating; paused agent; isolation and
immutability of `workflow_versions`.

**Revisit when** there is more than one API replica (lease per step or Step Functions), phase F arrives (gates tied to
`EXTERNAL_ACTION`, `WAIT_EVENT` with verified webhooks) or parallel branches are needed.

## ADR-023 · E-signature and controlled distribution (milestone F of the agent specification)

**Context.** P2-01 (signature adapter) and P2-02 (sharing). Rules from the specification: the AI never signs or simulates
consent; `SIGNED` only by a verified provider event; approval tied to hash, version, recipients, action and validity;
idempotent external actions; recipients on an allowlist with expiration and revocation.

**Decision.**
- **`ESignProvider` adapter** (`lib/esign.ts`): `createDraft / send / void / verify / parse / fetchEvidence`.
  - `docusign`: eSignature REST v2.1 with JWT grant (`jose`, RS256) and Connect with HMAC `X-DocuSign-Signature-*`;
    envelopes created with `status: "created"` (draft) and sent with `PUT status: "sent"`; evidence = combined PDF +
    certificate. Connect carries no event id: it is derived as `sha256(envelopeId|event|generatedDateTime)`. **Written
    against the public documentation; pending validation in a real sandbox account.**
  - `local` (development only, forbidden in production): the ceremony happens in the app — the signer, authenticated with
    the envelope's email, types their name and consents — and the provider issues the signed webhook (HMAC + timestamp
    ±5 min) through **the same verification path** as a real provider. The certificate records signers, consent, IP and
    hashes; the PDF is not stamped and is labeled as having no legal validity.
  - `disabled`: default in production without configuration; signing steps fail with `esign_disabled`.
- **Workflow nodes** (`EXTERNAL_ACTION`, `WAIT_EVENT SIGNATURE_COMPLETED`) executed by the orchestrator, never by an
  agent (agents with sign/share tools only propose). Graph validation: `create_signature_draft` requires a prior human
  review and is unique per run; `send_signature_envelope`, `share_document` and `send_email` require an `APPROVAL_GATE`
  **immediately before**; sending needs a prior draft and the wait needs a prior send.
- **Action binding.** The gate before an external action includes in its binding (and in the hash) the detail of what it
  authorizes: the envelope (id, signers, documents with SHA-256) or the normalized recipients, the artifact (signed copy
  or approved versions) and the expiration. On execution it is re-verified: approval `APPROVED`, more recent than
  `approval_max_age_hours`, exact match with the envelope/recipients and current document versions (if they changed, the
  envelope is voided). Approving the send requires MFA (`amr` from the IdP) if the tenant asks for it.
- **Lifecycle per version** (`document_lifecycle`): an approved human review ⇒ `APPROVED`; send ⇒ `SIGNATURE_PENDING`;
  verified completion event ⇒ `SIGNED`; share ⇒ `DISTRIBUTED`; envelope rejection/void ⇒ back to `APPROVED`. A signature
  is prepared only over `APPROVED` versions, read with the initiator's ACL and with the SHA-256 verified against the one
  recorded at ingestion.
- **Webhooks** (`POST /v1/webhooks/signatures/:provider`, raw body): HMAC before reading anything; envelope located by a
  `SECURITY DEFINER` function that only returns ids; `webhook_inbox (provider, event_id)` guarantees **one effect per
  event** (E2E case 6); monotonic transitions (`DRAFT < SENT < DELIVERED < COMPLETED|DECLINED|VOIDED`, terminals
  immutable); the evidence is downloaded before consuming the event (if it fails, the provider retries). A terminal
  event resumes or ends the waiting run (`signal`).
- **Sharing** (`shares`): one link per artifact, a 256-bit token of which only the SHA-256 is stored; the token is not
  logged: "Get link" **rotates** the token and shows it once (initiator/admin). Expiration ≤ `share_max_days`, immediate
  revocation, public access through a `SECURITY DEFINER` function that validates and **audits every attempt**, and
  delivers a 60 s presigned URL. Recipients only from `allowed_domains` (exact or subdomain; empty blocks everything),
  verified when the run starts and again on execution (E2E case 7, denial audited as `share.denied`); DLP: `restricted`
  documents never leave.
- **Email** (`send_email`) remains unavailable: the SES adapter would add a new dependency (`@aws-sdk/client-sesv2`);
  until then the link is delivered manually from *Signatures → Shared links*.

**Tests.** `apps/api/test/signatures.test.ts` (11): allowlist and HMAC/freshness; admin-only policy and case 7 at start;
review ⇒ `APPROVED` ⇒ `DRAFT` envelope with a gate tied to the envelope; signatory role and MFA; a forged or old webhook
changes nothing; ceremony ⇒ verified webhook ⇒ `COMPLETED` + certificate ⇒ the run continues; case 6 (repeat ⇒ one
effect); distribution of the signed document, token rotation, revocation (410) and access audit; case 7 at execution
after tightening the policy; voiding an envelope ends the run.

**Revisit when** DocuSign is validated in a sandbox (signature tabs, Connect per account, periodic envelope
reconciliation), email sending is needed (SES + templates), or a tenant requires qualified digital signature by
jurisdiction (eIDAS, local laws): **legal review per country before offering it as a service**.

## ADR-024 · Ragsis Sign

Ragsis manages e-signature inside the app. The DocuSign integration from ADR-023 is retired. Historical envelopes keep
their provider and their evidence. The `ESIGN_PROVIDER=local` simulator remains available in development to test the
milestone F webhooks.

- **Preparation and sending.** The app freezes the bytes and the SHA-256 of each PDF. A signatory or admin other than the
  author approves manual envelopes. Workflow envelopes go through their human gates. It checks that the versions are
  still current and requires MFA to approve when the tenant's policy says so.
- **Identity.** Members use their account with a verified email. For external people, the allowlist and the
  classification are checked on every access. The invitation is sent through SES, expires in seven days and can be
  regenerated. Regeneration invalidates the previous token. Voiding blocks the ceremony and future downloads.
- **Closing.** The envelope lock serializes responses and voiding. The last signature generates the PDF with a signature
  sheet and a JSON certificate with the consent, the identification method, the dates and the document fingerprints. The
  Ed25519 seal authenticates the platform's certificate. The workflow state and event are recorded in the same
  transaction. The certificate keeps the exact text of the names.
- **Verification.** `/sign/verify` compares the PDF and the optional certificate with their fingerprints in Ragsis,
  without transmitting the files. The public lookup requires the envelope's random ID and returns only fingerprints, key
  identifier and date. The seal covers the certificate attached to the PDF as a separate file.
- **Email.** The invitation queue in Postgres retries SES failures and sends a notice when the envelope is completed. SES
  may accept an email before the API records the send. A restart in that interval can duplicate the notice with the same
  link. The signing operation remains idempotent.

## ADR-025 · Gmail, Slack and ClickUp connectors (CON-01)

**Context.** CON-01 asks to bring live sources into the corpus with delta sync, cursors, backoff, rate limits, tombstones
and permissions. The user's priority: Gmail, Slack and ClickUp, **indexed** (not live tools). Gmail is personal email;
Slack and ClickUp are company spaces.

**Decision.**
- **Each item is a normal document.** `source_id = con:<connector>:<item>`, a new version only if the SHA-256 of the
  rendered content changes, and entry through the existing pipeline (S3 + `ingestion_jobs` + SQS). This way they inherit
  parsing, ACL through RLS, citations, versions, plan quotas and verifiable deletion. Granularity: Gmail = thread (without
  quoted text) + one document per supported attachment; Slack = channel × UTC day with threads inside the message that
  opens them; ClickUp = task (description + comments) and Doc (pages in Markdown).
- **Permissions.** Gmail is `personal`: ACL `user:<owner>`, `confidential`; not even admins see it (RLS also hides the
  connection). Slack/ClickUp are `organization`: an admin connects them for **one workspace** and the ACL is
  `workspace:<id>`. The source's fine-grained permissions are not replicated: that is why private Slack channels appear
  only if the bot was invited and private ClickUp spaces require explicit selection, with a notice in the UI. Connecting
  ClickUp with a service account that only sees what should be shared is recommended.
- **OAuth.** PKCE (Google) and a single-use `state`, 10 min, stored as SHA-256 and bound to person + organization. A
  single redirect `<PUBLIC_BASE_URL>/connect/callback`: a client page that completes with the session (the
  `SameSite=strict` cookie does not travel on cross-site navigation, but does on the same-origin fetch). Tokens
  encrypted with AES-256-GCM with AAD `org:connector` (`CONNECTOR_ENCRYPTION_KEY`, required in production; in dev it is
  derived with HKDF). Gmail uses only `gmail.readonly`; Slack a bot with read scopes; ClickUp has no scopes (it reads what
  the authorizer sees).
- **Scheduler in the API** (like the signature invitations): every minute `app.due_connectors()` (SECURITY DEFINER, ids
  only) → 10 min lease on the row (safe with several replicas; `CONNECTOR_SYNC_ENABLED=false` turns it off) → a bounded
  pass (4 min / 150 changes) that stores the cursor after each page. The work runs with the owner's RLS and the
  connector's ACL principal. Errors: revoked token ⇒ `reconnect_needed`; 429 ⇒ reschedule with `Retry-After`; quota ⇒
  retry in 6 h; others ⇒ exponential backoff and `error` after 8 failures.
- **Delta and deletions.** Gmail: History API; if the `historyId` expires, full load + sweep of what was not seen. Slack:
  daily advance per channel re-reading yesterday and today (edits, deletions and recent replies). ClickUp:
  `date_updated_gt` + ID reconciliation every 24 h (ClickUp does not expose deletions); Docs are listed on every pass
  and only downloaded if `date_updated` changed. Deselecting a channel/space removes its documents. Disconnecting
  revokes the token (best effort), marks everything as `deleting` (the worker purges chunks, embeddings and objects) and
  deletes credentials. If the owner of a Gmail leaves the organization, their email leaves the corpus on the next pass.
  An item deleted by hand from the library is not recreated.
- **Governance.** `organizations.allowed_connectors` (admin): disabling an app pauses its connections without deleting
  anything. Audit: connection, changes, syncs with changes, failures that require action and disconnection.
- **Demo mode** (`CONNECTORS_DEMO=1`, forbidden in production): an in-memory emulator of the APIs used, with sample data;
  the same emulator backs the tests.

**Known risks.**
- **Slack (May 2025):** commercially distributed apps outside the Slack Marketplace have `conversations.history` and
  `conversations.replies` limited to 1 call/min and 15 messages; internal single-workspace apps keep the normal limits.
  In addition, Slack's updated terms restrict the use of its API data; review with legal whether indexing messages in a
  multi-tenant SaaS product is allowed. Options: an internal app per customer (dedicated deployment) or publishing in the
  Marketplace.
- **Google:** `gmail.readonly` is a restricted scope: for external users it requires Google verification and a security
  assessment (CASA). An "Internal" Google Workspace app does not need it.
- Old Slack deletions (outside the re-read window) and new replies in old threads are not detected without the Events
  API.

**Tests.** `apps/api/test/connectors.test.ts` (20) against real Postgres and emulated APIs: encryption with AAD; PKCE,
single-use state bound to the same person; Gmail visible only to its owner (not even the admin sees email or connection),
no spam or promotions, delta with a new version, deleted thread ⇒ tombstone, expired history ⇒ reload without
duplicates, revoked token ⇒ reconnect, disconnect ⇒ revocation + removal; Slack pending channels, private ones only with
the bot inside, a channel-day document visible to the workspace, deselecting ⇒ removal; ClickUp non-private spaces by
default, edit ⇒ version, deletion ⇒ reconciliation, private ones by selection, organization policy.

**Revisit when** there are real OAuth apps (validate responses and limits), fine-grained permissions per channel/space
are needed (map source members to ragsis users), Events API/webhooks for immediate deletions, or more providers (Drive,
SharePoint): the `ProviderAdapter` + `SyncSink` contract is the extension point.

## ADR-026 · In-app login with Cognito (USER_PASSWORD_AUTH)

**Context.** The pilot used the Cognito hosted page. That page leaves the product: another brand, another language and a
third-party domain in the middle of sign-in. The classic Cognito style only allows limited CSS and a logo (the page
background stays fixed); the branding editor requires a different feature plan. People must sign in without leaving
Ragsis.

**Decision.** When `OIDC_ISSUER` is a Cognito user pool, `/login` shows its own form (email and password, a new password
for invited accounts and recovery by code). The `POST /api/auth/password` route calls, from the server, the Cognito
public API for clients without a secret (`InitiateAuth` with `USER_PASSWORD_AUTH`, `RespondToAuthChallenge`,
`ForgotPassword`, `ConfirmForgotPassword`). The session is still the `id_token` in an `httpOnly` cookie that the API
revalidates; the token of the `NEW_PASSWORD_REQUIRED` challenge travels in a 170 s `httpOnly` cookie. Other OIDC IdPs
keep the redirect from ADR-015. The Cognito client now allows `ALLOW_USER_PASSWORD_AUTH`.

**Consequences.**
- The password goes through the web server (over TLS) before reaching Cognito. It is the cost of controlling the screen;
  the SRP alternative would avoid the server seeing the password, but the form receives it anyway.
- The route requires `Content-Type: application/json` and does not distinguish nonexistent accounts from wrong
  passwords.
- Without refresh tokens, the session lasts as long as the `id_token` (one hour by default).
- There is no Cognito page to close on exit; logout only deletes the cookie.

**Revisit when** MFA, social sign-in or federation is needed: at that point it is worth going back to the redirect flow or
adopting Cognito managed login, which requires the Essentials plan.

## ADR-027 · Infrastructure rehearsal in Floci before AWS

**Context.** The pilot runs on AWS FREE plan credits (USD 100, six months). A misconfigured or forgotten resource spends
credits and each attempt on real AWS takes longer than locally.

**Decision.** Every resource or Terraform change is applied first against [Floci](https://github.com/floci-io/floci), the
local AWS emulator, with `scripts/aws-rehearsal.sh` (`make rehearse`). The script copies `infra/terraform` to
`infra/terraform/.floci/`, adds a provider override that points to the emulator and keeps a separate state; it never
touches the real AWS state. Only with a clean rehearsal are `terraform plan` and `apply` run on AWS. The local
application keeps using SeaweedFS and ElasticMQ (ADR-012), not Floci.

**Consequences.**
- Floci validates the shape of the calls and the dependencies, not real AWS behavior: it does not check prices, quotas,
  instance type availability or `user_data`. The pilot rehearsal with Floci 2.4.0 creates all 28 resources and a second
  `plan` has no changes; see [guides/floci.md](../guides/floci.md#known-limits).
- Its catalog does not include `m7i-flex.large`, so the rehearsal uses `m5.large` (same shape: 2 vCPU and 8 GiB) and
  real AWS uses the type in `main.tf`.
- With `AWS_ENDPOINT_URL` pointing to Floci, the AWS CLI does not reach real AWS; the variable must be removed to operate
  there.

**Revisit when** the emulator adds the pilot's instance types, or when the pilot becomes production.

## ADR-028 · Ask conversation history

**Context.** Ask answered well but the conversation lived only in the page's memory: on reload or exit it was lost and you
could not return to a previous answer. The platform stored only `query_runs` (trace, timings and the hash of the
question; the text was deliberately not persisted).

**Decision.** Tables `conversations` and `conversation_turns` (migration 0014), with RLS by organization and by author:
the conversation is **private to whoever writes it**, not even admins see it. Each turn stores the question, the "as of"
date and a snapshot of the answer (text, citations and visible metrics; never internal timings or costs). The client
generates the conversation UUID and sends it in `POST …/query` as `conversation_id`; the API creates it when saving the
first turn, so there are no empty conversations and no prior call. Saving happens after answering and never blocks the
answer: if it fails it is logged and the answer returns without `conversation_id`. `GET/PATCH/DELETE /conversations`
list (cursor-paginated), reopen, rename and delete; deleting is permanent, cascades to the turns and is audited. Service
keys do not use the history.

**Access governance on re-read.** The snapshot contains text generated from documents the person could see *that day*.
On reopening, the API re-checks with RLS that each cited document is still visible and active; if any is not (permission
withdrawn, document deleted) the turn is returned with `redacted: true` and without an answer. The rest of the
conversation stays readable. This way the history is not a route to read what the ACL no longer allows.

**Consequences.**
- The text of questions and answers is now stored (before, only a hash). It is user data: it is deleted when the
  conversation is deleted, when the user or the organization is deleted (cascade), and it is not logged
  (`req.body.question` is still redacted). The public privacy policy already covers it ("your questions and the answers
  generated" as customer content, retained while the organization keeps it).
- Hiding is evaluated on every read and is not stored: if the permission is granted again, the turn reappears.
- Questions remain independent: reopening a conversation and continuing to ask does not send the previous context to the
  model (same as before). Conversational memory for the model is a separate change.
- No automatic retention or per-organization option to turn it off; both are direct extensions if a customer with very
  sensitive data requires it.

**Revisit when** a customer asks for maximum retention or to disable the history, or when Ask passes prior context to the
model (then it must be decided which hidden turns are excluded from the prompt).

## ADR-029 · Cross-modal graph and modality-aware retrieval (ideas from RAG-Anything)

**Context.** The RAG-Anything paper (Guo et al., 2025) adds three things on top of LightRAG: a *cross-modal* graph where
every figure, table and equation is a node that anchors the entities found in it (`belongs_to`), fusion of that graph
with the text graph by entity name, and retrieval that reads modality cues in the question. Its own failure analysis
names "text-centric retrieval bias" as the main open problem. ragsis already had the parsing, the context-aware VLM
description, the text graph, hybrid RRF retrieval, reranking and images attached at generation (ADR-018/019), but
figures and equations were outside the graph and the question's modality was ignored. ADR-004/018 still apply: the
library is not a dependency.

**Decision.** Everything below reuses the provenance model of ADR-019: every row is tied to one source chunk and is
visible only to someone who can read that chunk's document.

- **Anchor nodes.** Graph extraction covers figure and equation chunks too (their indexed text: caption + VLM
  description, or LaTeX + analysis). Every non-text chunk adds one anchor entity (`type` `figura` / `tabla` /
  `ecuacion`) and a `pertenece_a` relation (weight 3) from each entity extracted from that chunk to the anchor. A
  non-text chunk with no entities of its own is still a node.
- **Deterministic, document-scoped names.** The anchor name is built by code, never by the model: the numbered label
  of the caption when there is one (`Figura 2 · <document title>`), otherwise page and chunk position. Two documents
  with their own "Figure 2" do not merge; a reindex yields the same key.
- **Entity summary written by the model.** The model that describes a figure or analyzes an equation ends with a
  `RESUMEN:` line; it is stored in `meta.entity_summary` and becomes the anchor's description (tables use their verified
  summary). Without one, the description is derived: caption plus the start of the text, or the column list of a table.
- **Equation analysis** (`INGEST_EQUATION_ANALYSIS`, off by default like table summaries). The generation model
  explains what the equation computes and what each variable means, using the nearby text. Sentences with a number that
  is neither in the equation nor in its context are dropped. The analysis is appended to the chunk, labelled as AI
  generated, and the citation carries `ai_generated`.
- **Intra-table graph** (`ragsis_ingest/table_graph.py`), deterministic and with no model. Row headers and column
  headers are nodes scoped to their table (the "2020" of one table does not merge with another's; two rows called
  "Total" stay apart). Relations: `fila_de`, `columna_de`, `unidad_de` (unit in parentheses in a header or in the
  caption) and one `celda` relation per cell whose description is `row / column = value unit`. Caps per table chunk:
  40 rows, 12 columns, 150 cells.
- **Fusion is the existing key.** `entities.normalized_name` is unique per workspace, so an entity named in a figure
  description and in a paragraph is one node with two sources.
- **Dense graph index** (migration `0015_graph_embeddings.sql`). `entity_source_embeddings` and
  `relation_source_embeddings` hold one vector per provenance row and model, in the same space as the chunks. What is
  embedded is the mention as it appears in *its* chunk, never a description merged across documents. Same RLS as the
  provenance tables, a trigger that ties each vector to its source row, cascade on deletion. `pertenece_a` rows are not
  embedded. `reindex --mode embeddings` dual-writes them for a new model and `--purge-model` removes them.
- **Graph seeds are lexical + dense.** `graph_search` adds the nearest entities/relations to the query vector to the
  tsvector matches; both lists are normalized and summed. Similarity has a floor (the model's evidence threshold), so
  an unrelated question seeds nothing.
- **Modality-aware fusion.** `prompting.modality_preference` reads lexical cues (figura, gráfico, tabla, columna,
  ecuación, fórmula and their English forms). Chunks of the requested kind get half a first-place vote in the RRF
  (`MODALITY_BONUS`), and if one passes the evidence threshold but would fall outside the cut it takes the last
  evidence slot. It only reorders candidates that already passed every filter and the threshold.
- **Graph facts in the prompt.** With the graph on, entities and relations whose source is one of the *selected*
  evidence chunks are added in a `<grafo>` block, each tagged with the `[n]` of its chunk, ranked by overlap with the
  question and capped by `RAG_GRAPH_CONTEXT_TOKENS`. Nothing from chunks outside the evidence enters, so every fact is
  citable and the verifier is unchanged: evidence and citations are still chunks.

**Consequences.**
- A question about a text passage can reach a figure through the shared entity, a question that names a row and a
  column matches that cell's relation instead of the neighbouring row, and a paraphrase with no shared words can still
  seed the graph.
- Cost per document with the graph on: one extraction call per figure and equation chunk (they count toward
  `GRAPH_MAX_CHUNKS_PER_DOC`), plus embedding tokens for entities and relations (metered as `embedding_tokens`). Tables
  add up to ~200 graph rows per chunk.
- `local-graph-heuristic@v1` no longer reads Markdown table rows as proper nouns; the intra-table graph models them.
- `PIPELINE_VERSION` is `ingest-2026.11.3`. Documents indexed before need `make reindex ARGS="--org <uuid> --mode
  graph"` (anchors, table structure, vectors) or `--mode full --only-stale` to also get entity summaries.
- `retrieved_refs` in `query_runs` records `kind` and `modality` per candidate, for evaluation.

**Not adopted.**
- *Model-chosen anchor names.* The paper lets the VLM name the entity; here the name stays deterministic so that
  reindexing is idempotent and two documents never collide.
- *Graph facts from chunks outside the evidence.* They could not be cited or verified.
- *One node per cell.* A cell is a relation between its row and its column; a node per cell would triple the rows for
  the same lookup.

**Revisit when** the evaluation set has multimodal questions that measure these paths separately, or when table chunks
with more than 150 cells need full coverage.

## ADR-030 · Audio recordings (speech to text with timestamps)

**Context.** Meetings, calls and voice notes hold decisions that never reach a document, and RAG-Anything lists audio
among its modalities. ragsis indexed only files with text or images. Transcription already has a pluggable shape in
the codebase: OCR runs through a provider that works on the object already stored in S3 (Textract, ADR-018), and the
tenant's data policy decides whether a cloud model may see the file.

**Decision.**
- **Formats:** MP3, WAV, M4A, OGG and FLAC. Validation checks the container by magic bytes (`ID3`/frame sync, `RIFF…WAVE`,
  `ftyp`, `OggS`, `fLaC`) against the declared extension and MIME type, like every other format.
- **Provider** (`ragsis_ingest/transcription.py`, `TRANSCRIPTION_PROVIDER`): `none` (default) or `transcribe`
  (Amazon Transcribe, asynchronous, reading the version's S3 object; the file does not pass through the worker again).
  The provider is a registered model (`aws-transcribe@v1`, cloud), so `require_allowed` applies the tenant's policy
  before the call: a `restricted` tenant cannot index audio until there is a local transcriber. Language is fixed
  (`TRANSCRIPTION_LANGUAGE`) or detected among `TRANSCRIPTION_LANGUAGE_OPTIONS`; speaker separation up to
  `TRANSCRIPTION_MAX_SPEAKERS`.
- **Quality gate:** words below `TRANSCRIPTION_MIN_WORD_CONFIDENCE` are dropped. A recording with no reliable speech
  fails with `no_speech_detected`; one longer than `AUDIO_MAX_SECONDS` fails with `audio_too_long`; audio with no
  provider configured fails with `transcription_required`. Each code has a plain-language message in the library.
- **Chunks keep their time range.** Provider segments are grouped into chunks of about 320 tokens without splitting a
  segment, breaking on long pauses (> 1.5 s) or segments longer than 45 s. Each chunk is `kind = 'audio'` with
  `meta.t_start`, `meta.t_end` and `meta.speakers`; its text is one line per segment, `[mm:ss] Hablante N: …`. Speaker
  labels tell voices apart; they are never names.
- **Paid once.** The normalized transcript is stored as a derived tenant asset (`…/transcript.json`). A full reindex
  reads it instead of transcribing again.
- **Schema** (migration `0016_audio.sql`): `chunks.kind` accepts `audio`; `document_versions` gains
  `duration_seconds`, `transcription_provider`, `transcription_language`; `usage_events.kind` accepts `audio_seconds`
  (the unit the provider bills).
- **Query:** audio chunks go through the same retrieval, graph (`GRAPH_KINDS`) and verifier as text. The prompt tells
  the model that `tipo="audio"` sources are automatic transcripts. Questions with cues such as "grabación", "llamada",
  "recording" or "call" prefer audio chunks (the modality bonus of ADR-029). Citations carry `t_start`/`t_end`.
- **Interface:** the viewer plays the original recording next to its transcript (`AudioView`): clicking a line plays
  from there, the line being spoken is highlighted, and a citation opens the recording at the cited moment without
  autoplay. `GET …/documents/:id/versions/:ver/transcript` returns the audio chunks under RLS + ACL. The source card
  says "Listen from mm:ss" and labels the transcript as written by AI.

**Consequences.**
- No derived audio files are produced; the original S3 object is what plays.
- Local development and the pilot run with `TRANSCRIPTION_PROVIDER=none`, so recordings there end in
  `transcription_required`. Turning on `transcribe` on AWS needs `transcribe:StartTranscriptionJob` and
  `transcribe:GetTranscriptionJob` for the worker role, plus read access to the documents bucket and write access to
  the derived-assets prefix (and the bucket's KMS key, if any). That IAM is not in Terraform yet.
- Cost per recording: Transcribe per second of audio, metered as `audio_seconds`, plus the usual embedding (and graph)
  tokens for the transcript.

**Not adopted.**
- *Local transcription (Whisper) in the worker image.* It would serve restricted tenants but adds a large model and CPU
  or GPU sizing to the worker; it fits behind the same provider interface when there is demand.
- *Speaker names.* Mapping voices to people needs consent and enrollment; numbered speakers are enough to follow a
  conversation.

**Revisit when** a restricted tenant needs audio, or recordings regularly exceed four hours.

## ADR-031 · Library folders with content-based suggestions

**Context.** The library was a flat list per workspace. People coming from shared drives expect folders, and a long
flat list makes uploads hard to find. Folders must not become a second permission system next to the document ACL.

**Decision.**
- **Folders only organize.** Access is still the document's ACL (`document_acl`). Moving a document never changes who
  can see it. Folder names are visible to the whole workspace; their contents are not: counts and listings are computed
  under RLS, so each person only counts what they can read.
- **Schema** (migration `0017_folders.sql`): `folders` (workspace-scoped, `parent_id`, up to 6 levels, no cycles, sibling
  names unique case-insensitively, no slashes) and `documents.folder_id` (`ON DELETE SET NULL`). Triggers keep folder and
  document in the same organization and workspace. Deleting a folder deletes its subfolders; no document is deleted,
  they go back to "No folder".
- **API** (`apps/api/src/routes/folders.ts`): list (with `document_count` and `unfiled_count`), create, rename or move,
  delete, `POST …/documents/move` (up to 200 documents, audited as `document.moved`), upload straight into a folder
  (`folder_id` on `…/documents/uploads`) and `folder_id` (or `none`) as a filter on the document list.
- **Suggestions.** For documents without a folder, one suggested folder or none:
  1. *Content:* each indexed document has a summary vector (`document_centroids`, the mean of its chunk vectors per
     embedding model, refreshed by the worker on indexing). It is compared with the mean of the documents in each
     folder. Thresholds: cosine similarity ≥ 0.45, or ≥ 0.6 when the folder holds a single document. Below that, no
     suggestion is better than a wrong one.
  2. *Name:* the folder name appears in the document title or text (full-text search). It covers new, empty folders.
  The centroid table has the same row-level rule as chunks (tenant + document ACL), so a document someone cannot read
  never shapes what is suggested to them. "No thanks" stores `folder_suggestion_dismissed_at`; moving the document
  clears it.
- **Interface:** breadcrumb trail, folder chips with counts, a "No folder" view, rename and delete on the current folder,
  a move dialog per document, and the suggestion as one line under the document title ("Looks like it belongs in …",
  "Move there", "No thanks"). Dropping files while inside a folder uploads them there.

**Consequences.**
- Retrieval ignores folders: a question searches every document the person can read, wherever it is filed.
- The migration backfills `document_centroids` for documents already indexed.
- Folder names can reveal that a topic exists even to people who cannot open its documents; that is the price of a
  shared structure and is stated in the move dialog.

**Not adopted.**
- *Folder permissions.* Two access systems that can disagree is how drives leak; the ACL stays the only one.
- *Automatic filing.* The suggestion is never applied without a person accepting it.
- *Uploading a whole folder tree from disk.* Folders are created in the app; a directory upload can map onto them later.

**Revisit when** workspaces regularly hold thousands of documents (bulk move, multi-select), or people ask for folder-level
sharing.
