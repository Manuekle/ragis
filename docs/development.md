# Guía de desarrollo

## Requisitos

| Herramienta | Versión | Para qué |
|---|---|---|
| Docker (Compose v2) | reciente | Stack local, ClamAV, Postgres |
| `uv` | reciente | Entorno y dependencias de Python (3.12, ver `.python-version`) |
| `pnpm` | 12.x (`packageManager`) | Workspace de Node |
| Node | 24 o superior | API y web |
| Terraform | 1.9.x | Infraestructura (CI usa 1.9.8) |
| Floci | 2.x | Ensayo de infraestructura ([guía](guides/floci.md)) |

## Primer arranque

```bash
make up            # crea .env con secretos aleatorios y levanta todo
```

- Web: <http://localhost:3000> (entra con cualquier correo)
- API: <http://localhost:4000> (contrato en `packages/contracts/openapi.yaml`)
- Con trazas: `make up-obs` y <http://localhost:16686>

Para reconstruir solo la API y la web tras un cambio:

```bash
docker compose -f infra/docker/compose.yml --env-file .env up -d --build --wait api web
```

Compose aplica las migraciones antes de iniciar la API.

## Usuario y datos de prueba

Con el stack levantado (`make up`), crea una organización de ejemplo lista para probar Ask:

```bash
make seed        # idempotente: si ya existe, solo repite la prueba rápida de Ask
```

| Qué | Valor |
|---|---|
| Entrada | <http://localhost:3000/login>, modo desarrollo: **sin clave**, escribe el correo |
| Propietario | `prueba@ragsis.test`: ve todo, incluidos los documentos del grupo Socios |
| Lector | `lector@ragsis.test`: miembro con rol de lector; **no** ve las actas de socios (para probar permisos) |
| Organización | «ACME Demo (local)» con GraphRAG activado, nueve documentos del corpus `eval/corpus/acme` |

Estos correos solo existen en tu base local; no están en Cognito ni en AWS. Para empezar de cero: `make down` y borra
el volumen de Postgres (`docker volume rm ragsis_pgdata`), luego `make up` y `make seed`.

Preguntas para probar en **Ask**:

| Pregunta | Debe pasar |
|---|---|
| ¿Cuál es el monto máximo de viáticos nacionales por día? | Responde 180000 con cita a «Política de viáticos» |
| ¿Cuántos días de vacaciones tiene cada colaborador por año de servicio? | 15 días hábiles, cita al reglamento |
| ¿Cuál es el margen operativo de la región Caribe? | 12.5 %, cita a «Indicadores comerciales» (tabla de XLSX) |
| ¿Quién está a cargo de la oficina que autoriza las suscripciones de software en la nube? | Camila Rojas (une dos documentos con el grafo) |
| ¿Qué distribución de utilidades aprobó la junta de socios? | Propietario: 30 %. Lector: se abstiene (permisos) |
| ¿Cuál es la política de teletrabajo para empleados en Japón? | Se abstiene: no hay evidencia |
| hola · gracias · ¿qué puedes hacer? | Respuesta amable fija, sin citas ni consumo de modelo ni de cuota |

### Qué «AI» hay en local

Por defecto el proveedor es **local y determinista** (ADR-010): la recuperación, los permisos, las citas y la
abstención son reales, pero la respuesta es **extractiva** (copia la frase de la evidencia con el prefijo «According to
the documents»); no redacta con un LLM. Sirve para probar el flujo completo sin red ni descargas.

### Respuestas redactadas con Ollama (qwen3:8b)

Para que un modelo real redacte la respuesta sin salir de tu máquina:

```bash
ollama pull qwen3:8b                    # unos 5 GB, una sola vez
# en .env (los embeddings siguen locales: no hace falta reindexar)
AI_GENERATION_MODEL=ollama-qwen3-8b@v1
docker compose -f infra/docker/compose.yml --env-file .env up -d --build --force-recreate --no-deps rag-engine
```

