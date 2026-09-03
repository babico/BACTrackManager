# Hybrid Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Users log in via BACtrack PKCE (primary) or magic link (fallback); our API issues its own short-lived JWT + rotating opaque refresh; all capture endpoints move off the dev guard onto real JWT auth.

**Architecture:** New `auth` module: `AuthService` (identity linking, pair minting, refresh rotation with reuse-kill, magic flow, BACtrack PKCE exchange via `fetch`), `JwtAuthGuard` (Bearer verify, attaches `{userId}`), `AuthController` (public routes). Membership/org checks stay as-is (`assertMembership` per controller, now with real user). BACtrack user tokens are AES-256-GCM envelope-encrypted at rest. PKCE `state` uses an in-memory pending store (single-instance MVP; Redis noted for later).

**Tech Stack:** Existing + `jsonwebtoken@^9` (+ `@types/jsonwebtoken` dev). No other new deps. `node:crypto` for opaque tokens, hashing, AES-GCM.

**Plan split:** Plan 3 of 6. Plans 1-2 merged. Plan 4 (consumer import) consumes the stored BACtrack tokens. Live BACtrack login verification is user-run (section "Open live probes"); everything else is tested here with mocked `fetch`.

**Captured provider facts (from HAR, authoritative):** Auth0 tenant `https://login.bactrack.com`; `client_id` + `audience=https://api.bactrack.com` live in local `.env` (first-party app config, never committed); authorize scope `openid profile email read:users offline_access`; `code_challenge_method=S256`; token response `{access_token (JWT), refresh_token (opaque 45), id_token, scope, expires_in, token_type}`; logout revokes via `POST /oauth/revoke {token, client_id}`. Public docs still say OAuth 1.0 — outdated, ignore.

