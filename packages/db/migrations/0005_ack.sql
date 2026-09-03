ALTER TABLE bac_readings ADD COLUMN IF NOT EXISTS acknowledged_at timestamptz;
ALTER TABLE bac_readings ADD COLUMN IF NOT EXISTS acknowledged_by uuid REFERENCES users(id) ON DELETE SET NULL;
