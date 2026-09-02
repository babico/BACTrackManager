# BACTrackManager Plan

Verified on 2026-09-03 against the public BACtrack developer docs and GitHub repos.

## 1. Product Goal

Build a self-hosted BACtrack platform with:

- Mobile data capture on iOS and Android
- Web and desktop-friendly admin access
- Multi-user accounts
- Teams and role-based access
- Multiple device support
- Historical readings, live session status, and reporting

The important constraint is that BACtrack officially documents SDK support for iOS and Android, and their React Native support is an example bridge, not an official maintained library. That changes the architecture: Bluetooth capture should live in the mobile app, while web/desktop should focus on management, history, and monitoring.

## 2. Hard Constraints

### Official BACtrack constraints

- BACtrack officially documents iOS and Android SDKs.
- BACtrack's official React Native page says there is no official React Native library, only a demo using native modules.
- BACtrack supports scanning for multiple nearby devices, but the default SDK workflow assumes "connect to nearest device."
- A valid BACtrack API key is required and is checked during SDK initialization.
- Supported devices listed in the public docs are BACtrack Mobile, Mobile V2, C6, and C8.

### Product implications

- Do not treat web Bluetooth as a first-class delivery path for MVP.
- Do not assume React Native alone solves device access; native iOS and Android bridge code is required.
- Do not hardcode the BACtrack API key in the repo or in shared JavaScript.
- Do not use the example repos as production architecture. They are integration demos, not real products.

## 3. Recommended Platform Strategy

### Phase 1 target

- iOS and Android mobile app for all Bluetooth operations
- Web app for admin, team management, dashboards, history, exports
- Desktop access via the web app first

### Phase 2 target

- Optional desktop shell with Tauri or Electron for packaging the web admin
- Optional native desktop BLE research track only if you truly need direct device access from macOS or Windows

### Why

This avoids burning time on a weak platform path. BACtrack's own public SDK positioning is mobile-first. The fastest way to a working product is:

1. Mobile owns scanning, connecting, testing, and upload.
2. Backend owns users, teams, readings, devices, and audit trails.
3. Web/desktop owns visibility and operations.

## 4. Recommended Architecture

Use a TypeScript monorepo.

### Apps

- `apps/mobile`
  React Native app for iOS and Android. Use bare React Native or a custom native build path, not Expo Go.
- `apps/web`
  Next.js admin app for desktop and browser usage.
- `apps/api`
  NestJS API for auth, tenancy, readings, devices, and realtime events.

### Packages

- `packages/contracts`
  Shared types, schemas, and API contracts.
- `packages/device-state`
  Shared finite-state definitions for connection/test flows.
- `packages/ui`
  Shared UI primitives where reuse makes sense.
- `packages/config`
  Shared lint, tsconfig, env validation, and tooling config.

### Infrastructure

- PostgreSQL for primary relational data
- Redis for session locks, queues, and transient device leases
- S3-compatible storage such as MinIO for attachments and exports
- WebSocket or Server-Sent Events for live test/session updates
- Docker Compose for local and home-lab deployment
- Caddy or Traefik as reverse proxy

### PostgreSQL connection and deployment

- Run PostgreSQL as a private Docker Compose service. Only the API and administrative tooling may connect to it; do not expose port `5432` through the public reverse proxy.
- Give the application a dedicated non-superuser role, for example `bactrack_app`, and use a separate migration role. Store both credentials outside Git in the deployment secret store or `.env` excluded by `.gitignore`.
- The API receives one `DATABASE_URL` URI, for example `postgresql://bactrack_app:<password>@postgres:5432/bactrack`. Keep the hostname `postgres` for the internal Docker network; use a private DNS name, TLS, and certificate verification for any remote database.
- Set finite connection and statement timeouts in the database driver. Use a connection pool in the API process; mobile and web clients never receive database credentials.
- Use PostgreSQL as the system of record. Redis accelerates leases and queues, but a lease acquisition or release must also be recorded in PostgreSQL so failures can be recovered and audited.
- Run schema changes only through versioned migrations. Do not allow the application runtime role to execute ad-hoc DDL in production.

