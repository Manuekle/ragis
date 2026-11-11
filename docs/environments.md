# Entornos

Ragsis corre en tres lugares. La regla que los une: **toda infraestructura de AWS se crea primero en Floci y solo
después en AWS real.**

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="diagrams/environments-dark.svg">
  <img alt="Local con Docker Compose, ensayo en Floci y AWS real" src="diagrams/environments.svg">
</picture>

| | Local | Ensayo en Floci | AWS real (piloto) |
|---|---|---|---|
| Para qué | Desarrollar y probar la aplicación | Probar Terraform y recursos AWS sin cuenta ni costo | Mostrar el producto a un grupo pequeño |
| Cómo se levanta | `make up` | `make rehearse` | `terraform apply` con el perfil `ragsis-pilot` |
| Almacenamiento | SeaweedFS (API S3) | S3 emulado | S3 |
| Cola | ElasticMQ (API SQS) | SQS emulado | SQS + DLQ |
| Identidad | Login de desarrollo o IdP simulado | Cognito emulado | Cognito |
| Modelos | Locales deterministas | n/a | Locales (Bedrock opcional) |
| Costo | 0 | 0 | Créditos del plan FREE |

El stack de aplicación local **no** usa Floci: usa SeaweedFS y ElasticMQ porque arrancan en segundos y no dependen de
nada externo. Floci se usa para ensayar la infraestructura (Terraform), no para correr la aplicación.

## 1. Local

```bash
make up           # genera .env con secretos aleatorios y levanta todo
make up-obs       # igual, con Jaeger (http://localhost:16686)
make infra        # solo Postgres, S3 y SQS, para desarrollar o probar
make down
```

Servicios de `infra/docker/compose.yml`:

| Servicio | Imagen | Puerto en el host |
|---|---|---|
| `postgres` | `pgvector/pgvector:pg17` | `127.0.0.1:55432` |
| `seaweedfs` | `chrislusf/seaweedfs:3.80` | `127.0.0.1:8333` |
| `elasticmq` | `softwaremill/elasticmq-native:1.6.11` | `127.0.0.1:9324` |
| `migrate`, `bootstrap` | imagen de la API | ninguno; terminan al acabar |
| `api` | `apps/api/Dockerfile` | `127.0.0.1:4000` |
| `rag-engine` | `services/rag-engine/Dockerfile` | ninguno |
| `ingest-worker` | `services/ingest-worker/Dockerfile` | ninguno |
| `web` | `apps/web/Dockerfile` | `127.0.0.1:3000` |
| `jaeger` (perfil `observability`) | `jaegertracing/jaeger:2.5.0` | `127.0.0.1:16686`, `4318` |

Por defecto no necesita red ni credenciales: usa el proveedor de modelos local. La web arranca con
`AUTH_MODE=dev` (cualquier correo entra). Para probar SSO sin un IdP real, `make mock-oidc` levanta uno en
<http://localhost:9000>.

## 2. Ensayo en Floci

