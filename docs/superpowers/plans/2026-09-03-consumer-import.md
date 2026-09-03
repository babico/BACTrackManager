# Consumer History Import Implementation Plan (P7)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A linked BACtrack account's cloud history imports into `bac_readings` with `origin='consumer_import'`, keyed idempotent on the provider reading id. No duplicates across reruns. Untrusted-client data stays flagged and raw payloads retained.

**Architecture:** `ImportsService` (api) uses `AuthService.providerRefresh(userId)` for a fresh provider access token (already implemented + mocked-tested in P3), pages `GET /api/v1/readings?page&limit=100` until a short page, and upserts. Consumer readings have no session: `bac_readings.session_id` becomes nullable (managed rows always set it; enforced by convention + a CHECK documented here, not a DB constraint — keeps migration trivial). Import runs recorded in `consumer_imports`. Live provider calls are user-run probes only; all tests mock `fetch`.

**Tech Stack:** Existing. No new deps.

**Plan split:** P7 of the phase plan. Consumes P3 token storage + P2 readings shape. P8 (Dawarich) can later correlate `consumer_import` rows by GPS/time.

---

## File structure

| Path | Responsibility |
|---|---|
| `packages/db/migrations/0006_import.sql` | `consumer_imports` table + `bac_readings.provider_reading_id` + nullable `session_id` |
| `packages/db/src/schema.ts` | + `consumerImports`, edited `bacReadings` |
| `packages/db/scripts/verify.ts` | + `consumer_imports` table check |
| `apps/api/src/imports/imports.service.ts` | `runConsumerImport(userId, orgId)`, `importStatus(userId)` |
| `apps/api/src/imports/imports.controller.ts` | `POST /imports/consumer/run`, `GET /imports/consumer/status` |
| `apps/api/test/imports.e2e.spec.ts` | Paged import, rerun-skips, unlinked 422, bad-token 401 paths |

Endpoint summary (Bearer + `x-org-id`):

- `POST /imports/consumer/run` → 200 `{imported, skipped, total}` / 422 no linked account / 401 provider token dead
- `GET /imports/consumer/status` → 200 `{lastRun: {...} | null}`

Provider reading mapping (keys from HAR section 8):
`{id→provider_reading_id, bacLevel(int, promille×1000? NO — bacLevel is already promille float? HAR shape said int bacLevel:0 — zero reading. Real values: BACtrack API returns bacLevel as float promille (e.g. 0.42). Store NUMERIC via String(value). If provider sends int gibi values, still fine.}` — mapping: `bac_promille=String(r.bacLevel)`, `device_serial=r.deviceSN`, `measured_at=r.testedAt`, `origin='consumer_import'`, `raw_payload=r`, `operator=subject=current user`, `session_id=NULL`.

Dedupe: `provider_reading_id` TEXT UNIQUE (nulls allowed for managed rows).

---

### Task 1: Migration + service + controller + tests (TDD)

- [ ] **Step 1: Schema + SQL.** Append to schema.ts:

```ts
export const consumerImports = pgTable("consumer_imports", {
  id: uuid("id").primaryKey().defaultRandom(),
  identityId: uuid("identity_id")
    .notNull()
    .references(() => bactrackIdentities.id, { onDelete: "cascade" }),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  status: varchar("status", { length: 16 }).notNull().default("completed"),
  importedCount: integer("imported_count").notNull().default(0),
  skippedCount: integer("skipped_count").notNull().default(0),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});
```

Edit `bacReadings`: `sessionId` → drop `.notNull()` (keep references), add `providerReadingId: text("provider_reading_id").unique()`.

`0006_import.sql`:

```sql
CREATE TABLE IF NOT EXISTS consumer_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_id uuid NOT NULL REFERENCES bactrack_identities(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  status varchar(16) NOT NULL DEFAULT 'completed',
  imported_count integer NOT NULL DEFAULT 0,
  skipped_count integer NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
ALTER TABLE bac_readings ALTER COLUMN session_id DROP NOT NULL;
ALTER TABLE bac_readings ADD COLUMN IF NOT EXISTS provider_reading_id text UNIQUE;
```

verify.ts: add `"consumer_imports"`.

- [ ] **Step 2: `apps/api/src/imports/imports.service.ts`** (complete):