The connection URI form and TLS modes are defined by PostgreSQL. `sslmode=verify-full` is the correct remote deployment posture because it validates both the CA and requested server hostname; a local private Docker network can run without TLS initially. See PostgreSQL's connection documentation in the references.

## 5. Core Domain Model

Start with these entities:

- `users`
- `organizations`
- `memberships`
- `teams`
- `team_memberships`
- `devices`
- `device_assignments`
- `device_leases`
- `test_sessions`
- `session_events`
- `readings`
- `reading_notes`
- `attachments`
- `invites`
- `audit_logs`

### Minimum fields that matter

- `devices`
  serial number, BACtrack model, firmware version, last battery reading, use count, org ownership, assigned team, last seen, last mobile client
- `test_sessions`
  operator user, subject user, device, org, team, lifecycle status, started at, completed at, failure reason
- `readings`
  measured BAC, unit, device serial, app version, platform, captured at, synced at, optional note, optional attachment reference
- `device_leases`
  device, holder user or mobile client, lease expiry, session id
- `audit_logs`
  actor, object type, object id, action, timestamp, metadata

### Initial PostgreSQL schema

The initial executable DDL is in `docs/postgres-schema.sql`. It uses UUID primary keys, timestamped records, JSONB only for provider/device payloads, and explicit relational columns for data used in filters or permission checks.

Key constraints to retain:

- `memberships` is unique per organization/user pair.
- `devices.serial_number` is globally unique and remains the physical-device identity.
- `test_sessions.client_session_id` is globally unique, making mobile uploads idempotent.
- one `readings` row belongs to one completed session; the measured value is never updated in place.
- a partial unique index allows only one unreleased `device_leases` record per device. Expired leases must be released transactionally before a replacement is granted.
- assignment, session, reading, and audit history is retained instead of overwritten.

For visual review, the initial entity relationships are in `docs/data-model.mmd`.

## 6. State Machines You Need Early

### Device connection state

- idle
- requesting_permissions
- initializing_sdk
- scanning
- discovered
- connecting
- connected
- ready
- disconnected
- failed

### Test session state

- created
- warmup
- blow_start
- blowing
- analyzing
- completed
- failed
- cancelled
- sync_pending
- synced

Do not spread this logic across random React state. Put it behind a clear state machine or reducer so reconnects, retries, and background resumes are predictable.

## 7. Multi-User and Multi-Device Rules

This is where most demo apps break.

### Device rules

- One physical BACtrack device can only be actively leased to one session at a time.
- A mobile client should acquire a short lease from the backend before starting a test.
- Lease expiry should recover automatically if the app crashes or connectivity drops.
- Serial number should be the stable identity key for cataloging devices.

### User rules

- Roles: `owner`, `admin`, `operator`, `viewer`
- Teams scope which devices and readings a user can access
- Subject user and operator user should be separate fields when relevant

### Team member results

Team members can run a device test for another member and add the measured result to that member's team history.

- The test creator is stored as `operator_user_id`; the person tested is stored as `subject_user_id`. They may be the same person for a self-test.
- Before a team test starts, the API verifies that both people are active members of the selected team. This check occurs in the same transaction that creates the test session and device lease.
- Organization roles decide who can create tests: `owner`, `admin`, and `operator` can record a device test; `viewer` is read-only. Team roles are `manager` and `member`; managers can invite/remove team members and manage team devices.
- The result appears in the selected subject's history and the selected team's shared history. The UI labels it as `Tested by <operator>` rather than implying the subject entered it personally.
- A subject can acknowledge the result after it is recorded. A missing acknowledgement does not alter the BACtrack measurement, but is visible in the history and audit trail.
- Any team member may add a note when their permissions allow it. Nobody may edit the measured BAC value, device metadata, or captured timestamp after ingestion.
- If a user uses `download_only` or `disabled` sync, they may not create a managed team result because the team membership and device lease cannot be safely verified online.

### Team invitation by email

Team `owner`, `admin`, and `manager` users can invite a person by email from the team-members screen.

