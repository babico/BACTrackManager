CREATE TABLE IF NOT EXISTS dawarich_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  base_url text NOT NULL,
  encrypted_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_dawarich_user ON dawarich_connections (user_id);
