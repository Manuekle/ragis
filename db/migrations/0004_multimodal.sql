-- RAG-04: contenido multimodal (figuras, tablas, ecuaciones) con layout y activos derivados.
--
-- chunks.kind admite 'equation'. Cada chunk puede llevar:
--   bbox       caja normalizada [x0, y0, x1, y1] en 0..1, origen arriba-izquierda (página = page_start).
--   asset_key  imagen derivada en S3 (figuras), siempre bajo el prefijo del tenant.
--   meta       metadatos no indexados: caption, modelo VLM, origen de la descripción, etc.

ALTER TABLE chunks DROP CONSTRAINT chunks_kind_check;
ALTER TABLE chunks ADD CONSTRAINT chunks_kind_check CHECK (kind IN ('text', 'table', 'figure', 'equation'));

ALTER TABLE chunks
  ADD COLUMN bbox      real[],
  ADD COLUMN asset_key text,
  ADD COLUMN meta      jsonb NOT NULL DEFAULT '{}';

ALTER TABLE chunks ADD CONSTRAINT chunks_bbox_shape CHECK (
  bbox IS NULL OR (array_length(bbox, 1) = 4 AND 0 <= ALL (bbox) AND 1 >= ALL (bbox)));

-- Defensa en profundidad: un activo derivado nunca puede apuntar fuera del prefijo de su tenant.
ALTER TABLE chunks ADD CONSTRAINT chunks_asset_in_tenant CHECK (
  asset_key IS NULL OR asset_key LIKE ('tenants/' || organization_id::text || '/assets/%'));

ALTER TABLE document_versions
  ADD COLUMN figure_count integer,
  ADD COLUMN table_count  integer,
  ADD COLUMN vision_model text;

-- Imágenes enviadas a un VLM (ingesta: descripción de figuras; consulta: VLM-enhanced).
ALTER TABLE usage_events DROP CONSTRAINT usage_events_kind_check;
ALTER TABLE usage_events ADD CONSTRAINT usage_events_kind_check CHECK (kind IN (
  'query', 'ingest_pages', 'ingest_documents', 'embedding_tokens', 'llm_input_tokens', 'llm_output_tokens',
  'rerank_calls', 'storage_bytes', 'ocr_pages', 'vision_images'));
