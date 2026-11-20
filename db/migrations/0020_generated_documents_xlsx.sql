-- Documentos generados desde el chat (ADR-034): Excel nativo (.xlsx).
--
-- Un pedido «en Excel» o «una tabla» ahora se entrega como libro de Excel (hojas con tabla nativa, números reales y
-- hoja de fuentes) en lugar de CSV. CSV sigue disponible como formato de descarga. Solo cambia el formato aceptado.

ALTER TABLE generated_documents
  DROP CONSTRAINT generated_documents_format_check,
  ADD CONSTRAINT generated_documents_format_check CHECK (format IN ('pdf', 'docx', 'pptx', 'xlsx', 'csv', 'md'));
