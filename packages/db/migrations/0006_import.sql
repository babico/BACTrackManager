CREATE TABLE IF NOT EXISTS consumer_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_id uuid NOT NULL REFERENCES bactrack_identities(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  status varchar(16) NOT NULL DEFAULT 'completed',
  imported_count integer NOT NULL DEFAULT 0,
  skipped_count integer NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
ALTER TABLE bac_readings ALTER COLUMN session_id DROP NOT NULL;
ALTER TABLE bac_readings ADD COLUMN IF NOT EXISTS provider_reading_id text UNIQUE;
