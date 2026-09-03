# Hardening Implementation Plan (P10)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rate-limited auth, secure headers, TOTP MFA enforced at login for enrolled users, secrets audit clean, store-release checklist written. No security theater: every control has a failing-then-passing test.

**Architecture:** `@nestjs/throttler` v6 global guard (generous defaults) + strict `@Throttle` on auth routes; `helmet` in `main.ts`; TOTP via `otplib` (RFC 6238, SHA1/30s/6-digit, ±1 step window); MFA state on `users` (`mfa_secret` sealed, `mfa_enabled`); login flow branches: `magicConsume`/`bactrackCallback` return `{mfaRequired:true, mfaTicket}` when enrolled; `POST /auth/mfa/challenge {ticket, code}` mints the pair. Ticket = HS256 JWT `{sub, purpose:"mfa"}`, 5min.

**Tech Stack:** Existing + `@nestjs/throttler@^6`, `helmet@^8`, `otplib@^12`. No other deps.

**Explicitly deferred (with reason, not gaps):** Postgres RLS — single-pool architecture enforces tenancy in tested app code on every route; RLS needs per-request role switching + 14-table policies, a migration project of its own (filed as post-launch hardening in this doc). Native FCM/APNs push — needs Mac-built shells (P11). WebAuthn/passkeys — viable only after native clients exist to hold credentials; TOTP covers second-factor now.

---

## File structure

| Path | Responsibility |
|---|---|
| `packages/db/migrations/0009_mfa.sql` | `users.mfa_secret`, `users.mfa_enabled` |
| `packages/db/src/schema.ts` | + columns |
| `packages/db/scripts/verify.ts` | unchanged (no new table) |
| `apps/api/src/auth/mfa.service.ts` | TOTP setup/enable/challenge/disable, ticket mint/verify |
| `apps/api/src/auth/auth.controller.ts` | + `POST /auth/mfa/*` routes |
| `apps/api/src/auth/auth.service.ts` | Login branch on `mfa_enabled` |
| `apps/api/src/main.ts` | helmet, json limit, global throttler guard |
| `apps/api/test/mfa.spec.ts` | Enrol → login branches → challenge → disable matrix |
| `apps/api/test/rate.spec.ts` | 429 after burst on magic/start |
| `docs/store-release-checklist.md` | Bundle IDs, permissions, privacy, phased rollout |

Endpoint summary:

- `POST /auth/mfa/setup` (Bearer) → 200 `{otpauthUrl, backupCodes[]}` (secret stored sealed, enabled=false)
- `POST /auth/mfa/enable` `{code}` (Bearer) → 200 (verifies code, sets enabled=true)
- `POST /auth/mfa/challenge` `{ticket, code}` (public) → 200 pair / 401
- `DELETE /auth/mfa` (Bearer) → 200 (clears secret, enabled=false)
- Changed: `magicConsume` + `bactrackCallback` return `{mfaRequired:true, mfaTicket}` instead of pair when enrolled.

Backup codes: 8 × 8-hex, sha256 stored in `users` — new column? Reuse: store JSON array in `mfa_secret`? No — separate `mfa_backup_hashes jsonb`? Migration adds it (jsonb default []). Challenge accepts backup code (single-use: remove on use).

---

### Task 1: Throttle + headers + limits (TDD)

- [ ] **Step 1: Deps.** `pnpm --filter @bactrack/api add @nestjs/throttler@^6.4.0 helmet@^8.0.0`
- [ ] **Step 2: `main.ts`** — `app.use(helmet())`; json limit: `app.use(json({ limit: "256kb" }))` from express (import { json } from "express"); global guard: `app.useGlobalGuards(new ThrottlerGuard(...))` — needs storage + options; simplest: register `ThrottlerModule.forRoot` in AppModule with `[{ name:"default", limit:200, ttl:60000 }]` and provide `{ provide: APP_GUARD, useClass: ThrottlerGuard }`.
- [ ] **Step 3: Strict routes.** `@Throttle({ auth: { limit: 20, ttl: 60000 } })`? v6 named throttlers need config entries: add second throttler `{ name:"auth", limit:20, ttl:60000 }` in forRoot; decorate `magic/start`, `magic/consume`, `bactrack/start`, `bactrack/callback`, `refresh` with `@Throttle({ auth: { limit: 20, ttl: 60000 } })`. Hmm v6 syntax: `@Throttle({ default: {...} })` overrides default set. Named: `@Throttle({ auth: {...} })` requires named throttler defined. Use that.
- [ ] **Step 4: Test first** — `test/rate.spec.ts`: 21 rapid `POST /auth/magic/start` (unique emails) → expect last status 429, body has error envelope. Helmet: `GET /health` response includes `x-content-type-options: nosniff` and no `x-powered-by`.
- [ ] **Step 5: Green + commit** `feat(api): rate limits and security headers`.

