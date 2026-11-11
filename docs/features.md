# Funciones

Qué hace Ragsis hoy y cómo se activa cada capacidad. Para cómo está construido, ver [architecture.md](architecture.md);
para las variables, [configuration.md](configuration.md).

## Modelos de IA

Por defecto todo corre **sin red ni credenciales** con el proveedor local determinista (ADR-010).

- **Bedrock:** `AI_EMBEDDING_MODEL=bedrock-titan-embed-v2-1024@v1`, `AI_GENERATION_MODEL=bedrock-nova-lite@v1` (o
  `bedrock-claude-sonnet-5-5@v1`) y credenciales de AWS en el entorno de los contenedores.
- **On-premise u offline:** modelos `ollama-*` con `OLLAMA_BASE_URL`.

## Integraciones por API

Los administradores crean claves `rsk_…` en *Gobierno* (o con `POST /v1/organizations/{org}/api-keys`) con scopes
`query`, `documents:read` y `documents:write`, y alcance por workspace. Las claves expiran, se pueden revocar y quedan
auditadas. Contrato: `packages/contracts/openapi.yaml`.

## Conectores (CON-01)

Gmail (personal, solo visible para su dueño), Slack y ClickUp (de la empresa, hacia un workspace). OAuth con PKCE, tokens
cifrados, sincronización delta con cursor, tombstones y borrado al desconectar (ADR-025). Falta validar con apps OAuth
reales. Cómo crear las apps de cada proveedor: [connectors-setup.md](connectors-setup.md).

## Historial de conversaciones

Ask guarda cada pregunta y respuesta en una conversación **privada de quien la hace** (ni los admins la ven). El botón
*History* lista las conversaciones, las reabre (la URL lleva `?c=<id>`, así que recargar vuelve al mismo sitio), las
renombra y las borra de forma definitiva. Si a alguien le retiran el acceso a un documento citado, o el documento se
borra, ese turno aparece oculto al reabrir el historial. Seguir preguntando en una conversación reabierta no envía el
contexto anterior al modelo. Detalle y límites: ADR-028.

## OCR

`OCR_PROVIDER=textract` habilita OCR de PDFs escaneados e imágenes en AWS y respeta la política de datos del tenant.
`DOCLING_OCR=true` da OCR local, sin red.

## Multimodal (RAG-04, ADR-018)

Formatos: PDF, DOCX, PPTX, XLSX, PNG/JPEG, HTML, Markdown, TXT y CSV.

- **Tablas** (incluidos los gráficos nativos de Office convertidos a tabla con sus cifras) y **ecuaciones** son chunks
  propios con página, bbox y caption. Funcionan sin ningún modelo extra.
- **Figuras:** `AI_VISION_MODEL=bedrock-nova-lite@v1` (o `bedrock-claude-sonnet-5-5@v1`, u `ollama-qwen3-vl-8b@v1` para
  tenants restringidos u on-premise) las describe con contexto del documento y las guarda como activo S3 citable. Sin
  VLM, una figura se indexa solo si tiene caption o texto alternativo.
- `PARSER_PREFERENCE=docling` (con `docling` instalado en la imagen del worker) añade layout, tablas de PDF, fórmulas y
  bbox. `DOCLING_OCR=true` da OCR local sin red.
- **Consulta:** con un generador con visión, las imágenes de las figuras citadas se adjuntan al modelo
  (`RAG_VLM_ENHANCED`). El verificador de citas sigue exigiendo que toda cifra esté en el texto de la evidencia.

## GraphRAG (RAG-05, ADR-019)

Se habilita por plan (business o private) o por organización:

```
PATCH /v1/organizations/{org}/settings   {"graph_mode": "on" | "off" | "inherit"}
```

La ingesta extrae entidades y relaciones por chunk con `AI_GRAPH_MODEL` (por defecto `local-graph-heuristic@v1`, offline;
o un LLM permitido por la política del tenant). Toda entidad o relación es visible solo si la persona puede leer al menos
un chunk fuente, y sus descripciones se arman solo con fuentes visibles.

En la consulta, `mode` puede ser `auto`, `off`, `local`, `global` o `hybrid`; las citas siguen siendo chunks.
Para rellenar el grafo tras activarlo: `make reindex ARGS="--org <uuid> --mode graph"`.

## Reindexado

```bash
make reindex ARGS="--org <uuid> --mode embeddings --model <id> --dry-run"
```

Ver [reindex.md](../ops/runbooks/reindex.md).

## Onboarding y Agent Studio (ADR-020, ADR-021)

Al crear una organización, la web abre **Setup** (`/app/{org}/onboarding`): nueve pasos reanudables (sector, objetivos,
documentos, privacidad, espacios, agentes sugeridos, prueba controlada y activar). Las recomendaciones salen de presets
deterministas por sector; activar no publica agentes ni habilita acciones externas.

La calificación comercial (sector, tamaño, comprador, usuarios iniciales, fuentes documentales, señales de dolor y canal
de origen) se pregunta en la pantalla de alta, antes de entrar a la app, y produce un puntaje interno que la API no expone.

**Agent Studio** (`/app/{org}/agents`) crea agentes desde plantillas o en blanco, valida la definición contra la política
del tenant, la prueba en un sandbox (búsqueda real con tu ACL, escrituras simuladas) y publica versiones semánticas
inmutables.

## Workflows con revisión humana (ADR-022)

`/app/{org}/workflows` encadena agentes publicados con revisión humana, compuertas de aprobación y condiciones; cada
versión fija la versión de sus agentes. Los runs se inician con `Idempotency-Key`, se ejecutan con los permisos de quien
los inicia y esperan en el **Inbox** de quien tenga el rol funcional (asignado en *Gobierno → Roles*). Una aprobación
queda atada al hash de lo revisado y a las versiones de documento citadas; un rechazo detiene el run. **Activity**
muestra la línea de tiempo, las decisiones y los eventos de cada run.

## Ragsis Sign (ADR-023, ADR-024)

`/app/{org}/signatures` permite crear sobres con un PDF de la Biblioteca o generarlos desde un workflow. Un segundo
usuario con permiso aprueba el envío. Cada firmante revisa la copia fijada del documento, escribe su nombre y acepta
firmar con su cuenta verificada o mediante una invitación personal por correo.

Al finalizar, la app genera un PDF con la hoja de firmas y un certificado de auditoría sellado con Ed25519. El
verificador público `/sign/verify` compara los archivos con las huellas registradas sin subirlos. Los enlaces
compartidos y las invitaciones externas respetan los dominios autorizados en *Gobierno → External sharing*.

En **Signatures → My signatures** puedes guardar hasta seis imágenes PNG o JPG y elegir una al firmar. También puedes
cargar una imagen para un solo sobre, incluso como invitado. La imagen queda incorporada a la hoja final y el
certificado registra su huella. Los sobres del simulador siguen disponibles como historial.

**Correo en AWS.** Para enviar invitaciones y avisos de finalización, configura `signature_email_from` y
`signature_email_identity_arn` en Terraform con una identidad SES verificada en la región de la API y con acceso de
producción. En una instalación directa, la API recibe `SIGNATURE_EMAIL_FROM`, credenciales con `ses:SendEmail` y
`PUBLIC_BASE_URL` con HTTPS. El modo de desarrollo ofrece enlaces de prueba al regenerar una invitación.
