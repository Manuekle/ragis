-- ragsis · Calificación comercial en el alta (ADR-021)
-- Preguntas de onboarding para saber si la organización es buen cliente: tamaño de equipo, volumen documental,
-- usuarios iniciales, comprador, dónde viven los documentos, señales de dolor y canal de origen.
-- Más el sector Logística. `lead_score`/`lead_tier` son derivados internos: la API no los devuelve al cliente.

-- Sector Logística (la CHECK original no tenía nombre explícito: usa el nombre por defecto de Postgres).
ALTER TABLE organization_profiles DROP CONSTRAINT IF EXISTS organization_profiles_sector_primary_check;
ALTER TABLE organization_profiles ADD CONSTRAINT organization_profiles_sector_primary_check
  CHECK (sector_primary IN ('legal', 'consulting', 'industry', 'accounting', 'insurance', 'construction', 'logistics', 'education', 'other'));

-- Volumen documental con corte en 500 (umbral comercial). 'lt_1k' se conserva como valor heredado válido.
ALTER TABLE organization_profiles DROP CONSTRAINT IF EXISTS organization_profiles_volume_estimate_check;
ALTER TABLE organization_profiles ADD CONSTRAINT organization_profiles_volume_estimate_check
  CHECK (volume_estimate IN ('lt_500', '500_1k', 'lt_1k', '1k_10k', '10k_100k', 'gt_100k'));

ALTER TABLE organization_profiles
  ADD COLUMN referral_source  text CHECK (referral_source IN ('google', 'linkedin', 'instagram', 'x', 'youtube', 'facebook', 'tiktok',
                                                              'whatsapp', 'referral', 'event', 'other')),
  ADD COLUMN referral_detail  text,
  ADD COLUMN buyer_role       text CHECK (buyer_role IN ('management', 'department_head', 'it', 'individual')),
  ADD COLUMN initial_users    text CHECK (initial_users IN ('1-4', '5-30', '31-100', '100+')),
  ADD COLUMN document_sources text[] NOT NULL DEFAULT '{}',
  ADD COLUMN fit_signals      text[] NOT NULL DEFAULT '{}',
  ADD COLUMN lead_score       smallint CHECK (lead_score BETWEEN 0 AND 100),
  ADD COLUMN lead_tier        text CHECK (lead_tier IN ('strong', 'possible', 'weak'));

CREATE INDEX organization_profiles_lead_idx ON organization_profiles (lead_tier, referral_source);
