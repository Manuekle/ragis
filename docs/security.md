# Seguridad

Resumen de los controles, dónde viven y cómo se prueban. El objetivo que no se negocia: **cero fuga entre tenants**
(`ACL leakage = 0` en el golden set y en las pruebas de aislamiento).

## Aislamiento entre tenants y permisos

| Control | Dónde | Cómo se prueba |
|---|---|---|
| El tenant se resuelve **solo** por membresía verificada, nunca desde el cliente. No miembro: 404. | `apps/api/src/lib/tenant.ts` | `apps/api/test/api.test.ts` |
| RLS **forzada** en todas las tablas de cliente. | `db/migrations/0001_init.sql` | `tests/python/test_isolation.py` |
| Roles `ragsis_app` y `ragsis_worker` sin `BYPASSRLS`. | `infra/docker/postgres/`, runbook [db-bootstrap](../ops/runbooks/db-bootstrap.md) | `test_isolation.py` |
| ACL de documento aplicada **en SQL** antes de recuperar (ADR-008). | `services/rag-engine/…/retrieval.py` | `test_rag_flow.py`, golden set adversarial |
| Funciones `SECURITY DEFINER` acotadas. | `db/migrations/0002_member_lookup.sql` | `test_isolation.py` |
| El grafo hereda la ACL de los chunks fuente (ADR-019). | `services/ingest-worker/…/graph.py` | `tests/python/test_graph_acl.py` |

Qué hacer ante una sospecha de fuga: [incident-cross-tenant.md](../ops/runbooks/incident-cross-tenant.md).

## Identidad y sesión

- El `id_token` vive en una cookie `httpOnly`; JavaScript no lo lee. Ver [authentication.md](authentication.md).
- La API revalida el token en cada llamada: firma, emisor, audiencia, `token_use=id` y `email_verified`.
- Las cuentas de Cognito son solo por invitación; el rol en cada organización se concede aparte.
- Token interno API → rag-engine: JWT HS256 de 60 s, audiencia `ragsis-rag` (ADR-009).
- Claves de servicio `rsk_…` con scopes, alcance por workspace, expiración, revocación y auditoría (ADR-014).
- El inicio de sesión rechaza peticiones que no sean JSON y no distingue entre cuenta inexistente y clave incorrecta.

## Documentos y modelos

- **Subida:** URL prefirmada directa a S3; cuarentena; validación de magic bytes y MIME; macros y ZIP bombs; ClamAV.
- **Prompt:** el contenido documental va delimitado y escapado; un documento no puede dar instrucciones al sistema.
- **Citas:** el verificador exige que cada cita y cada cifra estén en el texto citado; si no, el sistema se abstiene.
- **Política de modelos por clasificación de datos:** `restricted` nunca llama a APIs externas y no hay fallback
  silencioso a la nube.
- **PII:** redacción en la ingesta y logs JSON con redacción. `query_runs` guarda las preguntas solo como SHA-256. El historial de Ask sí guarda el texto, privado de su autor, borrable y re-filtrado por ACL al releer (ADR-028).
- **Auditoría:** cadena de hashes por tenant (`audit_events`).
- **Firmas:** sello Ed25519, imagen de firma con huella en el certificado, verificador público que no recibe los archivos.
- **Conectores:** tokens OAuth cifrados con AES-GCM (AAD), PKCE y `state` de un solo uso; Gmail solo visible para su
  dueño; al desconectar se revoca y se retira lo indexado (ADR-025).

## Infraestructura

| Control | Dónde |
|---|---|
| S3 privado, versionado, SSE-KMS, política de solo TLS, bloqueo de acceso público | `infra/terraform/modules/storage` |
| SQS y DLQ cifradas con KMS | mismo módulo |
| KMS con rotación anual | `envs/pilot/main.tf` |
| EC2 con IMDSv2 obligatorio y disco cifrado | `envs/pilot/main.tf` |
| Solo 80 y 443 abiertos (Caddy); sin SSH, acceso por Session Manager | `envs/pilot/main.tf` |
| IAM de mínimo privilegio por recurso y por prefijo `tenants/*` | `aws_iam_role_policy.runtime` |
| ECR con tags inmutables y escaneo al subir | `envs/pilot/main.tf` |
| Imágenes por digest, no por tag | `infra/docker/compose.pilot.yml` |
| Trivy sobre la imagen de la API en CI (CRITICAL y HIGH) | `.github/workflows/ci.yml` |
| WAF con límite de tasa y flow logs en el entorno de referencia | `modules/edge`, `modules/network` |

## Secretos

- Nunca en Git. `.env`, `.env.*` y `*.tfvars` están ignorados; solo `.env.example` y `.env.pilot.example` se versionan.
- Una clave pegada en un chat, un ticket o un historial de terminal **se considera comprometida**: rotarla antes de usarla.
- Claves de proveedores de modelos externos: AWS Secrets Manager (≈ 0,40 USD por secreto al mes) o SSM
  Parameter Store con `SecureString` (sin costo). La EC2 las lee con su rol; el archivo `.env.pilot` guarda la
  referencia, no el valor.
- `INTERNAL_SERVICE_SECRET` y las contraseñas de Postgres deben conservarse al actualizar imágenes para no romper la
  firma de los tokens ni el acceso al volumen.

## Pendiente antes de producción

Validar Textract y Bedrock (incluida la visión de Nova y Claude) en la cuenta y región reales; validar Docling y su OCR
local en la imagen del worker; refresh tokens de sesión; colector ADOT en ECS; CloudFront; pentest de permisos; y los
gates legales y de privacidad de la checklist del plan maestro (sección 20). La lista completa de estado está en el
[README](../README.md#estado-frente-al-plan-maestro).
