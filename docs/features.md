# Features

What Ragsis does today and how each capability is turned on. For how it is built, see
[architecture.md](architecture.md); for the variables, [configuration.md](configuration.md).

## AI models

By default everything runs **with no network or credentials** using the local deterministic provider (ADR-010).

- **Bedrock:** `AI_EMBEDDING_MODEL=bedrock-titan-embed-v2-1024@v1`, `AI_GENERATION_MODEL=bedrock-nova-lite@v1` (or
  `bedrock-claude-sonnet-5-5@v1`) and AWS credentials in the containers' environment.
- **On-premises or offline:** `ollama-*` models with `OLLAMA_BASE_URL`.

## API integrations

Administrators create `rsk_…` keys in *Governance* (or with `POST /v1/organizations/{org}/api-keys`) with scopes `query`,
`documents:read` and `documents:write`, and workspace scoping. Keys expire, can be revoked and are audited. Contract:
`packages/contracts/openapi.yaml`.

## Connectors (CON-01)

Gmail (personal, visible only to its owner), Slack and ClickUp (company-level, into a workspace). OAuth with PKCE,
encrypted tokens, delta sync with a cursor, tombstones and deletion on disconnect (ADR-025). Validation with real OAuth
apps is still pending. How to create each provider's apps: [connectors-setup.md](connectors-setup.md).

## Conversation history

Ask saves every question and answer in a conversation that is **private to the person who asks** (not even admins see
it). The *History* button lists the conversations, reopens them (the URL carries `?c=<id>`, so reloading returns to the
same place), renames them and deletes them permanently. If someone loses access to a cited document, or the document is
deleted, that turn appears hidden when the history is reopened. Continuing to ask in a reopened conversation does not
send the previous context to the model. Details and limits: ADR-028.

## OCR

`OCR_PROVIDER=textract` enables OCR for scanned PDFs and images on AWS and respects the tenant's data policy.
`DOCLING_OCR=true` gives local OCR with no network.

## Multimodal (RAG-04, ADR-018)

Formats: PDF, DOCX, PPTX, XLSX, PNG/JPEG, HTML, Markdown, TXT and CSV.

- **Tables** (including native Office charts converted to a table with their figures) and **equations** are chunks of
  their own with page, bbox and caption. They work without any extra model.
- **Figures:** `AI_VISION_MODEL=bedrock-nova-lite@v1` (or `bedrock-claude-sonnet-5-5@v1`, or `ollama-qwen3-vl-8b@v1` for
  restricted or on-premises tenants) describes them with document context and stores them as a citable S3 asset. Without
  a VLM, a figure is indexed only if it has a caption or alt text.
- `PARSER_PREFERENCE=docling` (with `docling` installed in the worker image) adds layout, PDF tables, formulas and bbox.
  `DOCLING_OCR=true` gives local OCR with no network.
- **Query:** with a vision-capable generator, the images of cited figures are attached to the model
  (`RAG_VLM_ENHANCED`). The citation verifier still requires every figure to be in the evidence text.

## GraphRAG (RAG-05, ADR-019)

Enabled per plan (business or private) or per organization:

```
PATCH /v1/organizations/{org}/settings   {"graph_mode": "on" | "off" | "inherit"}
```

Ingestion extracts entities and relations per chunk with `AI_GRAPH_MODEL` (default `local-graph-heuristic@v1`, offline;
or an LLM allowed by the tenant's policy). Every entity or relation is visible only if the person can read at least one
source chunk, and its descriptions are built only from visible sources.

At query time, `mode` can be `auto`, `off`, `local`, `global` or `hybrid`; citations are still chunks.
To populate the graph after enabling it: `make reindex ARGS="--org <uuid> --mode graph"`.

## Reindex

```bash
make reindex ARGS="--org <uuid> --mode embeddings --model <id> --dry-run"
```

See [reindex.md](../ops/runbooks/reindex.md).

## Onboarding and Agent Studio (ADR-020, ADR-021)

When an organization is created, the web opens **Setup** (`/app/{org}/onboarding`): nine resumable steps (sector,
goals, documents, privacy, spaces, suggested agents, controlled test and activate). Recommendations come from
deterministic presets per sector; activating does not publish agents or enable external actions.

Commercial qualification (sector, size, buyer, initial users, document sources, pain signals and origin channel) is asked
on the sign-up screen, before entering the app, and produces an internal score that the API does not expose.

**Agent Studio** (`/app/{org}/agents`) creates agents from templates or from scratch, validates the definition against
the tenant's policy, tests it in a sandbox (real search with your ACL, simulated writes) and publishes immutable
semantic versions.

## Workflows with human review (ADR-022)

`/app/{org}/workflows` chains published agents with human review, approval gates and conditions; each version pins the
version of its agents. Runs are started with `Idempotency-Key`, execute with the permissions of whoever starts them and
wait in the **Inbox** of whoever holds the functional role (assigned in *Governance → Roles*). An approval is tied to the
hash of what was reviewed and to the cited document versions; a rejection stops the run. **Activity** shows the
timeline, decisions and events of each run.

## Ragsis Sign (ADR-023, ADR-024)

`/app/{org}/signatures` lets you create envelopes with a PDF from the Library or generate them from a workflow. A second
user with permission approves the sending. Each signer reviews the pinned copy of the document, types their name and
agrees to sign with their verified account or through a personal email invitation.

When finished, the app generates a PDF with the signature sheet and an audit certificate sealed with Ed25519. The public
verifier `/sign/verify` compares the files against the recorded fingerprints without uploading them. Shared links and
external invitations respect the domains authorized in *Governance → External sharing*.

In **Signatures → My signatures** you can save up to six PNG or JPG images and pick one when signing. You can also
upload an image for a single envelope, even as a guest. The image is embedded in the final sheet and the certificate
records its fingerprint. Simulator envelopes remain available as history.

**Email on AWS.** To send invitations and completion notices, set `signature_email_from` and
`signature_email_identity_arn` in Terraform with a verified SES identity in the API's Region and with production access.
In a direct installation, the API receives `SIGNATURE_EMAIL_FROM`, credentials with `ses:SendEmail` and `PUBLIC_BASE_URL`
with HTTPS. Development mode offers test links when an invitation is regenerated.
