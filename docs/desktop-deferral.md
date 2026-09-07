# P11 Desktop Shell — Deferred (decision record)

Date: 2026-09-04. Status: intentionally NOT built.

## Rationale

PLAN.md scopes desktop as "only when a real operator need appears". No
such need has appeared:

- All operator workflows (history, detail+ack, devices, teams, audit,
  map+Dawarich, kiosk, exports) run in `apps/web` today, verified by
  build + 6/6 Playwright + live UI tour.
- Kiosk mode (`/kiosk`) already covers the supervised-station use case
  a desktop shell would serve, with zero install footprint.
- Native mobile shells (the actual capture devices) don't exist yet —
  desktop before mobile inverts the dependency order for zero gain.

## Trigger conditions (revisit when ANY is true)

1. An operator must run capture supervision offline on a PC without a
   browser (kiosk page needs connectivity today).
2. USB-serial breathalyzers enter scope (browsers can't do USB-serial
   reliably; Tauri can).
3. App-store presence demanded on desktop OSes.

## Shape when triggered

Tauri 2 + existing `apps/web` output (`output: export` static build)
wrapped in a kiosk-locked window; API base configurable at runtime via
a settings file (no rebuild); auto-update via Tauri updater against
the home-lab host. Estimated effort: 1–2 days given the web app needs
no changes (only `next.config.ts` `output` + static-export audit of
dynamic routes).