1. Inviter selects an organization role (`viewer`, `operator`, `admin` where allowed) and a team role (`member` or `manager`).
2. Backend creates one pending, expiring invitation and stores only a hash of a high-entropy, single-use token.
3. The email contains an HTTPS accept link. It names the organization and team but does not expose any readings or invite token in logs, analytics, or client-side storage.
4. Recipient signs in or creates an account using the invited email address, then accepts the invite.
5. In one database transaction, the backend verifies the token, expiry, recipient email, and inviter permissions; creates or preserves the organization membership; upserts the team membership; marks the invite accepted; and writes an audit event.

Rules and safeguards:

- A pending invite is unique for the same organization, email, and team. Resending rotates the token and expiry rather than creating unbounded duplicate invitations.
- Normalize email addresses for lookup and enforce case-insensitive uniqueness for user accounts before accepting an invitation.
- Expired, revoked, or already accepted invitations cannot be reused. The API returns a generic response to avoid disclosing whether an email already belongs to an account.
- Inviting an existing organization member changes only the selected team membership. It must not silently downgrade their existing organization role.
- Managers may invite `member` roles only. Organization `owner` or `admin` is required to invite another manager or grant elevated organization access.
- Add resend, revoke, and pending-invite views. Rate-limit sends by organization and destination email, and audit invitation creation, resend, acceptance, and revocation.
- Keep email delivery behind an `EmailService` interface so the home lab can begin with SMTP and later use a transactional provider without changing authorization logic.

### Sync rules

- Mobile writes readings locally first
- Upload is idempotent using a client-generated session id
- Backend accepts duplicate retries safely
- Live dashboards subscribe to server-side session updates

## 8. Security and Trust Decisions

Even for a home lab project, set this up correctly.

- Keep the BACtrack API key out of the repo.
- Deliver SDK credentials through secure mobile configuration, or inject them at build/deploy time.
- Use short-lived app auth tokens for your own backend.
- Encrypt sensitive data at rest where practical.
- Keep immutable audit logs for result creation, edits, exports, and device assignment changes.
- Record device metadata alongside each reading.
- Never allow silent editing of measured BAC values after capture.

### User-controlled sync direction

Every user has a default sync mode, and each mobile client may override it. The app presents these choices clearly:

| Mode | Cloud to local | Local to cloud | Managed device lease |
| --- | --- | --- | --- |
| `disabled` | no | no | no |
| `upload_only` | no | yes | yes |
| `download_only` | yes | no | no |
| `bidirectional` | yes | yes | yes |

- `disabled`: new readings stay encrypted in the local database and never appear in web history, teams, exports, or another device.
- `upload_only`: the client sends its new readings and can use backend device leases, but does not pull cloud history, team changes, or readings created on other devices.
- `download_only`: the client may fetch cloud history, including completed consumer-history imports, but never uploads a new reading, session, note, attachment, or local backlog. It cannot claim a managed device lease.
- `bidirectional`: both directions run. This is the default for a newly configured client.
- The mobile client applies a mode change immediately and persists it locally so a queued worker cannot continue after the user disables a direction.
- Re-enabling upload never sends the local backlog automatically. The user explicitly chooses `sync saved readings` or `keep local only`, with a count and date range before confirmation.
- Downloads use an opaque server cursor per client. Uploads use the client-generated session ID, so retries are idempotent and the two directions can resume independently.
- Readings are immutable. A pull never overwrites a local reading; it either creates a missing local record or recognizes the same client session ID as already synchronized.
- Consumer-history import is unavailable only in `disabled` mode because it requires a server-held OAuth connection. Its imported records are delivered to a device only when that device allows downloads.
- Record mode changes in `audit_logs`, but do not upload reading contents when the effective mode lacks `local to cloud` permission.

### If you ever want higher-trust workflows later

Plan extension points for:

- photo or selfie evidence
- location capture
- witness approval
- calibration reminders
- signed export bundles

### Consumer history migration

Support a user-initiated import from the BACtrack consumer/Mobile-server history as a separate, auditable ingestion path.

