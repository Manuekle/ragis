# Development guide

## Requirements

| Tool | Version | Used for |
|---|---|---|
| Docker (Compose v2) | recent | Local stack, ClamAV, Postgres |
| `uv` | recent | Python environment and dependencies (3.12, see `.python-version`) |
| `pnpm` | 12.x (`packageManager`) | Node workspace |
| Node | 24 or later | API and web |
| Terraform | 1.9.x | Infrastructure (CI uses 1.9.8) |
| Floci | 2.x | Infrastructure rehearsal ([guide](guides/floci.md)) |

## First run

```bash
make up            # creates .env with random secrets and brings everything up
```

- Web: <http://localhost:3000> (sign in with any email)
- API: <http://localhost:4000> (contract in `packages/contracts/openapi.yaml`)
- With traces: `make up-obs` and <http://localhost:16686>

To rebuild only the API and web after a change:

```bash
docker compose -f infra/docker/compose.yml --env-file .env up -d --build --wait api web
```

Compose applies the migrations before starting the API.

## Test user and data

With the stack up (`make up`), create a sample organization ready to try Ask:

```bash
make seed        # idempotent: if it already exists, it only repeats the quick Ask check
```

| What | Value |
|---|---|
| Sign-in | <http://localhost:3000/login>, development mode: **no password**, type the email |
| Owner | `prueba@ragsis.test`: sees everything, including the documents of the Socios (partners) group |
| Reader | `lector@ragsis.test`: member with the reader role; does **not** see the partners' minutes (to test permissions) |
| Organization | "ACME Demo (local)" with GraphRAG enabled, nine documents from the `eval/corpus/acme` corpus |

These emails exist only in your local database; they are not in Cognito or AWS. To start over: `make down` and delete
the Postgres volume (`docker volume rm ragsis_pgdata`), then `make up` and `make seed`.

Questions to try in **Ask**. The sample corpus is in Spanish, so type the questions as written; the middle column is
only a translation for reference.

| Question (type this) | Meaning | What should happen |
|---|---|---|
| ¿Cuál es el monto máximo de viáticos nacionales por día? | What is the maximum domestic per-diem amount per day? | Answers 180000 with a citation to «Política de viáticos» |
| ¿Cuántos días de vacaciones tiene cada colaborador por año de servicio? | How many vacation days does each employee get per year of service? | 15 business days, cites the work regulations |
| ¿Cuál es el margen operativo de la región Caribe? | What is the operating margin of the Caribbean region? | 12.5 %, cites «Indicadores comerciales» (XLSX table) |
| ¿Quién está a cargo de la oficina que autoriza las suscripciones de software en la nube? | Who runs the office that authorizes cloud software subscriptions? | Camila Rojas (joins two documents through the graph) |
| ¿Qué distribución de utilidades aprobó la junta de socios? | What profit distribution did the partners' board approve? | Owner: 30 %. Reader: abstains (permissions) |
| ¿Cuál es la política de teletrabajo para empleados en Japón? | What is the remote-work policy for employees in Japan? | Abstains: no evidence |
| hola · gracias · ¿qué puedes hacer? | hi · thanks · what can you do? | Fixed friendly reply, no citations, no model or quota usage |

### What "AI" there is locally

