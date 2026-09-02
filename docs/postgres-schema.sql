-- Initial PostgreSQL schema for BACTrackManager.
-- Run migrations using a non-superuser application owner in production.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE membership_role AS ENUM ('owner', 'admin', 'operator', 'viewer');
CREATE TYPE device_status AS ENUM ('active', 'maintenance', 'retired');
CREATE TYPE test_session_status AS ENUM (
  'created', 'warmup', 'blow_start', 'blowing', 'analyzing',
  'completed', 'failed', 'cancelled', 'sync_pending', 'synced'
);
CREATE TYPE invite_status AS ENUM ('pending', 'accepted', 'expired', 'revoked');
CREATE TYPE import_job_status AS ENUM ('queued', 'running', 'completed', 'completed_with_errors', 'failed', 'cancelled');
CREATE TYPE reading_origin AS ENUM ('native_capture', 'consumer_import');
CREATE TYPE sync_mode AS ENUM ('disabled', 'bidirectional', 'upload_only', 'download_only');
CREATE TYPE team_role AS ENUM ('manager', 'member');
CREATE TYPE notification_channel AS ENUM ('in_app', 'email', 'push');
CREATE TYPE notification_status AS ENUM ('pending', 'sent', 'failed', 'read');
CREATE TYPE maintenance_type AS ENUM ('calibration', 'cleaning', 'battery_service', 'repair', 'inspection');
CREATE TYPE export_format AS ENUM ('csv', 'pdf', 'json');
CREATE TYPE export_status AS ENUM ('queued', 'running', 'completed', 'failed', 'expired');
CREATE TYPE reading_location_scope AS ENUM ('private', 'team_test_location');

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  display_name text NOT NULL,
  password_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (email)
);

CREATE TABLE user_sync_preferences (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  default_sync_mode sync_mode NOT NULL DEFAULT 'bidirectional',
  changed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mobile_clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
  app_version text,
  device_label text,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)
);

CREATE TABLE client_sync_preferences (
  mobile_client_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  sync_mode sync_mode NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (mobile_client_id, user_id)
    REFERENCES mobile_clients (id, user_id) ON DELETE CASCADE
);

CREATE TABLE client_sync_cursors (
  mobile_client_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  pull_cursor text,
  last_pulled_at timestamptz,
  last_pushed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (mobile_client_id, user_id)
    REFERENCES mobile_clients (id, user_id) ON DELETE CASCADE
);

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (slug)
);

CREATE UNIQUE INDEX users_email_case_insensitive_unique ON users (lower(email));

CREATE TABLE memberships (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role membership_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);

CREATE TABLE teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name),
  UNIQUE (organization_id, id)
);

CREATE TABLE team_memberships (
  organization_id uuid NOT NULL,
  team_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role team_role NOT NULL DEFAULT 'member',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id),
  FOREIGN KEY (organization_id, team_id)
    REFERENCES teams (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, user_id)
    REFERENCES memberships (organization_id, user_id) ON DELETE CASCADE
);

CREATE TABLE devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  serial_number text NOT NULL,
  model text NOT NULL,
  firmware_version text,
  status device_status NOT NULL DEFAULT 'active',
  last_battery_percent smallint CHECK (last_battery_percent BETWEEN 0 AND 100),
  last_use_count integer CHECK (last_use_count >= 0),
  last_seen_at timestamptz,
  last_mobile_client_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (serial_number),
  UNIQUE (organization_id, id)
);

CREATE TABLE device_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  device_id uuid NOT NULL,
  team_id uuid NOT NULL,
  assigned_by_user_id uuid,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  unassigned_at timestamptz,
  CHECK (unassigned_at IS NULL OR unassigned_at >= assigned_at),
  FOREIGN KEY (organization_id, device_id)
    REFERENCES devices (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, team_id)
    REFERENCES teams (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, assigned_by_user_id)
    REFERENCES memberships (organization_id, user_id) ON DELETE SET NULL (assigned_by_user_id)
);
CREATE UNIQUE INDEX device_assignments_one_active_team
  ON device_assignments (device_id) WHERE unassigned_at IS NULL;

