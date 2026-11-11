# Piloto de Ragsis en AWS Ohio

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../docs/diagrams/aws-pilot-dark.svg">
  <img alt="Topología del piloto en AWS us-east-2" src="../../docs/diagrams/aws-pilot.svg">
</picture>

Contexto, costos y decisiones: [docs/environments.md](../../docs/environments.md). Variables: [docs/configuration.md](../../docs/configuration.md).

Este entorno usa una EC2 `m7i-flex.large` de 2 vCPU y 8 GiB, Ubuntu 24.04 amd64, PostgreSQL con pgvector en un disco EBS cifrado, S3 privado y SQS con DLQ. Cognito limita el acceso a usuarios invitados. Caddy expone la web por HTTPS y Session Manager permite administrar el host. API, base de datos, worker, motor RAG y ClamAV se comunican dentro de Docker.

El repositorio público tiene el [entorno pilot de GitHub](https://github.com/Manuekle/ragis/settings/environments/26787121908/edit). Guarda `AWS_REGION=us-east-2`, `DEPLOY_STAGE=pilot`, `RAGSIS_ENV=production` y `AUTH_MODE=oidc`, y admite la rama `codex/piloto-aws`. El arranque descrito aquí usa imágenes de ECR privado desde tu máquina. Para automatizarlo después hacen falta un workflow y un rol de despliegue limitado a ese entorno. CloudShell devolvió `AccessDenied` al listar proveedores OIDC de IAM. Esa autorización de GitHub es independiente del login de usuarios en Cognito.

## Antes de tocar AWS: ensayo en Floci

Todo cambio de infraestructura se prueba primero en el emulador local (Floci, `localhost:4566`). Solo con el ensayo limpio se sigue con AWS real. Guía y límites conocidos: [docs/guides/floci.md](../../docs/guides/floci.md).

```bash
make rehearse-plan      # qué crearía Terraform en Floci
make rehearse           # lo crea en Floci
make rehearse-destroy   # lo borra
```

El ensayo usa un estado propio en `infra/terraform/.floci/` y nunca lee ni modifica el estado de AWS real.

## Preparar el plan de AWS

1. Define un subdominio que controles, por ejemplo `piloto.tudominio.com`. El valor se usa en el certificado, el callback de Cognito y el CORS de S3.
2. Inicia un perfil temporal `ragsis-pilot` para el proyecto **Rubber Ducking** desde la cuenta de tu consola. Sigue la conexión inicial del perfil o renuévalo con `aws login --profile ragsis-pilot`. Selecciona ese proyecto en el navegador. [Acceso temporal al proyecto AWS](https://docs.aws.amazon.com/accounts/latest/reference/connect-ai-coding-tool.html)
3. Desde la raíz de Ragsis, ejecuta un plan real con ese perfil. Sustituye `ACCOUNT_ID` y `PILOT_HOSTNAME` por los datos del proyecto. Guarda el plan localmente para revisar los recursos y el consumo previsto de EC2, EBS, IPv4, KMS, S3, SQS y ECR antes de aprobar el alta.

```bash
(
  unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_ENDPOINT_URL
  export AWS_PROFILE=ragsis-pilot AWS_REGION=us-east-2
  export AWS_IGNORE_CONFIGURED_ENDPOINT_URLS=true
  umask 077
  aws sts get-caller-identity --query Account --output text
  terraform -chdir=infra/terraform/envs/pilot init -lockfile=readonly
  terraform -chdir=infra/terraform/envs/pilot plan \
    -var "aws_account_id=ACCOUNT_ID" \
    -var "pilot_hostname=PILOT_HOSTNAME" \
    -out=pilot.tfplan
)
```

El proveedor Terraform está limitado al ID indicado. El plan real requiere acceso de lectura al proyecto y al parámetro público de la AMI. Al autorizar su aplicación, la identidad también necesita crear el perfil de EC2 y pasar su rol. Revisa el plan antes de ejecutar `terraform apply pilot.tfplan` en ese directorio. El estado es local al operador. Consérvalo con permisos de lectura restringidos y guárdalo fuera de GitHub.

## Arranque tras la aprobación

1. Cuando Terraform termine, publica las cuatro imágenes Linux amd64 en los repositorios privados que devuelve `terraform output -json ecr_repositories`. Usa una etiqueta nueva de versión y anota los cuatro digests publicados. La EC2 descarga las imágenes mediante su perfil IAM y el *credential helper* de ECR. [Autenticación de ECR privado](https://docs.aws.amazon.com/AmazonECR/latest/userguide/registry_auth.html)

   | Imagen | Dockerfile |
   |---|---|
   | `api` | `apps/api/Dockerfile` |
   | `web` | `apps/web/Dockerfile` |
   | `rag-engine` | `services/rag-engine/Dockerfile` |
   | `ingest-worker` | `services/ingest-worker/Dockerfile` |

   Construye cada una desde la raíz con `docker buildx build --platform linux/amd64 --load -f DOCKERFILE -t IMAGEN:VERSION .`. Autentica Docker a ECR con `aws ecr get-login-password` por entrada estándar. Etiqueta la imagen para su repositorio privado y usa `docker push` después de aprobar la publicación de las imágenes.

2. En el proveedor DNS, crea un registro A del subdominio hacia `terraform output -raw dns_ipv4`. En la instancia, comprueba que `cloud-init status --wait` terminó y que `docker compose version` funciona.
3. Copia `infra/docker/compose.pilot.yml`, `infra/docker/Caddyfile.pilot`, `infra/docker/.env.pilot.example` e `infra/docker/postgres/10-roles.sh` a `/opt/ragsis`, conservando el subdirectorio `postgres/`. Puedes usar Run Command de Systems Manager para transferir solo esos archivos de configuración. El paquete no necesita código fuente ni secretos.
4. En la EC2, completa `/opt/ragsis/.env.pilot` con permisos `0600`. Usa los valores de `terraform output -json runtime` y las cuatro referencias privadas `repo@sha256:...`. Para el primer arranque, genera cuatro valores independientes con `openssl rand -hex 32` para las tres contraseñas de PostgreSQL y el secreto interno. Conserva esos valores al actualizar imágenes para reutilizar el volumen y mantener la firma de los tokens internos. El cliente de Cognito es público y permite `USER_PASSWORD_AUTH`: el formulario de acceso vive en la web ([docs/authentication.md](../../docs/authentication.md)). Añade `TURSO_DATABASE_URL` y `TURSO_AUTH_TOKEN` de la base de la waitlist: es una base Turso aparte, solo para `/waitlist`, y no comparte datos con PostgreSQL.
5. Desde `/opt/ragsis`, inicia los servicios.

```bash
sudo docker compose --env-file .env.pilot -f compose.pilot.yml config --quiet
sudo docker compose --env-file .env.pilot -f compose.pilot.yml pull
sudo docker compose --env-file .env.pilot -f compose.pilot.yml up -d --wait --wait-timeout 420
```

## Prueba de aceptación

- Invita dos cuentas de prueba en Cognito. El login es el formulario de la propia app en `/login` (correo y clave); Cognito solo guarda las cuentas y nunca muestra su página. La clave temporal de la invitación pide elegir una nueva en el primer ingreso, y "Forgot your password?" envía un código por correo. Comprueba la sesión HTTPS y que Biblioteca y Ask funcionan con los roles de administración y lectura.
- Carga un DOCX, un XLSX y un PDF con texto del corpus sintético. Verifica subida prefirmada, consumo de SQS, estado indexado, cita y descarga. Confirma la denegación con un lector fuera del grupo.
- Revisa el funcionamiento de ClamAV, el espacio en disco y la cola de errores. Establece una copia de seguridad y prueba la restauración de PostgreSQL antes de incorporar expedientes de clientes.
- La configuración arranca con embeddings y generación locales y con escáner ClamAV. Antes de usar documentos de clientes, comprueba que las citas de PDF abran la página que contiene el pasaje citado. Los escaneos necesitan OCR real si se incluyen en el alcance.

## Apagar y encender para cuidar los créditos

La instancia consume créditos del plan FREE mientras corre (ver [costos](../../docs/environments.md#costo-y-créditos)). Apágala cuando no pruebes. Los contenedores usan `restart: unless-stopped` y vuelven solos al encender.

```bash
(
  unset AWS_ENDPOINT_URL AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
  export AWS_PROFILE=ragsis-pilot AWS_REGION=us-east-2
  ID=$(terraform -chdir=infra/terraform/envs/pilot output -raw instance_id)
  aws ec2 stop-instances  --instance-ids "$ID"   # apagar
  # aws ec2 start-instances --instance-ids "$ID" # encender
)
```

Detenida no cobra cómputo, pero el disco EBS y la IP elástica siguen consumiendo créditos. Tras encender, espera a que `docker compose ps` muestre todos los servicios saludables antes de probar el login.

## Actualizar imágenes

1. Ensaya el cambio en local (`make up`) y, si toca Terraform, en Floci (`make rehearse`).
2. Construye y publica las imágenes nuevas con una etiqueta nueva (las etiquetas de ECR son inmutables) y anota los digests.
3. Actualiza las referencias `repo@sha256:...` en `/opt/ragsis/.env.pilot`, conservando las contraseñas y el secreto interno.
4. Ejecuta `docker compose ... pull` y `up -d --wait` como en el arranque inicial.