- Create one private personal organization for every account at sign-up. A consumer connection is bound to that organization and imported history enters there first.
- The user explicitly connects their BACtrack consumer account through the server-side OAuth 1.0 authorization flow. Never collect or store their BACtrack password.
- Encrypt the OAuth access token and token secret at rest. The mobile and web clients receive only the status of the connected account, never the token material.
- Create a durable `history_import_jobs` row before fetching. Store continuation cursor, counts, timestamps, and a sanitized failure reason so interrupted imports can resume safely.
- Convert each remote history item into a completed `test_sessions` row with `app_platform = consumer_api` and one local `readings` row with `origin = consumer_import`.
- Preserve raw provider payloads in `consumer_reading_imports.source_payload` for future parser corrections, but show users normalized local data.
- Deduplicate using the pair `(consumer_connection_id, provider_reading_id)`. If the consumer API does not provide a stable reading ID, define and document a deterministic fallback fingerprint only after reviewing its authenticated response format.
- Do not merge imported and native-capture readings by timestamp alone. Imported data may have different timestamps, units, device metadata, or correction history.
- Make imports private to the account owner by default. Copy or share imported readings into a team only through an explicit follow-up action.
- Provide `disconnect consumer account` and `delete imported data` controls. Disconnecting revokes or deletes stored tokens but does not automatically delete already imported readings unless the user chooses that action.

#### Import workflow

1. User selects `Import BACtrack history` in web or mobile.
2. Backend starts the provider authorization flow and receives the OAuth callback.
3. Backend encrypts the access credentials and creates a queued import job.
4. Worker fetches every history page, records its cursor after each committed page, and upserts source records by provider reading ID.
5. Worker creates local immutable sessions/readings, publishes progress, and marks the job completed or completed with errors.
6. User reviews the import summary: fetched, imported, skipped duplicate, and failed records.

The public BACtrack documentation confirms a REST API and OAuth 1.0 authentication, but not the endpoint, field, cursor, scope, rate-limit, or revocation contract. Inspect the authenticated developer documentation and capture a sample response before implementing the worker.

### Dawarich map and movement-history integration

Dawarich is a self-hosted location-history system, similar in purpose to Google Timeline. It already owns the raw GPS points, tracks, visits, map layers, and movement statistics. BACTrackManager should integrate with it instead of building a second GPS tracker and location database.

- A user optionally connects one self-hosted Dawarich instance by entering its HTTPS server URL and API key. The backend encrypts the API key; web and mobile clients never receive it.
- The backend verifies the connection using Dawarich API v1, then exposes a narrow internal map API: user map by date range, point/track lookup near a reading time, and connection status. It does not proxy arbitrary Dawarich requests.
- The map page always renders BAC reading markers. On page load it checks whether the signed-in user has an enabled, verified Dawarich connection.
- If Dawarich is connected, the map page requests its points for the selected date range and overlays them as a dedicated `Dawarich location points` layer. The user can toggle points, tracks, and BAC reading markers independently.
- If Dawarich is not connected, unreachable, or disabled, the map page remains usable with BAC reading markers only and shows a non-blocking `Connect Dawarich to show movement points` action.
- Dawarich points are fetched on demand through the backend and are not copied into the BACTrackManager database for normal map rendering. Only an explicitly linked reading stores a small coordinate snapshot.
- Clicking a BAC marker shows the reading, operator, device, and optional location accuracy. Clicking a Dawarich point shows only point time and accuracy unless the user opens Dawarich itself for richer history details.
- When a reading completes, the user may choose `link nearest Dawarich location`. The backend requests only a small time window around the reading, stores the resulting point reference and location snapshot in `reading_location_links`, and keeps the full movement history in Dawarich.
- Reading locations are private by default. A user can explicitly set one result's location to `team_test_location`; this shares only that point with the authorized team, not their route, visits, or movement history.
- Team dashboards never show a member's movement history. Managers can view a shared test-location marker only where the subject opted in and team permissions allow it.
- Location collection and Dawarich lookup are disabled by default. The connection, map, reading-location linking, and per-reading sharing each require separate consent toggles.
- The map integration follows the effective sync direction: `download_only` and `bidirectional` may load maps; `upload_only` and `disabled` do not fetch Dawarich data. A disconnected or disabled Dawarich connection removes map access immediately.
- Provide `disconnect Dawarich` and `delete linked locations` controls. Disconnecting deletes the encrypted API credential. Deleting links removes copied coordinate snapshots from BACTrackManager but does not modify the user's Dawarich history.
- Restrict outbound integration targets to an administrator-approved Dawarich origin and use a server-side HTTP client with strict URL validation, timeouts, and no redirect following to avoid SSRF through a user-entered URL.