`AI_DEFAULT_PROVIDER` no elige el modelo; lo eligen `AI_GENERATION_MODEL` y los demás `AI_*_MODEL`. Para volver al modo
extractivo, borra esa línea de `.env` (o pon `local-extractive@v1`) y recrea `rag-engine`. Compose le pasa a los
contenedores `OLLAMA_BASE_URL=http://host.docker.internal:11434`.

Lo observado con `qwen3:8b` en un Mac con Apple Silicon (2026-11-10), con el corpus de ACME Demo:

| Aspecto | Resultado |
|---|---|
| Latencia por pregunta | 2 a 4 s con el modelo ya cargado; la primera tras un rato de inactividad puede tardar más mientras Ollama lo carga |
| Idioma | Responde en español cuando la pregunta está en español (el prompt lo refuerza) |
| Citas, permisos y abstención | Igual que en modo extractivo: el verificador sigue exigiendo cita y cifras en la evidencia |
| Multi-hop con grafo | Funciona (por ejemplo «Camila Rojas»), con acierto de 0,75 en las preguntas multi-hop del golden set |
| Golden set (23 preguntas, `make eval`) | Cumple todas las metas del piloto: exactitud 1,00, acierto de evidencia 0,94, precisión de citas 1,00, abstención 1,00 / 1,00 y fuga de ACL 0 |
| Latencia en el golden set | Mediana 7,7 s y p95 31 s: el contexto con saltos del grafo es mayor y el modelo corre en la misma máquina que el resto del stack |

Si la máquina está saturada (Docker, simuladores y otras apps a la vez), una respuesta puede tardar decenas de
segundos. La API espera hasta 2 minutos al motor de consulta y, si se agota, responde `504 rag_timeout` («The answer is
taking too long…») en lugar de un error interno. Los servicios del stack local se reinician solos
(`restart: unless-stopped`) y el pool de Postgres de la API tolera conexiones inactivas caídas.

Dos ajustes hicieron falta y ya están en el código: el proveedor de Ollama envía `think: false` (sin eso qwen3 gasta el
presupuesto de tokens razonando: respuestas de 12 a 55 s y abstenciones intermitentes) y el prompt añade «Responde en
español.» cuando detecta una pregunta en español.

## Comandos (`make`)

| Comando | Qué hace |
|---|---|
| `make up` / `make down` / `make logs` | Levanta, apaga y sigue los logs del stack local |
| `make up-obs` | Igual que `up`, con Jaeger |
| `make infra` | Solo Postgres, S3 y SQS (para desarrollar sin contenedores de la app) |
| `make test` | `test-py` + `test-api` contra Postgres y S3 reales |
| `make e2e` | Provisiona dos tenants, ingesta el corpus y evalúa el golden set con las metas del piloto |
| `make eval` | Golden set contra el stack levantado |
| `make reindex ARGS="--org <uuid> --mode embeddings --model <id> --dry-run"` | Reindexado ([runbook](../ops/runbooks/reindex.md)) |
| `make mock-oidc` | IdP OIDC de prueba en <http://localhost:9000> |
| `make tf-validate` | `terraform validate` del entorno `dev` en Docker |
| `make rehearse-plan` / `rehearse` / `rehearse-destroy` | Ensayo de Terraform en Floci |
| `make diagrams` | Regenera los SVG de `docs/diagrams` |

## Mapa del repositorio

```
apps/
  web/                Next.js 16: interfaz y BFF (login, sesión, rutas /api/auth/*)
  api/                Fastify: rutas, authZ, uploads, agentes, workflows, firmas, conectores
services/
  rag-engine/         FastAPI: consulta (recuperación, fusión, generación, verificador)
  ingest-worker/      Consumidor de SQS: validación, parseo, OCR, chunking, embeddings, índice
  ai-gateway/         Registro de modelos, política de residencia, proveedores (local, bedrock, ollama)
packages/
  ragsis-core/        Ajustes, BD con contexto RLS, token interno, telemetría
  contracts/          OpenAPI v1
  policy/             Índice de pruebas de autorización
db/migrations/        0001…0013: esquema, RLS forzada, funciones acotadas
infra/
  docker/             compose.yml (local), compose.pilot.yml (piloto), Caddyfile.pilot
  terraform/
    modules/          network, security, storage, database, compute, edge, observability
    envs/dev          Entorno de referencia (ECS Fargate, ALB, RDS, WAF)
    envs/pilot        Piloto de bajo costo (una EC2)
ops/runbooks/         Procedimientos operativos
eval/                 Golden set, corpus de muestra y harness de métricas
docs/                 Esta documentación, ADR, diagramas e iconos
scripts/              dev-env.sh, e2e.py, aws-rehearsal.sh
tests/python/         pytest: aislamiento, ingesta, RAG, multimodal, grafo, trazas
```

