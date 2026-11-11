DC = docker compose -f infra/docker/compose.yml --env-file .env

.PHONY: env up up-obs down logs test test-py test-api eval build-web tf-validate mock-oidc reindex rehearse-plan rehearse rehearse-destroy diagrams seed

env:            ## Generate .env with random secrets (does not overwrite)
	@test -f .env || ./scripts/dev-env.sh

up: env         ## Bring up the whole local stack
	$(DC) up -d --build --wait

up-obs: env     ## Stack + Jaeger with OTel traces (UI http://localhost:16686)
	OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318 $(DC) --profile observability up -d --build --wait

mock-oidc:      ## Test OIDC IdP at http://localhost:9000 (client_id ragsis-web)
	cd apps/api && MOCK_OIDC_CLIENT_ID=ragsis-web npx tsx src/scripts/mock-oidc.ts

reindex:        ## make reindex ARGS="--org <uuid> --mode embeddings --model <id> --dry-run"
	$(DC) exec ingest-worker python -m ragsis_ingest.reindex $(ARGS)

down:
	$(DC) down

logs:
	$(DC) logs -f --tail=100

infra: env      ## Dependencies only (Postgres, S3, SQS) for development/tests
	$(DC) up -d --wait postgres seaweedfs elasticmq

test: test-py test-api

test-py: infra
	uv run pytest tests/python

test-api: infra
	cd apps/api && pnpm test

e2e:            ## End-to-end test against the running stack (make up)
	uv run python scripts/e2e.py

eval:           ## Golden set against the running stack
	uv run python -m ragsis_eval.run --golden eval/golden/sample.yaml

tf-validate:
	docker run --rm -v $(PWD)/infra/terraform:/tf -w /tf/envs/dev hashicorp/terraform:1.9.8 init -backend=false -input=false
	docker run --rm -v $(PWD)/infra/terraform:/tf -w /tf/envs/dev hashicorp/terraform:1.9.8 validate

rehearse-plan:  ## Floci rehearsal: what Terraform would create (docs/guides/floci.md)
	./scripts/aws-rehearsal.sh plan

rehearse:       ## Floci rehearsal: create the pilot infrastructure in the emulator, before real AWS
	./scripts/aws-rehearsal.sh apply

rehearse-destroy: ## Floci rehearsal: delete what was created in the emulator
	./scripts/aws-rehearsal.sh destroy

diagrams:       ## Regenerate the SVGs in docs/diagrams
	python3 docs/diagrams/build.py

seed:           ## Local test user and data (ACME Demo org + 9 documents); idempotent
	uv run python scripts/seed-dev.py