CREATE TABLE device_maintenance_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  maintenance_type maintenance_type NOT NULL,
  performed_at timestamptz NOT NULL,
  due_at timestamptz,
  notes text,
  attachment_storage_key text,
  recorded_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX device_maintenance_records_due_at_idx
  ON device_maintenance_records (due_at) WHERE due_at IS NOT NULL;

CREATE TABLE test_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_session_id uuid NOT NULL,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  team_id uuid,
  device_id uuid,
  operator_user_id uuid NOT NULL,
  subject_user_id uuid,
  subject_acknowledged_at timestamptz,
  status test_session_status NOT NULL DEFAULT 'created',
  app_platform text NOT NULL CHECK (app_platform IN ('ios', 'android', 'web', 'consumer_api')),
  app_version text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  failure_code text,
  failure_detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_session_id),
  CHECK (completed_at IS NULL OR completed_at >= started_at),
  FOREIGN KEY (organization_id, team_id)
    REFERENCES teams (organization_id, id) ON DELETE SET NULL (team_id),
  FOREIGN KEY (organization_id, device_id)
    REFERENCES devices (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, operator_user_id)
    REFERENCES memberships (organization_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, subject_user_id)
    REFERENCES memberships (organization_id, user_id) ON DELETE SET NULL (subject_user_id)
);
CREATE INDEX test_sessions_organization_started_at_idx
  ON test_sessions (organization_id, started_at DESC);
CREATE INDEX test_sessions_device_started_at_idx ON test_sessions (device_id, started_at DESC);

CREATE TABLE device_leases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
  test_session_id uuid NOT NULL REFERENCES test_sessions(id) ON DELETE RESTRICT,
  holder_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  mobile_client_id uuid NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  released_at timestamptz,
  release_reason text,
  CHECK (expires_at > acquired_at),
  CHECK (released_at IS NULL OR released_at >= acquired_at)
);
-- Before acquiring a new lease, the API releases any expired active lease in
-- the same transaction, then inserts the replacement row.
CREATE UNIQUE INDEX device_leases_one_active_lease
  ON device_leases (device_id) WHERE released_at IS NULL;

CREATE TABLE session_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_session_id uuid NOT NULL REFERENCES test_sessions(id) ON DELETE CASCADE,
  sequence_no integer NOT NULL CHECK (sequence_no >= 0),
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (test_session_id, sequence_no)
);

CREATE TABLE readings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_session_id uuid NOT NULL UNIQUE REFERENCES test_sessions(id) ON DELETE RESTRICT,
  origin reading_origin NOT NULL DEFAULT 'native_capture',
  bac_value numeric(6, 4) NOT NULL CHECK (bac_value >= 0),
  bac_unit text NOT NULL CHECK (bac_unit IN ('bac_percent', 'promille', 'mg_l')),
  captured_at timestamptz NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  device_serial_number text,
  device_model text,
  device_firmware_version text,
  source_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX readings_captured_at_idx ON readings (captured_at DESC);

CREATE TABLE consumer_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider = 'bactrack_consumer'),
  provider_account_id text,
  oauth_token_ciphertext bytea NOT NULL,
  oauth_token_secret_ciphertext bytea NOT NULL,
  token_key_version smallint NOT NULL DEFAULT 1,
  authorized_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  last_successful_sync_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider),
  FOREIGN KEY (organization_id, user_id)
    REFERENCES memberships (organization_id, user_id) ON DELETE CASCADE
);

CREATE TABLE dawarich_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  server_url text NOT NULL,
  api_token_ciphertext bytea NOT NULL,
  token_key_version smallint NOT NULL DEFAULT 1,
  enabled boolean NOT NULL DEFAULT true,
  last_verified_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);

