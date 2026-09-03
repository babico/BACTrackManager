# BACtrack consumer live probes (user-run, throwaway account ONLY)

Never use a personal account. Never store the throwaway password anywhere
(HAR danger, see design doc section 9). Rotate/delete the throwaway after.

Prereqs: API running locally, `BACTRACK_CLIENT_ID` + `BACTRACK_AUDIENCE` in
`.env` (already present), a fresh throwaway BACtrack account created in the
official app (one real C6 test synced so history is non-empty).

## Probe 1 — loopback redirect_uri acceptance

Goal: learn whether our own PKCE login can complete without BACtrack
whitelisting us.

1. `POST /auth/bactrack/start` with `{"redirectUri":"http://127.0.0.1:9/cb"}` → copy `url`.
2. Open `url` in a browser, log in with the throwaway.
3. If Auth0 redirects to `http://127.0.0.1:9/cb?code=...&state=...` → loopback accepted. Copy `code`+`state`.
4. `GET /auth/bactrack/callback?code=...&state=...&redirect_uri=http://127.0.0.1:9/cb` → expect 200 pair + user.
5. If Auth0 shows "redirect_uri mismatch" instead → loopback rejected; record exact error text in the design doc and stop (options then: ROPG probe below, or wait for official key + bundled-scheme relay).

## Probe 2 — refresh grant

1. From probe 1 (or mocked flow), obtain linked identity with stored refresh.
2. Call the service `providerRefresh` via `POST /imports/consumer/run` twice with an expired access token in between (revoke it at `login.bactrack.com` first? simpler: wait — access lifetime unknown; just run import, then manually expire by logging out everywhere in the official app, then run import again and watch for transparent refresh).
3. Pass = second import succeeds without re-login.

## Probe 3 — shape reconfirm + first real import

1. `GET /imports/consumer/status` → `lastRun: null` initially.
2. `POST /imports/consumer/run` → note `{imported, skipped, total}`.
3. Verify in DB: `SELECT origin, COUNT(*) FROM bac_readings WHERE subject_user_id='<you>' GROUP BY 1` → `consumer_import` rows present, `raw_payload` holds full provider objects, `session_id IS NULL`.
4. Rerun → `{imported: 0, skipped: N}` (dedupe by provider id).
5. `DELETE /auth/bactrack` → ciphertext nulled; import after → 422.

## Recording results

Append outcomes (pass/fail + exact provider error strings, NO tokens) to
`docs/superpowers/specs/2026-09-03-bactrack-capture-design.md` section 8.