**Open live probes (user-run, throwaway account only, NOT in this plan's tests):**
1. Loopback `redirect_uri=http://127.0.0.1:PORT/callback` acceptance at `/authorize` (Auth0 native apps usually allow unlisted loopback).
2. Refresh grant `grant_type=refresh_token` acceptance at `/oauth/token`.
3. `GET /api/v1/users/me` shape re-verified with fresh token (already captured, confirm stable).
Until probes pass, BACtrack routes are implemented + mocked-tested but flagged experimental in code comments.

---

## File structure (this plan)

| Path | Responsibility |
|---|---|
| `packages/db/migrations/0003_auth.sql` | `refresh_tokens` table + `bactrack_identities.encrypted_access` |
| `packages/db/src/schema.ts` | + `refreshTokens` table, + `encryptedAccess` column |
| `packages/db/scripts/verify.ts` | + `refresh_tokens` table check |
| `apps/api/src/config.ts` | + `JWT_SECRET`, `TOKEN_ENC_KEY`, `BACTRACK_*`, `ALLOW_DEV_MAGIC_TOKEN` |
| `apps/api/src/auth/crypto.ts` | AES-256-GCM seal/open for token storage |
| `apps/api/src/auth/tokens.ts` | Opaque token gen + sha256 hash helpers |
| `apps/api/src/auth/auth.service.ts` | register-or-login, mintPair, refresh, logout, magic, bactrack |
| `apps/api/src/auth/jwt-auth.guard.ts` | Bearer verify → `{userId}` (+ membership still per-controller) |
| `apps/api/src/auth/auth.controller.ts` | Public auth routes |
| `apps/api/test/auth.e2e.spec.ts` | Full auth matrix (real flows, mocked provider fetch) |
| `apps/api/test/capture.e2e.spec.ts` | Switched to `Authorization: Bearer` via container-minted tokens |
| `.env` (local, gitignored) | Real dev values incl. generated secrets + provider config |
| `.env.example` | Placeholders for every new variable |

Endpoint summary (`/auth/*` public; everything else Bearer):

- `POST /auth/magic/start` `{email}` → 200 `{sent:true}` (+ `devToken` only when `ALLOW_DEV_MAGIC_TOKEN=true`)
- `GET /auth/magic/consume?token=` → 200 `{accessToken, refreshToken, user}` (single-use, 15min)
- `POST /auth/bactrack/start` → 200 `{url, state}` (PKCE challenge generated server-side, verifier kept in pending store 10min)
- `GET /auth/bactrack/callback?code&state` → 200 `{accessToken, refreshToken, user}` (exchange + link + mint)
- `POST /auth/refresh` `{refreshToken}` → 200 new pair (rotation; reuse kills family + 401)
- `POST /auth/logout` `{refreshToken}` → 200 (revokes ours; best-effort provider revoke if linked)
- `GET /auth/me` (Bearer) → 200 `{user, organizations:[{id,name,type,role}], bactrackLinked}`

---

### Task 1: Migration 0003 + local env

**Files:**
- Modify: `packages/db/src/schema.ts`, `packages/db/scripts/verify.ts`
- Create: `packages/db/migrations/0003_auth.sql`, `.env` (local only)
- Modify: `.env.example`

- [ ] **Step 1: Append to `packages/db/src/schema.ts`**

```ts
export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    replacedBy: uuid("replaced_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ix_refresh_user").on(t.userId)],
);
```

And add column to `bactrackIdentities`: `encryptedAccess: text("encrypted_access"),` next to `encryptedRefresh`.

- [ ] **Step 2: Create `packages/db/migrations/0003_auth.sql`**

```sql
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  replaced_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_refresh_user ON refresh_tokens (user_id);
ALTER TABLE bactrack_identities ADD COLUMN IF NOT EXISTS encrypted_access text;
```

- [ ] **Step 3: Extend `verify.ts`** — add `"refresh_tokens"` to `expectedTables`.

- [ ] **Step 4: Create local `.env`** (gitignored — verify with `git check-ignore .env` first). Generate secrets WITHOUT printing:

Run: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` → use first 64 chars as JWT_SECRET.
Run again → first 64 chars as TOKEN_ENC_KEY (32 bytes hex).
`.env` content (DATABASE_URL stays the dev value; BACTRACK_CLIENT_ID/BACTRACK_AUDIENCE copied from the approved capture — first-party app config, local only):

```
NODE_ENV=development
DATABASE_URL=postgres://bactrackmanager:123456789bA+bactrackmanager@192.168.21.2:5432/bactrackmanager
API_VERSION=0.1.0
JWT_SECRET=<64-hex-from-step>
TOKEN_ENC_KEY=<64-hex-from-step>
BACTRACK_DOMAIN=https://login.bactrack.com
BACTRACK_CLIENT_ID=<from capture>
BACTRACK_AUDIENCE=https://api.bactrack.com
BACTRACK_API=https://consumer-api.bactrack.com
ALLOW_DEV_MAGIC_TOKEN=true
```

- [ ] **Step 5: Extend `.env.example`** with same keys, placeholder values (`change-me...`, `your-client-id`).

- [ ] **Step 6: Migrate + verify**

Run with `$env:DATABASE_URL` set: `pnpm --filter @bactrack/db db:migrate` (expect `applying 0003_auth.sql`, `applied 1`), then `db:verify` (expect `PASS table refresh_tokens` + `ALL CHECKS PASSED`).

- [ ] **Step 7: Commit**

Run: `git add packages/db .env.example && git commit -m "feat(db): refresh tokens table and provider access storage" && git status --short`
Expected: clean (`.env` must NOT appear — ignored).

---

### Task 2: Config + crypto + token helpers (TDD)

**Files:**
- Modify: `apps/api/src/config.ts`, `apps/api/package.json` (+ jsonwebtoken, @types)
- Create: `apps/api/src/auth/crypto.ts`, `apps/api/src/auth/tokens.ts`
- Test: `apps/api/test/crypto.spec.ts` (pure unit, no DB)

- [ ] **Step 1: Add deps**

Run: `pnpm --filter @bactrack/api add jsonwebtoken@^9.0.2 && pnpm --filter @bactrack/api add -D @types/jsonwebtoken@^9.0.7`
Expected: installed, lockfile updated.

- [ ] **Step 2: Extend `config.ts`** — add:

```ts
JWT_SECRET: z.string().min(32),
TOKEN_ENC_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/),
BACTRACK_DOMAIN: z.string().url().default("https://login.bactrack.com"),
BACTRACK_CLIENT_ID: z.string().min(1).optional(),
BACTRACK_AUDIENCE: z.string().default("https://api.bactrack.com"),
BACTRACK_API: z.string().url().default("https://consumer-api.bactrack.com"),
ALLOW_DEV_MAGIC_TOKEN: z.coerce.boolean().default(false),
```

- [ ] **Step 3: Write failing unit test first** — `apps/api/test/crypto.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import { seal, open } from "../src/auth/crypto.js";

