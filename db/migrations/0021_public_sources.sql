-- Public records in Ask (ADR-036): official government data and the web, through Croma (api.croma.run), on request.
--
-- Off by default. An administrator turns it on per organization, picks the default country and whether web
-- results are allowed, and caps the lookups per month. The Croma API key is a platform secret (rag-engine only);
-- nothing here stores it. Each lookup a question makes is counted in usage_events ('public_lookups') and the
-- query run keeps which endpoints were called and their outcome, never the search terms.

ALTER TABLE organizations
  ADD COLUMN public_sources_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN public_sources_country text
    CHECK (public_sources_country IS NULL
           OR public_sources_country IN ('co', 'mx', 'pe', 'us', 'br', 'sv', 'bo', 'jp', 'cl', 've', 'gt')),
  ADD COLUMN public_sources_web boolean NOT NULL DEFAULT true,
  ADD COLUMN public_sources_monthly_limit integer NOT NULL DEFAULT 300
    CHECK (public_sources_monthly_limit BETWEEN 0 AND 100000);

ALTER TABLE usage_events DROP CONSTRAINT usage_events_kind_check;
ALTER TABLE usage_events ADD CONSTRAINT usage_events_kind_check CHECK (kind IN (
  'query', 'ingest_pages', 'ingest_documents', 'embedding_tokens', 'llm_input_tokens', 'llm_output_tokens',
  'rerank_calls', 'storage_bytes', 'ocr_pages', 'vision_images', 'audio_seconds', 'public_lookups'));
