-- ADR-030: grabaciones de audio. Se transcriben (voz → texto con marcas de tiempo) y cada tramo es un chunk.
--
-- chunks.kind admite 'audio'. El tramo lleva en `meta`:
--   t_start, t_end   segundos desde el inicio de la grabación (lo que la cita permite reproducir)
--   speakers         etiquetas de hablante presentes en el tramo ("Hablante 1", …), si el proveedor las da
-- La grabación original sigue siendo el objeto S3 de la versión; no se generan audios derivados.

ALTER TABLE chunks DROP CONSTRAINT chunks_kind_check;
ALTER TABLE chunks ADD CONSTRAINT chunks_kind_check CHECK (kind IN ('text', 'table', 'figure', 'equation', 'audio'));

ALTER TABLE document_versions
  ADD COLUMN duration_seconds       real CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  ADD COLUMN transcription_provider text,
  ADD COLUMN transcription_language text;

-- Segundos de audio transcritos (la unidad que cobra el proveedor).
ALTER TABLE usage_events DROP CONSTRAINT usage_events_kind_check;
ALTER TABLE usage_events ADD CONSTRAINT usage_events_kind_check CHECK (kind IN (
  'query', 'ingest_pages', 'ingest_documents', 'embedding_tokens', 'llm_input_tokens', 'llm_output_tokens',
  'rerank_calls', 'storage_bytes', 'ocr_pages', 'vision_images', 'audio_seconds'));