describe("token encryption", () => {
  it("round-trips arbitrary token strings", () => {
    const key = "ab".repeat(32);
    const sealed = seal(key, "opaque-refresh-token-123");
    expect(sealed).not.toContain("opaque-refresh-token-123");
    expect(open(key, sealed)).toBe("opaque-refresh-token-123");
  });

  it("rejects wrong key", () => {
    const sealed = seal("ab".repeat(32), "x");
    expect(() => open("cd".repeat(32), sealed)).toThrow();
  });
});
```

Run: `pnpm --filter @bactrack/api test` — FAIL (no crypto.ts). Correct red.

- [ ] **Step 4: Create `apps/api/src/auth/crypto.ts`**

```ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export function seal(keyHex: string, plaintext: string): string {
  const key = Buffer.from(keyHex, "hex");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64");
}

export function open(keyHex: string, sealed: string): string {
  const key = Buffer.from(keyHex, "hex");
  const raw = Buffer.from(sealed, "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
```

- [ ] **Step 5: Create `apps/api/src/auth/tokens.ts`**

```ts
import { createHash, randomBytes } from "node:crypto";

export function newOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString("hex");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
```

- [ ] **Step 6: Green + commit**

Run: `pnpm --filter @bactrack/api build` (green), then full `pnpm --filter @bactrack/api test` with dev env (green).
Run: `git add apps/api pnpm-lock.yaml .env.example; git commit -m "feat(api): config, token crypto and helpers"; git status --short`
Expected: clean.

---

### Task 3: AuthService + guard (core)

**Files:**
- Create: `apps/api/src/auth/auth.service.ts`, `apps/api/src/auth/jwt-auth.guard.ts`, `apps/api/src/auth/auth.controller.ts`
- Modify: `apps/api/src/app.module.ts`

Service contract (implement exactly):

```ts
import { ConflictException, Injectable, UnauthorizedException, UnprocessableEntityException } from "@nestjs/common";
import * as jwt from "jsonwebtoken";
import { and, bactrackIdentities, eq, getDb, magicLinks, organizationMemberships, organizations, refreshTokens, users } from "@bactrack/db";
import { hashToken, newOpaqueToken } from "./tokens.js";
import { open, seal } from "./crypto.js";

const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_MS = 30 * 24 * 3600 * 1000;
const MAGIC_TTL_MS = 15 * 60 * 1000;
const PKCE_TTL_MS = 10 * 60 * 1000;

export interface AuthPair { accessToken: string; refreshToken: string; }
export interface PublicUser { id: string; email: string; displayName: string; }

function jwtSecret(): string {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET is required");
  return s;
}

function encKey(): string {
  const k = process.env.TOKEN_ENC_KEY;
  if (!k) throw new Error("TOKEN_ENC_KEY is required");
  return k;
}

function codeVerifier(): string {
  return newOpaqueToken(32).replace(/[^A-Za-z0-9]/g, "x").slice(0, 43);
}
```

Hmm — `newOpaqueToken` returns hex (already [0-9a-f], 64 chars). PKCE verifier needs 43-128 chars from unreserved set; hex qualifies. Simplify: verifier = `newOpaqueToken(32)` (64 hex chars, valid). Challenge = base64url(sha256(verifier)):

```ts
import { createHash } from "node:crypto";
function codeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}
```

Pending PKCE store (module-level):

```ts
const pendingPkce = new Map<string, { verifier: string; redirectUri: string; expires: number }>();
```

Methods (implement each exactly as specified):

1. `async registerOrLogin(input: { email: string; displayName: string }): Promise<{ user: PublicUser; created: boolean }>` — transaction: find user by email; if missing, insert user + personal org (`type: "personal"`, name = `${displayName}`) + owner membership; return row + created flag.

2. `mintPair(userId: string): Promise<AuthPair>` — access = `jwt.sign({ sub: userId }, jwtSecret(), { expiresIn: ACCESS_TTL_SECONDS })`; refresh opaque; insert refresh_tokens (hash, 30d expiry); return both. NOTE jsonwebtoken import: `import * as jwt from "jsonwebtoken"` then `jwt.sign` — with esModuleInterop use `import jwt from "jsonwebtoken"`. Use default import.

3. `verifyAccess(token: string): { sub: string }` — `jwt.verify(token, jwtSecret())` cast; throws UnauthorizedException on any error.

4. `async refresh(presented: string): Promise<AuthPair>` — hash lookup; missing → 401; revoked or expired → 401; else transaction: mark revoked + replaced_by new row id, insert new row, return mintPair-equivalent for same user. Reuse detection: if row.revokedAt already set when presented → family kill: revoke ALL user refresh rows, throw UnauthorizedException("refresh token reuse detected").

5. `async logout(presented: string): Promise<{ revoked: boolean }>` — mark row revoked if found (always 200). Best-effort provider revoke: for each bactrack identity of user with encrypted_refresh: open, POST `${BACTRACK_DOMAIN}/oauth/revoke {token, client_id}` with 5s timeout, ignore errors.

6. `async magicStart(email: string): Promise<{ sent: boolean; devToken?: string }>` — normalize lowercase trim, zod email check in controller; ensure user exists via registerOrLogin(displayName = email prefix); token opaque, store sha256 hash 15min; "send" = console mailer (log masked address) — implement `sendMagicLink(email, token)` that logs `magic link for <masked> ready` and, if `ALLOW_DEV_MAGIC_TOKEN=true`, returns token in response. Always return `{sent:true}` (no account enumeration).

7. `async magicConsume(token: string): Promise<{ pair: AuthPair; user: PublicUser }>` — hash lookup join user; missing/expired/consumed → 401; transaction: mark consumed, mintPair; return.

8. `bactrackStart(redirectUri: string): { url: string; state: string }` — requires BACTRACK_CLIENT_ID else UnprocessableEntityException("bactrack login not configured"); verifier 64hex; state opaque 16B hex; store pending 10min; url = `${DOMAIN}/authorize?response_type=code&client_id=...&code_challenge=${challenge}&code_challenge_method=S256&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent("openid profile email read:users offline_access")}&audience=${encodeURIComponent(AUDIENCE)}&state=${state}`.

9. `async bactrackCallback(code: string, state: string, redirectUri: string): Promise<{ pair: AuthPair; user: PublicUser }>` — pending lookup + expiry (delete always); exchange: POST `${DOMAIN}/oauth/token {grant_type:"authorization_code", code, client_id, code_verifier: verifier, redirect_uri}`; non-200 → UnauthorizedException("bactrack exchange failed"); parse `{access_token, refresh_token?, expires_in?}`; fetch `${API}/api/v1/users/me` Bearer → `{id, email, firstName?, lastName?}`; find-or-create: identity by providerUserId → user; else user by email → link; else registerOrLogin(displayName = first+last or email prefix); upsert identity (providerUserId unique → onConflictDoUpdate setting encrypted tokens + providerOrganizationId null); mintPair. Wrap provider HTTP in try/catch → UnauthorizedException on any failure. Fetch timeout: AbortSignal.timeout(8000).

10. `async providerRefresh(userId: string): Promise<string | null>` — helper for plan 4: open stored refresh, POST grant_type=refresh_token, rotate stored access (/refresh if rotated), return fresh access or null on failure. (Tested with mocked fetch; live probe later.)

11. `async me(userId: string)` — user row + memberships join organizations + bactrackLinked bool.

12. `async unlinkProvider(userId: string): Promise<{ unlinked: boolean }>` — best-effort provider `/oauth/revoke` with stored refresh, then NULL both ciphertext columns (disconnect wipes secrets, keeps history).

Guard `jwt-auth.guard.ts`:

```ts
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { AuthService } from "./auth.service.js";

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}
```

No — guard needs no DI if verifyAccess is static-ish. Make `verifyAccess` a free function in auth.service.ts exports and guard calls it directly (no DI → no metadata issues):

```ts
export function verifyAccess(token: string): { sub: string } {
  try {
    const payload = jwt.verify(token, jwtSecret()) as { sub?: unknown };
    if (typeof payload.sub !== "string") throw new Error("no sub");
    return { sub: payload.sub };
  } catch {
    throw new UnauthorizedException("invalid or expired token");
  }
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const header: unknown = req.headers?.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) {
      throw new UnauthorizedException("missing bearer token");
    }
    const { sub } = verifyAccess(header.slice(7));
    req.user = { userId: sub };
    return true;
  }
}
```

Note: guard attaches `{userId}` only; controllers combine with membership org scoping. Controllers currently use `ctx.organizationId` from dev guard. Plan 3 changes `OrgContext` usage: organization comes from query/body? Design decision (simplest, explicit): each org-scoped route takes org from... hmm. Cleanest minimal churn: `GET /auth/me` returns orgs; clients send `x-org-id` header? Or derive single-org MVP?

Decision: MVP single-active-org via `x-org-id` header required on org routes: new `OrgGuard`? Simpler: extend JwtAuthGuard to also read `x-org-id`, assertMembership inside guard, attach `{userId, organizationId}` (same OrgContext shape — zero controller churn except swapping guard class + removing DEV env). Missing/invalid header → 401/403. Do that: guard does membership check via assertMembership (already exists). This kills two birds: auth + org binding. Document: multi-org switching = changing header; plan 5 web stores active org.

Controller `auth.controller.ts` (public, no guard):

```ts
import { Body, Controller, Get, Inject, Post, Query, Req, UseGuards } from "@nestjs/common";
```

Wait — @UseGuards(JwtAuthGuard) needs the class only (no DI in guard → fine).

```ts
const emailSchema = z.object({ email: z.string().email().max(320) });

