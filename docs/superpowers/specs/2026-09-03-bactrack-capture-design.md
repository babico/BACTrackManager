# BACTrackManager Capture-First Design (C6, iOS, key-pending)

Date: 2026-09-03. Status: approved for build. Parent docs: `PLAN.md`,
`plans/bactrack-manager-implementation/plan.mdx`.

## 1. Locked decisions

- First hardware: BACtrack C6 (owned). iOS capture first, Android follows.
- BACtrack developer API key: NOT yet issued. Apply at sdk.bactrack.com in
  parallel with build. Key is free; approval is a formality, not procurement.
- Test subjects: registered team accounts only. No managed non-login profiles
  in v1. Operator (`operator_user_id`) and subject (`subject_user_id`) are
  separate columns; self-test allowed when equal.
- Dawarich integration deferred until capture + tenancy stable. Contract
  already pinned (section 5); no code yet.

## 2. No-key BLE reality (verified 2026-09-03)

- iOS SDK ships as closed-source `BreathalyzerSDK.xcframework`
  (BACtrack/breathalyzer-sdk-ios, MIT-licensed repo, binary payload).
  Android SDK ships via JitPack binary. GATT protocol undocumented.
- Key gate lives inside SDK: community wrapper (deanriverson/flutter_bactrack)
  shows SDK emits `apiKeyAuthorized` / `apiKeyDeclined`. No valid key means
  no connect and no test through official path.
- BACtrack consumer-app traffic is REST + OAuth 1.0 to BACtrack Mobile-server
  (stored history, not live reads). Sniffing it does not unlock live capture;
  it maps to the Phase 7 consumer-import path only.
- Direct CoreBluetooth GATT reverse-engineering is physically possible (open
  BLE scan/connect/enumerate) but protocol bytes are proprietary, fragile
  across firmware, and outside ToS. Spike-grade only, never production path.
- Without key, iOS can still: scan, discover C6 advertisements, enumerate
  GATT services/characteristics, record RSSI, read exposed serial/battery.

## 3. Workstream S1 — iOS BLE survey spike (no key, time-boxed 1-2 days)

- Swift CoreBluetooth probe app (throwaway target, not shipped):
  scan -> discover C6 -> connect -> discover services/characteristics ->
  dump UUIDs, properties, advertisement payload, RSSI series.
- Output: `docs/c6-ble-survey.md` with fingerprint table + verdict
  (replayable-looking vs opaque/handshake-gated).
- Success: fingerprint doc committed. Failure (opaque): spike stops, no
  further direct-BLE effort until key lands. Either outcome unblocks S2.

## 4. Workstream S2 — fake-adapter vertical slice (main build)

- `BreathalyzerAdapter` interface owns ALL device contact. Deterministic fake
  emits `sdk.authorized, scan.found, connection.ready, test.countdown,
  test.blow, test.analyzing, test.result, error`. Real C6 SDK drops behind
  the same interface when key arrives; fake retained for CI.
- Backend (NestJS + Drizzle, Postgres `bactrackmanager` DB, currently empty):
  auth (password + magic link, JWT access + rotating hashed refresh),
  personal org on signup, teams, email invites, C6 registry keyed by serial
  number, atomic test-session + exclusive device-lease creation, idempotent
  completion keyed by client session ID, append-only readings + audit log,
  SSE session updates.
- Mobile (bare React Native, New Architecture, Turbo Native Module spec):
  connection/test reducer (no scattered useState), encrypted SQLite event
  journal persisted before UI transitions, offline queue with explicit
  backlog-upload consent, four sync modes
  (`disabled, upload_only, download_only, bidirectional`).
- Web (Next.js): auth, personal/team history with user/team/device/date
  filters, reading detail with `Tested by <operator>` attribution, subject
  acknowledgement, devices, invites, audit view. Map page renders BAC markers
  only (Dawarich layer stubbed behind feature flag).
- Done: operator invites teammate, selects them as subject, acquires lease,
  completes fake C6 test on iOS, kills app mid-upload, retries with zero
  duplicates, result visible in web dashboard.

## 5. Pinned external contracts (probed live, do not re-discover)

- Dawarich sample instance `http://192.168.21.2:3000`, version 1.9.2
  (`X-Dawarich-Version` response header, self-hosted, no rate limits).
  Auth: `?api_key=` query or `Authorization: Bearer`, both verified working.
- `GET /api/v1/health` -> `{"status":"ok"}`.
- `GET /api/v1/users/me` -> `{user:{email, settings{timezone, maps, ...}}}`.
- `GET /api/v1/points?start_at&end_at&order&per_page&page&slim&bbox` ->
  full ~30-field points or slim
  `{id,latitude,longitude,timestamp,velocity,country_name,tracker_id}`.
- `GET /api/v1/locations?lat&lon&limit&date_from&date_to&radius_override`
  (note `lat`/`lon`, NOT `latitude`/`longitude`) ->
  `{locations:[{place_name,coordinates,total_visits,first_visit,last_visit,
  visits:[...]}]}`.
- `GET /api/v1/timeline?start_at&end_at` (max 31 days) ->
  `{days:[{date,summary,bounds,entries:[visit|journey]}]}`.
- `GET /api/v1/tracks?start_at&end_at&page&per_page` -> GeoJSON
  FeatureCollection; `GET /api/v1/tracks/:id/points` -> points ascending.
