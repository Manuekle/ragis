# Iconos de los diagramas y la documentación

Se usan en los SVG de [`../../diagrams`](../../diagrams/README.md), en el [README](../../../README.md) y en algunas guías.
No se usan en la aplicación.

## `aws/`: AWS Architecture Icons

Origen: paquete oficial *AWS Architecture Icons* (`Asset-Package_07312025`). Se copian sin modificar.

| Archivo | Tipo | Nombre oficial |
|---|---|---|
| `ec2`, `s3`, `sqs`, `cognito`, `kms`, `iam`, `ecr`, `systems-manager`, `bedrock`, `textract` | Servicio (64 px) | `Arch_*_64.svg` |
| `group-aws-cloud`, `group-region`, `group-vpc`, `group-public-subnet` | Grupo (32 px) | `Architecture-Group-Icons` |
| `elastic-ip`, `users`, `documents`, `server` | Recurso (48 px) | `Resource-Icons` |
| `users-dark`, `documents-dark`, `server-dark` | Recurso para fondo oscuro | `Res_*_48_Dark` |

Condiciones de uso: son las del paquete de AWS. Sirven para representar servicios de AWS en diagramas de arquitectura,
sin sugerir patrocinio ni aval de AWS, y no deben alterarse ni recolorearse. Consulta las
[directrices de iconos de arquitectura de AWS](https://aws.amazon.com/architecture/icons/) antes de publicar fuera de
este repositorio. Para agregar otro icono, tómalo del mismo paquete.

## `tech/`: logotipos de tecnología

Origen: [svgl.app](https://svgl.app), catálogo abierto de logotipos SVG. Cada logotipo es marca de su dueño. Las
variantes `*-dark.svg` se usan en los diagramas oscuros.

| Archivo | Marca |
|---|---|
| `typescript`, `node-js`, `fastify`, `next-js` | API y web |
| `python`, `fastapi` | Servicios Python |
| `postgresql`, `docker`, `terraform` | Datos e infraestructura |
| `ollama` | Modelos locales |
| `gmail`, `slack`, `clickup` | Conectores |

## Cómo agregar un icono

1. Copia el SVG a `aws/` o `tech/` con un nombre en minúsculas y guiones. Para svgl, descárgalo de
   `https://svgl.app/library/<nombre>.svg` (la API `https://api.svgl.app?search=<texto>` lista los nombres).
2. Comprueba que no contenga `<script>`, atributos `on*` ni referencias externas.
3. Úsalo en `docs/diagrams/build.py` (`"tech/nombre.svg"`) y ejecuta `make diagrams`.
4. Los logotipos animados (por ejemplo el de Floci) no sirven: se ven incompletos como imagen estática.