[Floci](https://github.com/floci-io/floci) es un emulador local de AWS (puerto 4566). Con él se puede aplicar el mismo
Terraform del piloto sin cuenta de AWS y sin costo. La guía completa, con límites conocidos, está en
[guides/floci.md](guides/floci.md).

```bash
make rehearse-plan      # qué se crearía
make rehearse           # crea los recursos en Floci
make rehearse-destroy   # los borra
```

## 3. AWS real: el piloto

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="diagrams/aws-pilot-dark.svg">
  <img alt="Piloto en AWS: una EC2 con Docker Compose, S3, SQS, KMS, ECR, Cognito y Systems Manager en us-east-2" src="diagrams/aws-pilot.svg">
</picture>

Una sola instancia EC2 `m7i-flex.large` (2 vCPU, 8 GiB, Ubuntu 24.04, EBS gp3 de 30 GB cifrado) ejecuta todo con
`infra/docker/compose.pilot.yml`. Caddy termina TLS en los puertos 80 y 443 y es lo único expuesto. Los datos
administrados viven en servicios regionales.

| Recurso | Detalle |
|---|---|
| Región | `us-east-2` (Ohio). Todos los recursos regionales deben crearse ahí. |
| EC2 | `m7i-flex.large`, IMDSv2 obligatorio, IP elástica, acceso por Session Manager (sin SSH) |
| S3 | Bucket privado, versionado, SSE-KMS, solo TLS, CORS hacia el origen del piloto, ciclo de vida de versiones |
| SQS | Cola de ingesta y DLQ cifradas con KMS |
| KMS | Una clave con rotación anual |
| ECR | Cuatro repositorios (`api`, `ingest-worker`, `rag-engine`, `web`) con tags inmutables y escaneo al subir |
| Cognito | User pool (plan LITE) con solo cuentas invitadas, cliente público con `USER_PASSWORD_AUTH` |
| IAM | Rol `ragsis-pilot-ec2` con permisos mínimos por recurso |

El procedimiento paso a paso (perfil, Terraform, imágenes, `.env.pilot`, primer arranque y prueba de aceptación) está en
el runbook [piloto-aws.md](../ops/runbooks/piloto-aws.md).

### Costo y créditos

El piloto usa el plan **FREE** de AWS: no genera cobros mientras duren los créditos (USD 100) y el plan (seis meses). Al
terminar, AWS suspende la cuenta y conserva los datos 90 días para que pases a un plan de pago. Unirse a AWS
Organizations sube la cuenta a plan de pago automáticamente.

`m7i-flex.large` es elegible para el plan FREE, pero **consume créditos**: elegible no significa gratis. Estimación con
precios de lista de us-east-2 consultados el 2026-11-10 (instancia + EBS de 30 GB + IP pública):

| Uso | Costo al mes | Duración de USD 100 |
|---|---|---|
| 24 horas, 7 días | 75,95 USD | 1,3 meses |
| 8 h por 22 días, con IP elástica | 22,90 USD | 4,4 meses |
| 8 h por 22 días, sin IP elástica | 20,13 USD | 5,0 meses |

Qué hacer:

- **Apaga la instancia cuando no pruebes.** Detenida no cobra cómputo, pero el disco y la IP elástica siguen cobrando.
- Si aceptas que la IP cambie en cada arranque, libera la IP elástica.
- Los documentos casi no pesan en el costo: 20 GB en S3 cuestan unos 0,46 USD al mes.
- PostgreSQL corre en la instancia, sobre el EBS (2,40 USD al mes por 30 GB); no hay RDS.
- Los modelos de Meta, Anthropic u otros proveedores externos se facturan aparte; los créditos de AWS no los cubren.
- Si una operación que antes funcionaba da `AccessDenied`, revisa en *AWS Settings → Billing* si el proyecto llegó a su
  límite de gasto.

### Sobre `AWS_ENDPOINT_URL`

Si tu shell exporta `AWS_ENDPOINT_URL=http://localhost:4566` (lo habitual al trabajar con Floci), **cualquier comando
`aws` va al emulador, no a AWS real**. Para AWS real usa `env -u AWS_ENDPOINT_URL aws …` o una terminal limpia. Terraform
necesita además credenciales exportadas desde la sesión de `aws login`:

```bash
unset AWS_ENDPOINT_URL AWS_PROFILE
eval "$(aws configure export-credentials --profile ragsis-pilot --format env)"
terraform -chdir=infra/terraform/envs/pilot plan -var aws_account_id=<id-de-la-cuenta> -var pilot_hostname=<dns>
```

## Promoción: de Floci a AWS

1. Cambia el Terraform o el compose.
2. `make rehearse-plan` y `make rehearse` en Floci. Corrige hasta que apliquen sin errores.
3. `terraform plan` contra AWS real. Revisa que sea un cambio mínimo y sin destrucciones inesperadas.
4. `terraform apply` en AWS real.
5. Si algo falla en Floci por una limitación del emulador (no del código), anótalo en
   [guides/floci.md](guides/floci.md#límites-conocidos) y valida esa parte directamente en AWS con un cambio acotado.