CREATE TABLE history_import_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consumer_connection_id uuid NOT NULL REFERENCES consumer_connections(id) ON DELETE RESTRICT,
  requested_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status import_job_status NOT NULL DEFAULT 'queued',
  requested_since timestamptz,
  source_cursor text,
  next_cursor text,
  fetched_count integer NOT NULL DEFAULT 0 CHECK (fetched_count >= 0),
  imported_count integer NOT NULL DEFAULT 0 CHECK (imported_count >= 0),
  skipped_count integer NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  started_at timestamptz,
  completed_at timestamptz,
  error_code text,
  error_detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (completed_at IS NULL OR started_at IS NOT NULL),
  CHECK (completed_at IS NULL OR completed_at >= started_at)
);
CREATE INDEX history_import_jobs_connection_created_at_idx
  ON history_import_jobs (consumer_connection_id, created_at DESC);

CREATE TABLE consumer_reading_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consumer_connection_id uuid NOT NULL REFERENCES consumer_connections(id) ON DELETE RESTRICT,
  history_import_job_id uuid NOT NULL REFERENCES history_import_jobs(id) ON DELETE RESTRICT,
  provider_reading_id text NOT NULL,
  reading_id uuid NOT NULL UNIQUE REFERENCES readings(id) ON DELETE RESTRICT,
  source_captured_at timestamptz,
  source_payload jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (consumer_connection_id, provider_reading_id)
);

CREATE TABLE reading_location_links (
  reading_id uuid PRIMARY KEY REFERENCES readings(id) ON DELETE CASCADE,
  dawarich_connection_id uuid NOT NULL REFERENCES dawarich_connections(id) ON DELETE RESTRICT,
  dawarich_point_reference text,
  latitude numeric(9, 6) NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude numeric(9, 6) NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  accuracy_meters numeric(10, 2) CHECK (accuracy_meters >= 0),
  location_captured_at timestamptz NOT NULL,
  scope reading_location_scope NOT NULL DEFAULT 'private',
  linked_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reading_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reading_id uuid NOT NULL REFERENCES readings(id) ON DELETE CASCADE,
  author_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  color text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

CREATE TABLE reading_tags (
  reading_id uuid NOT NULL REFERENCES readings(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  added_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (reading_id, tag_id)
);

CREATE TABLE attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reading_id uuid NOT NULL REFERENCES readings(id) ON DELETE CASCADE,
  storage_key text NOT NULL UNIQUE,
  content_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size > 0),
  sha256 text NOT NULL,
  uploaded_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  team_id uuid,
  email text NOT NULL,
  role membership_role NOT NULL DEFAULT 'operator',
  team_role team_role,
  token_hash text NOT NULL UNIQUE,
  status invite_status NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at),
  CHECK (
    (team_id IS NULL AND team_role IS NULL)
    OR (team_id IS NOT NULL AND team_role IS NOT NULL)
  ),
  FOREIGN KEY (organization_id, team_id)
    REFERENCES teams (organization_id, id) ON DELETE SET NULL (team_id)
);
CREATE UNIQUE INDEX invites_one_pending_recipient_per_team
  ON invites (organization_id, lower(email), team_id) WHERE status = 'pending';

CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  object_type text NOT NULL,
  object_id uuid,
  request_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_logs_organization_occurred_at_idx
  ON audit_logs (organization_id, occurred_at DESC);

CREATE TABLE user_notification_preferences (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel notification_channel NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, channel)
);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel notification_channel NOT NULL,
  status notification_status NOT NULL DEFAULT 'pending',
  notification_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  sent_at timestamptz,
  read_at timestamptz,
  failure_detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_status_created_at_idx
  ON notifications (user_id, status, created_at DESC);

CREATE TABLE export_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  requested_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  format export_format NOT NULL,
  status export_status NOT NULL DEFAULT 'queued',
  filter_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  storage_key text,
  expires_at timestamptz,
  error_detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX export_jobs_organization_created_at_idx
  ON export_jobs (organization_id, created_at DESC);