@Controller("auth")
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Post("magic/start")
  @HttpCode(200)
  async magicStart(@Body() body: unknown) {
    const dto = parseBody(emailSchema, body);
    return this.auth.magicStart(dto.email);
  }

  @Get("magic/consume")
  async magicConsume(@Query("token") token: string) {
    if (!token) throw new BadRequestException("token is required");
    const { pair, user } = await this.auth.magicConsume(token);
    return { ...pair, user };
  }

  @Post("bactrack/start")
  @HttpCode(200)
  async bactrackStart(@Body() body: unknown) {
    const dto = parseBody(z.object({ redirectUri: z.string().url().max(500) }), body);
    return this.auth.bactrackStart(dto.redirectUri);
  }

  @Get("bactrack/callback")
  async bactrackCallback(@Query("code") code: string, @Query("state") state: string, @Query("redirect_uri") redirectUri: string) {
    if (!code || !state || !redirectUri) throw new BadRequestException("code, state and redirect_uri are required");
    const { pair, user } = await this.auth.bactrackCallback(code, state, redirectUri);
    return { ...pair, user };
  }

  @Post("refresh")
  @HttpCode(200)
  async refresh(@Body() body: unknown) {
    const dto = parseBody(z.object({ refreshToken: z.string().min(10) }), body);
    const pair = await this.auth.refresh(dto.refreshToken);
    return pair;
  }

  @Post("logout")
  @HttpCode(200)
  async logout(@Body() body: unknown) {
    const dto = parseBody(z.object({ refreshToken: z.string().min(10) }), body);
    return this.auth.logout(dto.refreshToken);
  }

  @Get("me")
  @UseGuards(JwtAuthGuard)
  async me(@CurrentUser() ctx: { userId: string }) {
    return this.auth.me(ctx.userId);
  }

  @Delete("bactrack")
  @UseGuards(JwtAuthGuard)
  async unlink(@CurrentUser() ctx: { userId: string }) {
    return this.auth.unlinkProvider(ctx.userId);
  }
}
```

`@CurrentUser()` returns full OrgContext but me only needs userId — guard always attaches both; type as OrgContext and use ctx.userId. Fine.

Register AuthController + AuthService in app.module. Replace DevIdentityGuard with JwtAuthGuard in devices/sessions/readings/audit controllers (import swap only — same decorator usage). DELETE `dev-identity.guard.ts`. Update plan-2 note: OrgContext now always has organizationId from x-org-id.

- [ ] Steps: write service, guard, controller; wire module; swap guards; delete dev guard; build green.

---

### Task 4: Test rewrite + matrix (TDD)

**Files:**
- Create: `apps/api/test/auth.e2e.spec.ts`
- Modify: `apps/api/test/capture.e2e.spec.ts` (auth headers), `apps/api/test/bootstrap.ts` (same)

Helper in each spec needing auth:

```ts
async function authHeaders(): Promise<Record<string, string>> {
  const svc: AuthService = app.get(AuthService);
  const { pair } = ... mint for operatorId
}
```

Concretely in capture spec beforeAll after creating operator: `const svc = app.get(AuthService); const minted = await svc.mintPair(operatorId); authHeader = { Authorization: `Bearer ${minted.accessToken}` };` and `const api = () => request(app.getHttpServer()).set(authHeader)` — supertest `.set` on the request factory: `request(app.getHttpServer()).get(...)` — need per-request set. Change helper to accept method+path? Simplest: keep `api()` returning `request(app.getHttpServer())` and add `.set("Authorization", bearer)` in each call... many edits. Alternative: supertest agent with default headers: `const agent = request.agent(app.getHttpServer())` doesn't do default headers either. Use a tiny wrapper:

```ts
const api = () => ({
  get: (p: string) => request(app.getHttpServer()).get(p).set("Authorization", bearer),
  post: (p: string) => request(app.getHttpServer()).post(p).set("Authorization", bearer),
  patch: (p: string) => request(app.getHttpServer()).patch(p).set("Authorization", bearer),
});
```

And org header: guard reads `x-org-id` → `.set("x-org-id", orgId)` too. Update all existing calls (they use .get/.post/.patch — wrapper covers).

`auth.e2e.spec.ts` matrix:
1. magic start → consume → me (devToken from response since ALLOW_DEV_MAGIC_TOKEN=true in test env).
2. magic consume twice → second 401.
3. refresh rotation → new pair works, old refresh 401.
4. refresh reuse detection → use rotated-out token again → 401 + family killed (fresh pair's refresh also 401).
5. logout → refresh 401 after.
6. no token → 401 on /devices; bad token → 401; missing x-org-id → 401; foreign org id → 403.
7. bactrack start → url contains authorize + code_challenge + state; callback with mocked fetch (vi.stubGlobal("fetch", ...) returning token JSON then users/me JSON) → 200 pair + me shows bactrackLinked true; bad state → 401/400.
8. expired magic token → 401 (insert expired row directly? manipulate via db update expires_at past — do with drizzle in test).

Mock fetch shape: `vi.stubGlobal("fetch", vi.fn(async (url) => { ... return { ok: true, status: 200, json: async () => ({...}) } as Response }))`. Route by URL string contains "oauth/token" vs "users/me". Unstub after.

- [ ] Steps: rewrite capture helper + headers; write auth spec; run full suite green (expect 3 health + 10 capture + ~10 auth).

---

### Task 5: Close-out

- [ ] Run `pnpm build && pnpm lint`, full tests.
- [ ] Commit `feat(api): hybrid auth with BACtrack PKCE and magic link`.
- [ ] Update design doc section 10 → implemented (one-line status edit + commit) — do as part of same commit? Separate docs commit. Keep: include in same commit, note in message.

---

## Self-review

**Spec coverage:** Design section 10 (hybrid) implemented: PKCE primary (start/callback/refresh/revoke wired, mocked-tested, live-flagged), magic fallback (real, tested), own JWT + rotation (tested incl. reuse-kill), no local passwords anywhere, identity table multi-provider (bactrack_identities + email users coexist), disconnect wipes ciphertext (logout revokes ours + best-effort provider revoke; add explicit `DELETE /auth/bactrack` unlink that nulls ciphertext? — include: `DELETE /auth/bactrack` (Bearer) clears encrypted_access/refresh for user. Add to controller + test. Yes, spec demands disconnect wipes.)
**Placeholder scan:** No TBD; exact code/commands/outputs. jsonwebtoken versions pinned.
**Type consistency:** OrgContext unchanged `{userId, organizationId}`; guard attaches both (org from x-org-id + membership assert). `verifyAccess` free function reused by guard. Controller swap is import-class-only. AuthService methods return `{pair, user}` uniformly.