Implementation order:

1. Run Dawarich separately in the home lab and verify its own map/history works.
2. Add encrypted connection storage and a server-side health check.
3. Build a read-only personal map by date range.
4. Add optional nearest-point linking after a BAC reading.
5. Add subject-consented, single-point sharing for team results.

Use the `/api-docs` endpoint on the target Dawarich instance for the exact points, tracks, and map endpoint shapes at the installed version. Dawarich documents API-key query authentication and Bearer authentication, but the adapter must use one configured method consistently and keep it server-side.

## 9. MVP Scope

Ship this first:

- Email/password or magic-link auth
- Organization and team creation
- User invitation flow
- Mobile BACtrack connect/test flow on iOS and Android
- Device registry using serial number
- Result upload and reading history
- Web dashboard with filters by user, team, device, date
- Basic audit log
- Offline queue and retry on mobile
- Device lease locking to avoid concurrent use conflicts
- Per-user cloud-sync control with local-only storage and explicit backlog upload consent
- Team member selection for an operator-recorded BACtrack result, with subject/operator attribution and acknowledgement
- Email-based organization and team invitations with acceptance, resend, revoke, and audit history

## 10. V2 Scope

Add after MVP is stable:

- Manual scan and choose-device UX
- Live observer view for admins
- CSV and PDF exports
- Notes, tags, and attachments
- Notifications for failed tests or completed sessions
- Calibration and maintenance reminders
- Device health dashboard
- Kiosk mode for a dedicated operator tablet

## 11. V3 Scope

Only after the above is working:

- Desktop wrapper app
- Advanced analytics
- BACtrack-hosted reading API evaluation
- External integrations
- More formal evidence and compliance workflows

## 11A. Additional Product Features

Build these as the core reading flow becomes stable:

- Device maintenance center: calibration, cleaning, repair, battery-service history, next-due reminders, and document attachments.
- Notifications: in-app first, then optional email/push for invitations, failed imports, completed exports, low battery, expired leases, and maintenance due dates.
- Tags and saved filters: tag readings such as `personal`, `training`, or `research`; save common team/device/date searches.
- Reports and exports: async CSV, PDF, and JSON jobs with filters, audit records, expiring download links, and role-based access.
- Personal dashboard: recent readings, personal trend chart, connected devices, pending invites, sync state, and privacy controls.
- Team dashboard: active devices, current leases, latest team tests, maintenance alerts, pending invitations, and member activity.
- Device lifecycle: assign/unassign devices, retire a device without deleting history, and show firmware, battery, use count, calibration, and last-seen status.
- History quality controls: flag an imported record or add a correction note without ever changing the original measured value.
- Account controls: profile, password or passkey setup, active-client list, revoke a client, export personal data, and delete-account workflow.
- Kiosk mode: a locked-down tablet flow for an operator to select a team member, run a test, and return to an idle screen without exposing other history.
- Optional Dawarich integration: personal movement-history maps and consented reading-location markers without duplicating raw GPS tracks.

## 12. Tech Decisions

### Mobile

- React Native with native bridge modules for BACtrack iOS and Android SDKs
- React Navigation
- TanStack Query for network sync
- SQLite or MMKV plus durable queue storage for offline-first behavior

### Web

- Next.js
- TanStack Query
- Server-rendered admin pages plus live session panels

### Backend

- NestJS
- Prisma or Drizzle with PostgreSQL
- Redis for leases and queues
- OpenAPI generation for client contracts

### Observability

- Sentry
- structured logs
- health endpoints

## 13. Suggested Monorepo Layout