## Pruebas

| Suite | Dónde | Cubre |
|---|---|---|
| Python | `tests/python/` | Aislamiento por RLS, ACL en recuperación, flujo RAG, multimodal, grafo, reindexado y OCR, trazas |
| API | `apps/api/test/` | Tenancy y roles, OIDC, firmas, Agent Studio, workflows, conectores |
| Tipos de la web | `pnpm --filter @ragsis/web lint` (`tsc --noEmit`) | La web no tiene suite de pruebas; se valida con tipos |
| E2E | `make e2e` | Stack completo con el golden set (`eval/golden/sample.yaml`) |

Las suites de Python y de la API necesitan `make infra` (o `make test`, que lo levanta).

Metas del piloto medidas por `make e2e`: exactitud ≥ 0,85, acierto de evidencia ≥ 0,85, precisión de citas ≥ 0,95,
abstención ≥ 0,90 y **fuga de ACL = 0**. El golden set de muestra es sintético y pequeño; las metas se miden con 100 a
200 preguntas reales por vertical.

## Integración continua

`.github/workflows/ci.yml` corre en cada pull request y en `main`:

1. **test:** entorno efímero (Postgres, S3, SQS), `ruff`, `pytest`, tipos y pruebas de la API, tipos de la web, stack
   completo y E2E con las metas del piloto.
2. **terraform:** `terraform fmt -check` y `validate` del entorno `dev`.
3. **supply-chain:** construye las cuatro imágenes y escanea la de la API con Trivy (CRITICAL y HIGH).

## Convenciones

- **Decisiones:** cada cambio de fondo lleva un ADR en [adr/README.md](adr/README.md).
- **Migraciones:** siempre hacia adelante y compatibles con la versión anterior (columna nullable, backfill, luego
  restricción). Se aplican con el rol propietario.
- **Seguridad primero:** una consulta nueva pasa por el tenant resuelto en la API y por RLS; nada de confiar en datos del
  cliente. Añade una prueba negativa.
- **Secretos:** nunca en Git ni en el historial; ver [security.md](security.md).
- **Idioma:** documentación y comentarios en español; la interfaz, en inglés llano para personas no técnicas, con las
  opciones de experto dentro de «Advanced» con valores por defecto sensatos.
- **AWS:** todo cambio de infraestructura se ensaya antes en Floci ([guides/floci.md](guides/floci.md)).

## Recetas

**Agregar una migración.** Crea `db/migrations/00NN_nombre.sql`, aplícala con `make up` (o el servicio `migrate`) y
añade una prueba en `tests/python/test_isolation.py` si toca tablas de cliente.

**Agregar una variable de configuración.** Declárala en `apps/api/src/config.ts` (API) o en `settings.py` (Python),
pásala en `compose.yml` y `compose.pilot.yml` si hace falta, y documéntala en [configuration.md](configuration.md).

**Agregar un proveedor de modelos.** Implementa el proveedor en `services/ai-gateway/src/ragsis_ai/providers`, regístralo
en `registry.py` y cubre su política de residencia en `policy.py`.

**Agregar un recurso de AWS.** Escríbelo en el módulo Terraform, ensáyalo con `make rehearse` y recién entonces
`terraform plan` y `apply` en AWS real.

**Agregar un diagrama o un icono.** [diagrams/README.md](diagrams/README.md) y
[assets/icons/README.md](assets/icons/README.md).
