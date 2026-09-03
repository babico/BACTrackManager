# Exports, Push & Kiosk Implementation Plan (P9)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teams export history (CSV + PDF), get Web Push on new readings, and run a supervised kiosk flow — all tested, no placeholders.

**Architecture:** Export endpoints stream org-scoped readings (same filters as list) in CSV (hand-rolled, quoted) and PDF (pdfkit table). Every export writes `export.created` audit. Push: `push_subscriptions` per user; `PushService` with injectable transport (default `web-push` w/ VAPID, skipped cleanly when keys absent); `SessionsService.complete` fans out best-effort to org owners/admins (never fails the request). Kiosk web page: PIN-gated (env `KIOSK_PIN`, dev default `1234` — documented insecure-default), device+subject pick, session create, live status via existing SSE endpoint, hand-off note for the blow step (mobile UI arrives with native shells).

**Tech Stack:** Existing + `pdfkit@^0.17` (+ `@types/pdfkit` dev) + `web-push@^3.6` (+ `@types/web-push` dev). VAPID keys in local `.env`, placeholders in example.

**Plan split:** P9 of the phase plan. P10+ untouched.

---

## File structure

| Path | Responsibility |
|---|---|
| `packages/db/migrations/0008_push.sql` | `push_subscriptions` table |
| `packages/db/src/schema.ts` | + `pushSubscriptions` |
| `packages/db/scripts/verify.ts` | + table check |
| `apps/api/src/exports/exports.service.ts` | CSV builder, PDF builder (pdfkit), audit |
| `apps/api/src/exports/exports.controller.ts` | `GET /exports/readings.csv`, `GET /exports/readings.pdf` |
| `apps/api/src/push/push.service.ts` | Subscription CRUD + fan-out with transport injection |
| `apps/api/src/push/push.controller.ts` | `POST/GET/DELETE /push/subscriptions` |
| `apps/api/test/exports.spec.ts` | CSV/PDF content + audit row |
| `apps/api/test/push.spec.ts` | Sub CRUD + fan-out payload via fake transport |
| `apps/web/src/app/kiosk/page.tsx` | PIN gate + session starter + SSE status |
| `apps/web/src/app/teams/page.tsx` | + subscribe-to-push button |
| `apps/web/public/sw.js` | Push event → notification |
| `apps/web/MANUAL_CHECKLIST.md` | + kiosk + push items |

Endpoint summary:

- `GET /exports/readings.csv?subjectUserId&from&to&limit` → `text/csv` attachment `readings.csv`
- `GET /exports/readings.pdf?...` → `application/pdf` attachment `readings.pdf`
- `POST /push/subscriptions` `{endpoint, keys:{p256dh,auth}}` → 201 (upsert by endpoint)
- `GET /push/subscriptions` → 200 list (no key material? keys needed by sender server-side only — return endpoint + created, NOT keys)
- `DELETE /push/subscriptions` `{endpoint}` → 200
- Kiosk reuses existing session/complete/readings routes (no new backend).

CSV columns: `id,measured_at,bac_promille,subject_email,operator_email,device_serial,origin,acknowledged_at`. Resolved via members map (same join as orgs.members).

PDF: title, generated-at, org name, one row per reading (date, bac, subject, device, origin). pdfkit `bufferPages` → Buffer.concat.

Fan-out rule: on `complete`, notify all org owners/admins EXCEPT the operator (they were present), payload `{title:"New reading", body:"<subject> tested <bac> ‰", readingId}`. Transport default: `web-push` with VAPID (`VAPID_PUBLIC/PRIVATE/SUBJECT` env; absent → log + skip). Constructor accepts `transport` override for tests.

---

### Task 1: Migration + exports (TDD)

- [ ] Schema + `0008_push.sql` (push_subscriptions: id, user_id FK cascade, endpoint text unique, keys jsonb default {}, created_at).
- [ ] verify.ts table check. Migrate + verify.
- [ ] `exports.service.ts`: `readingsCsv(orgId, filters)` + `readingsPdf(orgId, filters)` + shared `fetchRows` (same conds as readings list + members email map). CSV quoting: wrap every field in `"`, double internal quotes.
- [ ] Controller with `Content-Type` + `Content-Disposition: attachment; filename=...`, audit `export.created` with `{format, count}`.
- [ ] Tests: seed 2 readings via HTTP (device/session/complete), GET csv → parse lines, assert header + 2 rows + origin present; GET pdf → `%PDF` magic + length; audit has export.created.
- [ ] Build + tests + commit `feat(api): CSV and PDF exports`.

### Task 2: Push (TDD)

- [ ] `push.service.ts` with `Transport = (sub: {endpoint:string;keys:unknown}, payload: string) => Promise<void>` ctor param defaulting to web-push sender (lazy import to keep boot light? direct import fine).
- [ ] Controller CRUD (upsert on conflict endpoint → update keys/user).
- [ ] Hook into `SessionsService.complete`: after tx, call `push.notifyReading({orgId, operatorId, subjectId, subjectEmail?, bac, readingId})` wrapped in try/catch (never throw). Needs PushService import → circular? SessionsService ← PushService needs nothing from sessions; complete calls push AFTER tx via injected optional? Inject PushService into SessionsService (providers both in module — fine, no cycle: push doesn't import sessions).
- [ ] Tests: sub CRUD; fake transport captures payload on independently-triggered notify (call service method directly with fixture ids — needs a real reading: create via HTTP first, then call `push.notifyReading` directly and assert transport got readingId + subject email).
- [ ] VAPID keys: generate (`web-push generate-vapid-keys`) into local `.env` (VAPID_PUBLIC/PRIVATE/SUBJECT=mailto:admin@example.com), example placeholders.
- [ ] Commit `feat(api): push subscriptions and reading fan-out`.

### Task 3: Kiosk + subscribe UI + close-out

- [ ] `kiosk/page.tsx`: PIN input ( wobec `KIOSK_PIN`? PIN checked client-side against NEXT_PUBLIC_KIOSK_PIN default "1234" — documented demo-grade); after unlock: device select (GET /devices), subject select (GET /orgs/members), start button (POST /sessions with fresh clientSessionId), status panel polling `GET /sessions/:id` every 2s + link to reading when completed. No BAC entry UI by design (integrity).
- [ ] Teams page: "Enable push notifications" button → `Notification.requestPermission()` → `registration.pushManager.subscribe({userVisibleOnly:true, applicationServerKey})` → POST /push/subscriptions. `public/sw.js`: push → `showNotification(title, {body})`.
- [ ] MANUAL_CHECKLIST += kiosk + push items. `next build` green.
- [ ] Full `pnpm build && pnpm lint && pnpm test`, commit, report.

---

## Self-review

**Spec coverage:** PLAN.md P9: CSV ✓, PDF ✓, push (subscribe + deliver + fan-out) ✓, kiosk (supervised starter, no manual BAC entry — integrity preserved) ✓. Native mobile push (FCM/APNs) out of scope until native shells exist (stated, not a gap).
**Placeholder scan:** Exact code/commands. VAPID absent → skip-with-log (explicit degraded mode, not silent TODO).
**Type consistency:** Export filters mirror list filters; audit action `export.created`; push payload shape `{title,body,readingId}` shared by service test and sw.js.
