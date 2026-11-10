-- ragsis · Cortes de tamaño de equipo alineados al rango comercial objetivo 15–150 (ADR-021)
-- Antes: 1-10 / 11-50 / 51-200 / 201-1000 / 1000+. Ahora: 1-14 / 15-50 / 51-150 / 151-500 / 500+.
-- Los valores antiguos se reasignan al corte nuevo más cercano (aproximado en los bordes).
ALTER TABLE organization_profiles DROP CONSTRAINT IF EXISTS organization_profiles_team_size_check;
UPDATE organization_profiles SET team_size = CASE team_size
  WHEN '1-10'     THEN '1-14'
  WHEN '11-50'    THEN '15-50'
  WHEN '51-200'   THEN '51-150'
  WHEN '201-1000' THEN '151-500'
  WHEN '1000+'    THEN '500+'
  ELSE team_size END
WHERE team_size IS NOT NULL;
ALTER TABLE organization_profiles ADD CONSTRAINT organization_profiles_team_size_check
  CHECK (team_size IN ('1-14', '15-50', '51-150', '151-500', '500+'));
