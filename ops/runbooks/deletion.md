# Borrado verificable

1. `DELETE /v1/organizations/{org}/documents/{id}` → documento `deleting` (excluido del retrieval al instante).
2. El worker purga chunks, embeddings y objetos S3 de todas las versiones y deja evento `document.purged`.
3. Verificación de no recuperación: consulta con preguntas del documento → abstención; `SELECT count(*) FROM chunks WHERE document_id = ...` = 0.
4. Límites a comunicar al cliente: versiones no actuales de S3 expiran por lifecycle (90 días por defecto);
   backups de RDS conservan datos hasta su retención; `audit_events` se conserva (sin contenido documental).
