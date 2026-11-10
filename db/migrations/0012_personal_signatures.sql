CREATE TABLE personal_signatures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 60),
  image_png bytea NOT NULL CHECK (octet_length(image_png) BETWEEN 1 AND 458752),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX personal_signatures_user_idx ON personal_signatures (user_id, created_at DESC);

ALTER TABLE personal_signatures ENABLE ROW LEVEL SECURITY;
ALTER TABLE personal_signatures FORCE ROW LEVEL SECURITY;
CREATE POLICY personal_signatures_owner ON personal_signatures FOR ALL TO ragsis_app
  USING (user_id = app.user_id()) WITH CHECK (user_id = app.user_id());
GRANT SELECT, INSERT, DELETE ON personal_signatures TO ragsis_app;

-- Capture the appearance accepted by the signer. A saved signature can be
-- deleted independently, including while the envelope waits for other signers.
ALTER TABLE signature_responses ADD COLUMN image_png bytea CHECK (octet_length(image_png) BETWEEN 1 AND 458752);
ALTER TABLE signature_responses ADD COLUMN personal_signature_id uuid;
ALTER TABLE signature_responses ADD CHECK (personal_signature_id IS NULL OR image_png IS NOT NULL);