- `GET /api/v1/visits?start_at&end_at` ->
  `[{id,started_at,ended_at,duration,name,status,place}]`.
- `GET /api/v1/places|stats|insights|settings|maps/hexagons|
  tags/privacy_zones` all 200. Unknown paths return HTML login page, not JSON.
- BACtrack SDKs: connect-nearest default, multi-scan supported, five-step
  test workflow (warmup, blow countdown, blow, analyze, result), device
  stats (battery, use count, serial). Supported models: Mobile, Mobile V2,
  C6, C8.

## 6. Non-goals for this slice

Browser BLE production use, Android bridge, consumer-history import,
Dawarich overlay UI, exports/PDF, notifications, kiosk mode, desktop shell,
passkeys/MFA, evidentiary compliance claims.

## 7. Milestone order

M0 key application submitted. M1 BLE survey doc. M2 monorepo + infra +
migrations. M3 fake-adapter E2E (S2 done-criteria). M4 real-SDK swap +
C6 hardware-in-loop matrix on iOS. M5 second device + second iPhone race
test for lease exclusivity. Dawarich overlay only after M4 green.
Consumer-history import (section 8) can parallelize with M2/M3 — no longer
gated on authenticated provider docs.

## 8. BACtrack consumer API v1 (captured from official iOS app, no SDK needed)

Source: `user-app-requests.har` (local only, git-ignored, contains live
secrets — never commit, see section 9). Public developer docs still describe
OAuth 1.0; the shipped app actually uses Auth0 PKCE + Bearer JWT. The docs
are outdated; this capture supersedes them for the import path.

- Base: `https://consumer-api.bactrack.com`. Auth: `Authorization: Bearer
  <user JWT>` on every call. App UA: `BACtrack/<build> CFNetwork/...`.
- Login flow (Auth0 PKCE at `https://login.bactrack.com`): `GET /authorize`
  with `client_id, code_challenge, code_challenge_method=S256,
  response_type=code, redirect_uri (app callback scheme), scope, audience,
  state, auth0Client` -> system-browser login (`/u/login`, username +
  password) -> code to app callback -> `POST /oauth/token` with `code,
  client_id, code_verifier, redirect_uri, grant_type=authorization_code` ->
  Bearer JWT (~791 chars). `POST /oauth/revoke` with `token, client_id`
  on logout. JWKS at `/.well-known/jwks.json`. Concrete `client_id`,
  `audience`, and callback scheme are extractable from the local HAR when
  implementing; they are first-party app credentials, not user secrets.
- `GET /api/v1/readings?page&limit` -> 200 `{readings: [{bacLevel: int,
  breathalyzerMode, deviceSN, deviceType, id: uuid, latitude: float,
  longitude: float, organizationID: uuid, platform, syncedAt: ISO-8601,
  testedAt: ISO-8601, testedAtTimezone, userID: uuid}]}`. Observed limits
  1/20/100; single page returned 23 rows.
- `POST /api/v1/readings` with `{readings: [{bacLevel, organizationID,
  deviceSN, longitude, testedAt, deviceType, platform, latitude,
  testedAtTimezone, syncedAt, breathalyzerMode}]}` -> 201, echoes created
  row(s) including server `id`. Client-generated content; server trusts the
  client value — ingest as `origin = consumer_import`, never as verified
  managed capture.
- `GET /api/v1/devices?page&limit` -> 200 `{has_more: bool, items:
  [{created_at, device_type, id: uuid, metadata: {}, serial_number, status,
  updated_at}], limit, page, total}`.
- `GET /api/v1/users/me` -> `{email, firstName, id: uuid, lastName, phone:
  {callingCode, countryCode, international, national, number}, status}`.
- `GET /api/v1/users/me/preferences` -> `{userPreferences: [{category,
  createdAt, organizationID, preferences: {...}, updatedAt}]}`.
- `GET /api/v1/consents/me/status` -> `{requiredConsents: [], status}`.
- `GET /api/v1/users/migration` -> 404 `{message}` when no migration pending.
- `GET https://developer.bactrack.com/verify/?api_token=` -> 200 body `ok`.
  SDK-key check is a trivial GET; still requires a real issued key.
- Observed enums: `deviceType: c6`, `breathalyzerMode: app`,
  `status: active`, deviceSN pattern `NN-XXX-N-NNNNN`.
- No-SDK product consequence: account login (PKCE in system browser, never
  touching the password), history import, device list, and upload relay are
  all implementable without the developer SDK key. Live breath capture still
  needs the device (SDK or S1 GATT work) because the C6 has no display and
  the BAC value originates in hardware. Treat all consumer-origin rows as
  untrusted-client data: separate origin flag, raw payload retained,
  idempotency on provider `id`.

## 9. Capture hygiene (HAR lessons)

- A `.har` of a login session contains plaintext password, Bearer JWTs,
  cookies, PII, and home GPS in trivially decodable form. `*.har` is
  git-ignored. Never attach captures to issues, PRs, or chat.
- After any credential appears in a capture, rotate it (BACtrack account
  password first). Prefer app-generated test accounts for future captures.
- Future captures: use a throwaway account, quit unrelated tabs, strip
  `Cookie`/`Authorization` before storing, keep only the endpoint shapes.