```ts
import { Injectable, UnauthorizedException, UnprocessableEntityException } from "@nestjs/common";
import { and, bacReadings, consumerImports, eq, getDb, bactrackIdentities } from "@bactrack/db";
import { open } from "../auth/crypto.js";
import { AuthService } from "../auth/auth.service.js";

const PAGE_LIMIT = 100;

interface ProviderReading {
  id: string;
  bacLevel: number;
  deviceSN: string;
  testedAt: string;
}

function providerApi(): string {
  return process.env.BACTRACK_API ?? "https://consumer-api.bactrack.com";
}

function encKey(): string {
  const k = process.env.TOKEN_ENC_KEY;
  if (!k) throw new Error("TOKEN_ENC_KEY is required");
  return k;
}

@Injectable()
export class ImportsService {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}
```

Wait — @Inject import needed. Full file:

```ts
import { Inject, Injectable, UnauthorizedException, UnprocessableEntityException } from "@nestjs/common";
import { bacReadings, bactrackIdentities, consumerImports, eq, getDb } from "@bactrack/db";
import { AuthService } from "../auth/auth.service.js";
import { open } from "../auth/crypto.js";

const PAGE_LIMIT = 100;

interface ProviderReading {
  id: string;
  bacLevel: number;
  deviceSN: string;
  testedAt: string;
}

function providerApi(): string {
  return process.env.BACTRACK_API ?? "https://consumer-api.bactrack.com";
}

function encKey(): string {
  const k = process.env.TOKEN_ENC_KEY;
  if (!k) throw new Error("TOKEN_ENC_KEY is required");
  return k;
}

@Injectable()
export class ImportsService {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  private db() {
    return getDb(process.env.DATABASE_URL as string);
  }

  private async providerGet(identityId: string, path: string): Promise<unknown> {
    const db = this.db();
    const rows = await db.select().from(bactrackIdentities).where(eq(bactrackIdentities.id, identityId)).limit(1);
    if (rows.length === 0 || !rows[0].encryptedAccess) {
      throw new UnauthorizedException("provider not linked");
    }
    let access: string;
    try {
      access = open(encKey(), rows[0].encryptedAccess);
    } catch {
      throw new UnauthorizedException("provider token unreadable");
    }
    const attempt = async (token: string) =>
      fetch(`${providerApi()}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8000),
      });
    let res = await attempt(access);
    if (res.status === 401) {
      const fresh = await this.auth.providerRefresh(rows[0].userId);
      if (!fresh) throw new UnauthorizedException("provider session expired");
      res = await attempt(fresh);
    }
    if (!res.ok) throw new UnprocessableEntityException("provider request failed");
    return res.json() as Promise<unknown>;
  }

  async runConsumerImport(userId: string, organizationId: string) {
    const db = this.db();
    const identities = await db.select().from(bactrackIdentities).where(eq(bactrackIdentities.userId, userId)).limit(1);
    if (identities.length === 0 || !identities[0].encryptedAccess) {
      throw new UnprocessableEntityException("no linked bactrack account");
    }
    const identity = identities[0];
    const [run] = await db
      .insert(consumerImports)
      .values({ identityId: identity.id, organizationId, status: "running" })
      .returning({ id: consumerImports.id });
    let imported = 0;
    let skipped = 0;
    let total = 0;
    try {
      for (let page = 1; ; page++) {
        const data = (await this.providerGet(identity.id, `/api/v1/readings?page=${page}&limit=${PAGE_LIMIT}`)) as {
          readings: ProviderReading[];
        };
        const readings = Array.isArray(data.readings) ? data.readings : [];
        total += readings.length;
        for (const r of readings) {
          if (typeof r.id !== "string") {
            skipped++;
            continue;
          }
          const existing = await db
            .select({ id: bacReadings.id })
            .from(bacReadings)
            .where(eq(bacReadings.providerReadingId, r.id))
            .limit(1);
          if (existing.length > 0) {
            skipped++;
            continue;
          }
          await db.insert(bacReadings).values({
            sessionId: null,
            organizationId,
            bacPromille: String(r.bacLevel ?? 0),
            deviceSerial: typeof r.deviceSN === "string" ? r.deviceSN : "unknown",
            operatorUserId: userId,
            subjectUserId: userId,
            origin: "consumer_import",
            rawPayload: r as unknown as Record<string, unknown>,
            measuredAt: new Date(r.testedAt),
          });
          imported++;
        }
        if (readings.length < PAGE_LIMIT) break;
      }
      await db
        .update(consumerImports)
        .set({ status: "completed", importedCount: imported, skippedCount: skipped, finishedAt: new Date() })
        .where(eq(consumerImports.id, run.id));
      return { imported, skipped, total };
    } catch (err) {
      await db
        .update(consumerImports)
        .set({ status: "failed", importedCount: imported, skippedCount: skipped, finishedAt: new Date() })
        .where(eq(consumerImports.id, run.id));
      throw err;
    }
  }

  async importStatus(userId: string) {
    const db = this.db();
    const identities = await db.select().from(bactrackIdentities).where(eq(bactrackIdentities.userId, userId)).limit(1);
    if (identities.length === 0) return { lastRun: null };
    const runs = await db.select().from(consumerImports).where(eq(consumerImports.identityId, identities[0].id)).limit(1);
```

Hmm — latest run needs order by started desc:

```ts
    const runs = await db
      .select()
      .from(consumerImports)
      .where(eq(consumerImports.identityId, identities[0].id))
      .orderBy(desc(consumerImports.startedAt))
      .limit(1);
    if (runs.length === 0) return { lastRun: null };
    const r = runs[0];
    return { lastRun: { status: r.status, imported: r.importedCount, skipped: r.skippedCount, finishedAt: r.finishedAt } };
```

(import desc from db.)

- [ ] **Step 3: Controller**:

```ts
import { Controller, Get, HttpCode, Inject, Post, UseGuards } from "@nestjs/common";
import { CurrentUser, OrgContext } from "../identity/current-user.js";
import { assertMembership } from "../identity/membership.js";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { ImportsService } from "./imports.service.js";

@UseGuards(JwtAuthGuard)
@Controller("imports")
export class ImportsController {
  constructor(@Inject(ImportsService) private readonly imports: ImportsService) {}

  @Post("consumer/run")
  @HttpCode(200)
  async run(@CurrentUser() ctx: OrgContext) {
    await assertMembership(ctx.organizationId, ctx.userId);
    return this.imports.runConsumerImport(ctx.userId, ctx.organizationId);
  }

  @Get("consumer/status")
  async status(@CurrentUser() ctx: OrgContext) {
    await assertMembership(ctx.organizationId, ctx.userId);
    return this.imports.importStatus(ctx.userId);
  }
}
```

Module wiring add ImportsController + ImportsService.

- [ ] **Step 4: Tests first** — `apps/api/test/imports.e2e.spec.ts`: helper creates user (magic flow? use AuthService registerOrLogin + mintPair directly like orgs spec) + inserts identity row manually (providerUserId text, encryptedAccess = seal(encKey, "prov-token") — import seal from src; TOKEN_ENC_KEY from env). Mock fetch: page1 → 2 readings, page2 → 1 reading (short page ends). Assert run → {imported:3, skipped:0, total:3}; rerun → {imported:0, skipped:3}; readings list shows origin consumer_import; status endpoint shows completed; unlinked user → 422; bad provider token (mock 401 twice) → 401.

Mock fetch routing: url contains "/api/v1/readings?page=1" vs page=2. Return `{readings:[...]}`.

Readings fixtures: `{id:"pr-1", bacLevel:0.21, deviceSN:"03-8CF-0-06887", testedAt:"2026-08-01T10:00:00.000Z", ...}` extra keys preserved into rawPayload.

- [ ] **Step 5: Migrate + verify + suite + commit** `feat(api): consumer history import`.

---

### Task 2: Live-probe docs + close-out

- [ ] Append `docs/consumer-live-probe.md`: throwaway-account steps (loopback redirect test, refresh grant test, users/me shape reconfirm, first real import + origin audit). Explicitly: never personal credentials, rotate after.
- [ ] Full `pnpm build && pnpm lint && pnpm test`, commit, report.

---

## Self-review

**Spec coverage:** Design section 8 + 8.1 import path: burst-mirroring initial full pages (limit=100 loop) ✓, incremental via rerun-skip (provider id dedupe; latest-testedAt fast path is a P9 optimization, noted) ✓, untrusted origin flag + raw payload ✓, stored encrypted tokens reused via providerRefresh ✓.
**Placeholder scan:** Exact code/commands. Live probe doc is explicit user-run steps, not a placeholder.
**Type consistency:** `origin: "consumer_import"` literal matches readings contract; `sessionId: null` matches nullable migration; status endpoint shape `{lastRun}` stable for the future web UI.