By default the provider is **local and deterministic** (ADR-010): retrieval, permissions, citations and abstention are
real, but the answer is **extractive** (it copies the sentence from the evidence with the prefix "According to the
documents"); it does not write with an LLM. It is enough to test the full flow with no network or downloads.

### Answers written by Ollama (qwen3:8b)

To have a real model write the answer without leaving your machine:

```bash
ollama pull qwen3:8b                    # about 5 GB, one time only
# in .env (embeddings stay local: no need to reindex)
AI_GENERATION_MODEL=ollama-qwen3-8b@v1
docker compose -f infra/docker/compose.yml --env-file .env up -d --build --force-recreate --no-deps rag-engine
```

`AI_DEFAULT_PROVIDER` does not choose the model; `AI_GENERATION_MODEL` and the other `AI_*_MODEL` variables do. To go
back to extractive mode, delete that line from `.env` (or set `local-extractive@v1`) and recreate `rag-engine`. Compose
passes `OLLAMA_BASE_URL=http://host.docker.internal:11434` to the containers.

What was observed with `qwen3:8b` on an Apple Silicon Mac (2026-11-10), with the ACME Demo corpus:

| Aspect | Result |
|---|---|
| Latency per question | 2 to 4 s with the model already loaded; the first one after a period of inactivity can take longer while Ollama loads it |
| Language | Answers in Spanish when the question is in Spanish (the prompt reinforces it) |
| Citations, permissions and abstention | Same as in extractive mode: the verifier still requires the citation and figures to be in the evidence |
| Multi-hop with the graph | Works (for example "Camila Rojas"), with a hit rate of 0.75 on the golden set's multi-hop questions |
| Golden set (23 questions, `make eval`) | Meets every pilot target: accuracy 1.00, evidence hit rate 0.94, citation precision 1.00, abstention 1.00 / 1.00 and ACL leakage 0 |
| Latency on the golden set | Median 7.7 s and p95 31 s: the context with graph hops is larger and the model runs on the same machine as the rest of the stack |

If the machine is saturated (Docker, simulators and other apps at the same time), an answer can take tens of seconds.
The API waits up to 2 minutes for the query engine and, if that runs out, responds `504 rag_timeout` ("The answer is
taking too long…") instead of an internal error. The local stack services restart on their own
(`restart: unless-stopped`) and the API's Postgres pool tolerates dropped idle connections.

Two adjustments were needed and are already in the code: the Ollama provider sends `think: false` (without it qwen3
spends the token budget reasoning: 12 to 55 s answers and intermittent abstentions) and the prompt adds "Responde en
español." ("Answer in Spanish.") when it detects a Spanish question.

## Commands (`make`)

| Command | What it does |
|---|---|
| `make up` / `make down` / `make logs` | Brings up, shuts down and follows the logs of the local stack |
| `make up-obs` | Same as `up`, with Jaeger |
| `make infra` | Only Postgres, S3 and SQS (to develop without the app containers) |
| `make test` | `test-py` + `test-api` against real Postgres and S3 |
| `make e2e` | Provisions two tenants, ingests the corpus and evaluates the golden set against the pilot targets |
| `make eval` | Golden set against the running stack |
| `make reindex ARGS="--org <uuid> --mode embeddings --model <id> --dry-run"` | Reindex ([runbook](../ops/runbooks/reindex.md)) |
| `make mock-oidc` | Test OIDC IdP at <http://localhost:9000> |
| `make tf-validate` | `terraform validate` of the `dev` environment in Docker |
| `make rehearse-plan` / `rehearse` / `rehearse-destroy` | Terraform rehearsal in Floci |
| `make diagrams` | Regenerates the SVGs in `docs/diagrams` |

## Repository map

```
apps/
  web/                Next.js 16: UI and BFF (login, session, /api/auth/* routes)
  api/                Fastify: routes, authZ, uploads, agents, workflows, signatures, connectors
services/
  rag-engine/         FastAPI: query (full text + vectors + graph, fusion, generation, verifier)
  ingest-worker/      SQS consumer: validation, parsing, OCR, speech to text, chunking, graph, embeddings, index
  ai-gateway/         Model registry, residency policy, providers (local, bedrock, ollama)
packages/
  ragsis-core/        Settings, DB with RLS context, internal token, telemetry
  contracts/          OpenAPI v1
  policy/             Authorization test index
db/migrations/        0001…0017: schema, forced RLS, bounded functions
infra/
  docker/             compose.yml (local), compose.pilot.yml (pilot), Caddyfile.pilot
  terraform/
    modules/          network, security, storage, database, compute, edge, observability
    envs/dev          Reference environment (ECS Fargate, ALB, RDS, WAF)
    envs/pilot        Low-cost pilot (one EC2)
ops/runbooks/         Operational procedures
eval/                 Golden set, sample corpus and metrics harness
docs/                 This documentation, ADRs, diagrams and icons
scripts/              dev-env.sh, e2e.py, aws-rehearsal.sh
tests/python/         pytest: isolation, ingestion, RAG, multimodal, audio, graph, traces
```

## Tests

| Suite | Where | Covers |
|---|---|---|
| Python | `tests/python/` | RLS isolation, ACL in retrieval, RAG flow, multimodal, audio, cross-modal graph, reindex and OCR, traces |
| API | `apps/api/test/` | Tenancy and roles, OIDC, signatures, Agent Studio, workflows, connectors, conversations, folders and transcripts |
| Web types | `pnpm --filter @ragsis/web lint` (`tsc --noEmit`) | The web has no test suite; it is validated with types |
| E2E | `make e2e` | Full stack with the golden set (`eval/golden/sample.yaml`) |

The Python and API suites need `make infra` (or `make test`, which brings it up).

Pilot targets measured by `make e2e`: accuracy ≥ 0.85, evidence hit rate ≥ 0.85, citation precision ≥ 0.95,
abstention ≥ 0.90 and **ACL leakage = 0**. The sample golden set is synthetic and small; targets are measured with 100
to 200 real questions per vertical.

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request and on `main`:

1. **test:** ephemeral environment (Postgres, S3, SQS), `ruff`, `pytest`, API types and tests, web types, full stack and
   E2E against the pilot targets.
2. **terraform:** `terraform fmt -check` and `validate` of the `dev` environment.
3. **supply-chain:** builds the four images and scans the API one with Trivy (CRITICAL and HIGH).

## Conventions

- **Decisions:** every substantial change comes with an ADR in [adr/README.md](adr/README.md).
- **Migrations:** always forward-only and compatible with the previous version (nullable column, backfill, then
  constraint). They are applied with the owner role.
- **Security first:** a new query goes through the tenant resolved in the API and through RLS; never trust client data.
  Add a negative test.
- **Secrets:** never in Git or in its history; see [security.md](security.md).
- **Language:** the README and all documentation are written in English; the UI is plain English for non-technical
  people, with expert options inside "Advanced" with sensible defaults.
- **AWS:** every infrastructure change is rehearsed first in Floci ([guides/floci.md](guides/floci.md)).

## Recipes

**Add a migration.** Create `db/migrations/00NN_name.sql`, apply it with `make up` (or the `migrate` service) and add a
test in `tests/python/test_isolation.py` if it touches customer tables.

**Add a configuration variable.** Declare it in `apps/api/src/config.ts` (API) or `settings.py` (Python), pass it in
`compose.yml` and `compose.pilot.yml` if needed, and document it in [configuration.md](configuration.md).

**Add a model provider.** Implement the provider in `services/ai-gateway/src/ragsis_ai/providers`, register it in
`registry.py` and cover its residency policy in `policy.py`.

**Add an AWS resource.** Write it in the Terraform module, rehearse it with `make rehearse` and only then run
`terraform plan` and `apply` in real AWS.

**Add a diagram or an icon.** [diagrams/README.md](diagrams/README.md) and
[assets/icons/README.md](assets/icons/README.md).