```text
apps/
  api/
  mobile/
  web/
packages/
  config/
  contracts/
  device-state/
  ui/
infra/
  docker/
  caddy/
docs/
  decisions/
  api/
```

## 14. First 2 Weeks

### Week 1

1. Get BACtrack developer access and API key.
2. Decide the initial supported hardware models.
3. Scaffold the monorepo.
4. Bring up PostgreSQL, Redis, and API locally with Docker Compose.
5. Build a minimal React Native app that can initialize the SDK.
6. Implement the native bridge for:
   - initialize
   - request permissions
   - scan
   - connect
   - disconnect
   - start countdown
   - battery
   - serial number

### Week 2

1. Add backend auth and organizations.
2. Add device registry and lease endpoints.
3. Persist mobile session events locally.
4. Upload completed readings to the backend.
5. Build the first web dashboard for readings and devices.
6. Test one Android device and one iPhone against the same backend.

## 15. First 6 Milestones

1. `M1 - Native proof of connection`
   Mobile app initializes SDK, discovers a device, connects, and reads serial number.
2. `M2 - First successful BAC reading`
   Full warmup to result flow works on iOS and Android.
3. `M3 - Backend persistence`
   Reading uploads with device metadata and audit trail.
4. `M4 - Multi-user tenancy`
   Organizations, teams, invites, permissions.
5. `M5 - Device locking`
   Concurrent-use protection across mobile clients.
6. `M6 - Admin web`
   Dashboard, search, exports, and device status views.
7. `M7 - Consumer history import`
   User authorizes BACtrack history access, imports pages idempotently, and can review or disconnect the connection.

## 16. Risks To Watch Immediately

- BACtrack's React Native path is sample-grade, so you own the native bridge quality.
- Community wrappers are thin and should be treated as reference, not foundation.
- Web and desktop direct BLE access are not the official BACtrack path.
- Device concurrency gets messy fast without backend leases.
- Offline sync without idempotency will create duplicate readings.
- Consumer-history API field names and pagination must be validated from authenticated BACtrack documentation before implementation.

## 17. What Not To Do

- Do not start by trying to support web Bluetooth, Windows BLE, and macOS BLE all at once.
- Do not start with advanced analytics before the reading pipeline is stable.
- Do not model everything as a single-user app and bolt teams on later.
- Do not let the frontend invent business rules that the backend does not enforce.

## 18. Best Starting Build Order

1. Mobile BACtrack proof of life
2. Backend auth and tenancy
3. Reading ingestion and storage
4. Device lease system
5. Web admin dashboard
6. Reporting and exports

## 19. Open Questions To Resolve Before Scaffolding

- Which BACtrack models do you own or plan to support first?
- Is this personal/home-lab only, or do you want a path toward real monitored workflows?
- Do you need subject accounts separate from operator accounts?
- Do you need attachments, location, or photo evidence in MVP?
- Do you want self-host only, or eventually cloud deployable too?

## 20. References

- BACtrack SDK overview: https://developer.bactrack.com/breathalyzer_sdk/documentation
- BACtrack Android SDK repo: https://github.com/BACtrack/breathalyzer-sdk-android
- BACtrack iOS SDK repo: https://github.com/BACtrack/breathalyzer-sdk-ios
- BACtrack React Native demo docs: https://developer.bactrack.com/breathalyzer_sdk/react_native/demo
- BACtrack React Native demo repo: https://github.com/BACtrack/react-native-sdk-demo
- BACtrack SDK page: https://www.bactrack.com/pages/sdk
- Community Flutter wrapper: https://github.com/deanriverson/flutter_bactrack
- PostgreSQL connection strings and TLS modes: https://www.postgresql.org/docs/current/libpq-connect.html
- BACtrack SDK overview, including Mobile-server REST API and OAuth 1.0 statement: https://developer.bactrack.com/breathalyzer_sdk/documentation
- Dawarich overview: https://dawarich.app/docs/intro/
- Dawarich API and authentication: https://dawarich.app/docs/api/dawarich-api/
- Dawarich location tracking and per-instance `/api-docs`: https://dawarich.app/docs/getting-started/track-your-location/