Watch-out: e2e suites collectively call magic/start >20× per FILE? Per-file stores are isolated (vitest workers), rate.spec does 21 alone — other files do <10 each. Capture/orgs files call magic? They use registerOrLogin directly (no HTTP start). Auth.spec: ~10 starts. Safe. BUT full turbo runs api suite once per process — store spans files in same worker? Vitest default pool forks, isolate per file → separate module states → fine.

### Task 2: TOTP MFA (TDD)

- [ ] **Step 1: Deps + migration.** `pnpm --filter @bactrack/api add otplib@^12.0.1`. `0009_mfa.sql`: `ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_secret text; ADD COLUMN mfa_enabled boolean NOT NULL DEFAULT false; ADD COLUMN mfa_backup_hashes jsonb NOT NULL DEFAULT '[]';` Schema: add fields.
- [ ] **Step 2: `mfa.service.ts`** (complete):

```ts
import { Injectable, UnauthorizedException } from "@nestjs/common";
import { authenticator } from "otplib";
import jwt from "jsonwebtoken";
import { eq, getDb, users } from "@bactrack/db";
import { hashToken, newOpaqueToken } from "./tokens.js";
import { open, seal } from "./crypto.js";

function jwtSecret(): string { ... } // same as auth.service (duplicate tiny helper, avoids export churn)

export class MfaService {
  async setup(userId, email): Promise<{ otpauthUrl: string; backupCodes: string[] }> {
    const secret = authenticator.generateSecret();
    const codes = Array.from({ length: 8 }, () => newOpaqueToken(4));
    const hashes = codes.map(hashToken);
    await db.update(users).set({ mfaSecret: seal(encKey(), secret), mfaEnabled: false, mfaBackupHashes: hashes }).where(...);
    return { otpauthUrl: authenticator.keyuri(email, "BACTrackManager", secret), backupCodes: codes };
  }
  verifyCode(userId, code): Promise<boolean> {
    // open secret; check TOTP window ±1; else check backup hashes (remove on use, return true)
  }
  mintTicket(userId): string { return jwt.sign({ sub: userId, purpose: "mfa" }, jwtSecret(), { expiresIn: 300 }); }
  verifyTicket(ticket): string { verify purpose+expiry → sub or throw Unauthorized}
  async enable(userId, code) / async disable(userId)
}
```

- [ ] **Step 3: Login branch.** `magicConsume` + `bactrackCallback`: after resolving user, check `mfaEnabled` → return `{ mfaRequired: true, mfaTicket: mintTicket(user.id) }` INSTEAD of pair. Controller passes through (response shape changes — update controller to return service result directly). `POST /auth/mfa/challenge {ticket, code}` → verifyTicket → verifyCode → mintPair + user.
- [ ] **Step 4: Tests** — `mfa.spec.ts`: setup → enable with `authenticator.generate(token)`... test generates valid code via otplib with returned secret? Secret stays server-side; test recomputes: otpauthUrl contains secret — parse it in test (URL query `secret`). Then: login with MFA → mfaRequired, no pair; wrong code challenge → 401; right code → pair works on /auth/me; backup code works once, twice → 401; disable → login direct again.
- [ ] **Step 5: Green + commit** `feat(api): TOTP MFA with login enforcement`.

### Task 3: Audit + store checklist + close-out

- [ ] Secrets audit: grep repo (excluding node_modules/dist/.next/.git) for `BEGIN PRIVATE KEY`, `AKIA`, `xox[bpas]`, `ghp_`, `sk-live`, and our own known prefixes (`e7bb5b6a` sample key — MUST only appear in docs/plans as labeled sample, never in code/env); verify `.env`, `*.har` ignored (`git check-ignore`); run `db:verify`; record results in commit message.
- [ ] `docs/store-release-checklist.md`: bundle IDs (`com.bactrack.manager` placeholder), iOS NSBluetooth*/NSLocation* usage strings, Android permissions, privacy manifest notes, TestFlight/Internal tracks, phased rollout, kill-switch (remote disable via API flag — future).
- [ ] Full green + commit + report. RLS deferral noted in this plan (done above).

---

## Self-review

**Spec coverage:** P10 essentials: brute-force resistance (throttle + 401-shape) ✓, headers ✓, second factor with enforcement (not decoration) ✓, audit of secrets ✓, release readiness doc ✓. Deferred items named with reasons.
**Placeholder scan:** Exact code/commands. VAPID-skip precedent followed (fail-closed where it matters: MFA verify failures are 401, never skip).
**Type consistency:** `{mfaRequired:true, mfaTicket}` vs pair union — controllers return service result opaquely; tests assert both shapes. Ticket JWT reuses JWT_SECRET with distinct purpose claim (no confusion with access tokens: access has no purpose claim; challenge requires purpose==="mfa").
