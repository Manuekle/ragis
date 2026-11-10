DC = docker compose -f infra/docker/compose.yml --env-file .env

.PHONY: env up up-obs down logs test test-py test-api eval build-web tf-validate mock-oidc reindex

env:            ## Genera .env con secretos aleatorios (no sobrescribe)
	@test -f .env || ./scripts/dev-env.sh

up: env         ## Levanta todo el stack local
	$(DC) up -d --build --wait

up-obs: env     ## Stack + Jaeger con trazas OTel (UI http://localhost:16686)
	OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318 $(DC) --profile observability up -d --build --wait

mock-oidc:      ## IdP OIDC de prueba en http://localhost:9000 (client_id ragsis-web)
	cd apps/api && MOCK_OIDC_CLIENT_ID=ragsis-web npx tsx src/scripts/mock-oidc.ts

reindex:        ## make reindex ARGS="--org <uuid> --mode embeddings --model <id> --dry-run"
	$(DC) exec ingest-worker python -m ragsis_ingest.reindex $(ARGS)

down:
	$(DC) down

logs:
	$(DC) logs -f --tail=100

infra: env      ## Solo dependencias (Postgres, S3, SQS) para desarrollo/tests
	$(DC) up -d --wait postgres seaweedfs elasticmq

test: test-py test-api

test-py: infra
	uv run pytest tests/python

test-api: infra
	cd apps/api && pnpm test

e2e:            ## Prueba end-to-end contra el stack levantado (make up)
	uv run python scripts/e2e.py

eval:           ## Golden set contra el stack levantado
	uv run python -m ragsis_eval.run --golden eval/golden/sample.yaml

tf-validate:
	docker run --rm -v $(PWD)/infra/terraform:/tf -w /tf/envs/dev hashicorp/terraform:1.9.8 init -backend=false -input=false
	docker run --rm -v $(PWD)/infra/terraform:/tf -w /tf/envs/dev hashicorp/terraform:1.9.8 validate
