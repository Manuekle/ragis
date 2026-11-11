# Ensayar infraestructura en Floci

**Regla:** toda instancia, bucket, cola, usuario de Cognito o cambio de Terraform se crea primero en Floci. Solo cuando
el ensayo pasa se aplica en AWS real. Así se cometen los errores donde no cuestan créditos.

[Floci](https://github.com/floci-io/floci) es un emulador de AWS que escucha en `http://localhost:4566` y acepta
credenciales cualquiera. Funciona con el AWS CLI, los SDK y el proveedor `hashicorp/aws` de Terraform.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../diagrams/environments-dark.svg">
  <img alt="Local, ensayo en Floci y AWS real" src="../diagrams/environments.svg">
</picture>

## Qué es y qué no es Floci en este proyecto

- **Sí:** el lugar donde se ensaya `infra/terraform/envs/*` y se prueban recursos de AWS sueltos.
- **No:** el almacenamiento de la aplicación local. `make up` usa SeaweedFS (S3) y ElasticMQ (SQS), que arrancan en
  segundos y no dependen de nada externo. Ver [environments.md](../environments.md).

## Levantar Floci

Cualquiera de las dos formas sirve; lo importante es que `http://localhost:4566/_floci/health` responda.

```bash
# Desde el repositorio de Floci (como se ejecuta en esta máquina)
cd ~/Dev/floci && make build                       # solo si falta target/quarkus-app
cd ~/Dev/floci && java -jar target/quarkus-app/quarkus-run.jar

# O con Docker
docker run --rm -p 4566:4566 -v /var/run/docker.sock:/var/run/docker.sock floci/floci:latest
```

> **No recompiles Floci mientras corre.** `make build` borra `target/quarkus-app`; la JVM en marcha queda sin sus
> jars y deja de responder KMS, ECR, Cognito y EC2 (S3 y SQS siguen porque ya estaban cargados).

Variables para que el AWS CLI y los SDK hablen con Floci:

```bash
export AWS_ENDPOINT_URL=http://localhost:4566
export AWS_DEFAULT_REGION=us-east-2
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test
```

> **Cuidado.** Con `AWS_ENDPOINT_URL` exportado, todo `aws …` va a Floci. Para tocar AWS real usa una terminal sin esa
> variable o `env -u AWS_ENDPOINT_URL aws …`.

## Ensayar el piloto

```bash
make rehearse-plan      # qué se crearía (no cambia nada)
make rehearse           # aplica en Floci
make rehearse-destroy   # borra lo creado en Floci
```

Equivale a `scripts/aws-rehearsal.sh {plan|apply|output|destroy}`. Variables opcionales:

| Variable | Por defecto | Uso |
|---|---|---|
| `REHEARSAL_ENV` | `pilot` | Entorno de `infra/terraform/envs` a ensayar |
| `FLOCI_ENDPOINT` | `http://localhost:4566` | Otro endpoint o puerto |
| `REHEARSAL_HOSTNAME` | `piloto.ragsis.test` | DNS ficticio para el piloto |
| `REHEARSAL_INSTANCE_TYPE` | `m5.large` | Tipo de EC2 solo para el ensayo (Floci no conoce `m7i-flex.large`) |
| `REHEARSAL_TARGETS` | vacío | Direcciones de Terraform (separadas por espacio) para ensayar solo una parte |

Ejemplo, solo almacenamiento y permisos:

```bash
REHEARSAL_TARGETS="module.storage aws_iam_role_policy.runtime" scripts/aws-rehearsal.sh apply
```

### Cómo funciona

1. Comprueba que Floci responde; si no, se detiene con un mensaje claro.
2. Copia `infra/terraform` a `infra/terraform/.floci/` (ignorado por Git). No copia estado ni plugins del entorno real.
3. Agrega `providers_override.tf` con credenciales falsas, `skip_requesting_account_id` y `s3_use_path_style`. El
   endpoint llega por `AWS_ENDPOINT_URL`, que el proveedor 6.x respeta.
3. Si el entorno tiene `aws_instance.pilot`, agrega `instance_override.tf` con un tipo de instancia que Floci conozca
   (`m5.large`, de la misma forma: 2 vCPU y 8 GiB). Solo cambia en el ensayo; AWS real usa el tipo de `main.tf`.
4. Guarda el estado en `infra/terraform/.floci/state/<entorno>.tfstate`, separado del estado real.

Nunca lee ni modifica `infra/terraform/envs/<entorno>/terraform.tfstate`.

## Qué cuenta como «ensayo limpio»

- `plan` y `apply` terminan sin error y `destroy` deja el estado vacío.
- Los recursos existen con el AWS CLI (`aws s3api list-buckets`, `aws sqs list-queues`…).
- Un segundo `plan` no propone cambios.

## Límites conocidos

Floci es un emulador: valida la forma de las llamadas y el grafo de dependencias, no el comportamiento real de AWS.
Resultado del ensayo completo del piloto con Floci 2.4.0 en macOS con Docker Desktop (2026-11-10):

| Área | Resultado |
|---|---|
| `plan` y `apply` del piloto | Los 28 recursos se crean; un segundo `plan` no propone cambios |
| EC2 | Arranca como contenedor Docker (`running` en unos 10 s). Solo con tipos de su catálogo: `m7i-flex.large` falla con `reading EC2 Instance Type: empty result`, por eso el ensayo usa `m5.large` |
| IP elástica | Se asigna (`127.0.0.1`); no es una IP pública real |
| S3, SQS, KMS, ECR, Cognito, IAM, grupos de seguridad | Se crean. SQS y el ciclo de vida de S3 tardan decenas de segundos |
| `user_data` de la instancia | No se comprueba: el contenedor arranca, pero no hay garantía de que instale Docker ni los paquetes |
| Rendimiento real, cuotas, precios y reglas de red | No se emulan; se validan solo en AWS |

Lo que el ensayo **no** puede decirte: si `m7i-flex.large` está disponible en la cuenta, si el plan FREE permite un
servicio, o si el arranque del host termina bien. Eso se mira en el `terraform plan` de AWS real y en el primer
arranque, con la instancia a la vista.

## Problemas frecuentes

| Síntoma | Causa | Solución |
|---|---|---|
| `Floci no responde en http://localhost:4566` | Floci apagado | Levantarlo (ver arriba) |
| `Error acquiring the state lock` | Un `apply` anterior sigue vivo | `pgrep -fl 'terraform -chdir'` y detenerlo; luego repetir |
| Recursos duplicados de pruebas anteriores | Aplicaciones interrumpidas | Reiniciar Floci y borrar `infra/terraform/.floci/` |
| S3, SQS e IAM responden pero KMS, ECR, Cognito o EC2 se quedan colgados (`pending`, la llamada expira) | Se borró `target/quarkus-app` de Floci (`make build`, `mvn clean`) mientras corría: la JVM no puede cargar las clases que aún no usó | Reconstruir (`make build` en el repositorio de Floci), detener el proceso y arrancarlo de nuevo. No recompilar mientras corre |
| `reading EC2 Instance Type (m7i-flex.large): empty result` | El tipo no está en el catálogo de Floci | El script ya lo sustituye por `m5.large`; cámbialo con `REHEARSAL_INSTANCE_TYPE` |
| `apply` repetido sigue fallando con la instancia vieja | Quedó una instancia `tainted` en el estado del ensayo | Terminarla en Floci y `terraform state rm aws_instance.pilot` en el estado del ensayo, o borrar `infra/terraform/.floci/` |
| `NoSuchBucket … api` al usar `aws` contra AWS real | `AWS_ENDPOINT_URL` apunta a Floci | `env -u AWS_ENDPOINT_URL aws …` |
| El proveedor de Terraform no encuentra credenciales de AWS real | El proveedor no lee las sesiones de `aws login` | `eval "$(aws configure export-credentials --profile ragsis-pilot --format env)"` |

## Para otros recursos

Para probar a mano un recurso suelto (por ejemplo una cola nueva) antes de ponerlo en Terraform:

```bash
aws sqs create-queue --queue-name prueba          # va a Floci porque AWS_ENDPOINT_URL está exportado
aws sqs list-queues
aws sqs delete-queue --queue-url http://localhost:4566/000000000000/prueba
```

Después escríbelo en Terraform, ensáyalo con `make rehearse` y recién entonces aplícalo en AWS.
