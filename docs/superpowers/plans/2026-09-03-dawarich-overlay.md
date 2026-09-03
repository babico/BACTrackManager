# Dawarich Overlay Implementation Plan (P8)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An org connects its Dawarich instance (URL + API key, sealed at rest); the backend proxies timeline data and merges our BAC readings by day; the web map toggle shows the merged view. No Dawarich credentials ever reach the browser.

**Architecture:** `dawarich_connections` is keyed by USER, not org — research (2026-09-03, searxng + official docs) proved the API key is per Dawarich account (Account section, QR code) and Family sharing is real-time-only, never historical. Each team member links their OWN Dawarich account+key; the backend merges per-user timelines for review. `DawarichService` calls the instance server-side with `?api_key=` (verified contract v1.9.2, design doc section 5), validates via `/api/v1/health` on connect, proxies `/api/v1/timeline?start_at&end_at` (≤31d windows, chunked server-side for longer ranges), and attaches our readings grouped by UTC date. Any member manages only their own link; owner/admin may additionally read the merged TEAM timeline (explicit team-review feature, documented consent on the page). Keys AES-GCM sealed (same helper as provider tokens). Disconnect NULLs the key (row kept for audit trail).

**Tech Stack:** Existing. No new deps.

**Plan split:** P8 of the phase plan. Contract pinned live in P0 (section 5). P9+ untouched.

---

## File structure

| Path | Responsibility |
|---|---|
| `packages/db/migrations/0007_dawarich.sql` | `dawarich_connections` table |
| `packages/db/src/schema.ts` | + `dawarichConnections` |
| `packages/db/scripts/verify.ts` | + table check |
| `apps/api/src/dawarich/dawarich.service.ts` | connect/status/disconnect/timeline+merge |
| `apps/api/src/dawarich/dawarich.controller.ts` | `POST /dawarich/connect`, `GET /dawarich/status`, `DELETE /dawarich/disconnect`, `GET /dawarich/timeline?from&to` |
| `apps/api/test/dawarich.e2e.spec.ts` | Connect (mocked health ok/fail), status masked, timeline merge, disconnect wipes, role gates |
| `apps/web/src/app/map/page.tsx` | Toggle fetches merged timeline, day list |

Endpoint summary (Bearer + `x-org-id`):

- `POST /dawarich/connect` `{baseUrl, apiKey}` → 200 `{connected:true}` / 422 unreachable-or-unhealthy (own link, any member)
- `GET /dawarich/status` → 200 `{connected, baseUrl}` (key never returned; own link)
- `DELETE /dawarich/disconnect` → 200 (own link; key wiped)
- `GET /dawarich/timeline?from&to` (ISO dates, max 62d, chunked into ≤31d upstream calls) → 200 `{days:[{date, summary, entries, readings:[{id,bacPromille,measuredAt,origin}]}]}` / 422 not connected (own timeline + own org readings)
- `GET /dawarich/team-timeline?from&to` → 200 `{users:[{userId, displayName, days:[...]}]}` (owner/admin only; one entry per member WITH a link; members without links skipped)

Merge rule: readings grouped by `measuredAt` UTC date string; day matched to timeline `day.date`. Days present in either source appear (union).

---

### Task 1: Migration + service + controller + tests (TDD)

- [ ] **Step 1: Schema + SQL.**

```ts
export const dawarichConnections = pgTable(
  "dawarich_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    baseUrl: text("base_url").notNull(),
    encryptedKey: text("encrypted_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("uq_dawarich_user").on(t.userId)],
);
```

```sql
CREATE TABLE IF NOT EXISTS dawarich_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  base_url text NOT NULL,
  encrypted_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_dawarich_user ON dawarich_connections (user_id);
```

verify.ts: add `"dawarich_connections"`.

- [ ] **Step 2: `apps/api/src/dawarich/dawarich.service.ts`** (complete):

```ts
import { ForbiddenException, Inject, Injectable, UnprocessableEntityException } from "@nestjs/common";
import { and, bacReadings, dawarichConnections, desc, eq, getDb, gte, lte } from "@bactrack/db";
import { OrgsService } from "../orgs/orgs.service.js";
import { open, seal } from "../auth/crypto.js";

const WINDOW_DAYS = 31;
const MAX_RANGE_DAYS = 62;

function encKey(): string {
  const k = process.env.TOKEN_ENC_KEY;
  if (!k) throw new Error("TOKEN_ENC_KEY is required");
  return k;
}

interface TimelineDay {
  date: string;
  summary?: unknown;
  entries?: unknown[];
}

async function dawGet(baseUrl: string, key: string, path: string): Promise<unknown> {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${baseUrl}${path}${sep}api_key=${encodeURIComponent(key)}`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`dawarich responded ${res.status}`);
  return res.json() as Promise<unknown>;
}

@Injectable()
export class DawarichService {
  constructor(@Inject(OrgsService) private readonly orgs: OrgsService) {}

  private db() {
    return getDb(process.env.DATABASE_URL as string);
  }

  private async connection(userId: string) {
    const rows = await this.db().select().from(dawarichConnections).where(eq(dawarichConnections.userId, userId)).limit(1);
    return rows.length > 0 ? rows[0] : null;
  }

  private async openKey(conn: { encryptedKey: string | null }): Promise<string> {
    if (!conn.encryptedKey) throw new UnprocessableEntityException("dawarich not connected");
    try {
      return open(encKey(), conn.encryptedKey);
    } catch {
      throw new UnprocessableEntityException("stored key unreadable");
    }
  }

  async connect(userId: string, baseUrl: string, apiKey: string) {
    const clean = baseUrl.replace(/\/+$/, "");
    if (!/^https?:\/\/.+/.test(clean)) throw new UnprocessableEntityException("invalid base url");
    try {
      const health = (await dawGet(clean, apiKey, "/api/v1/health")) as { status?: string };
      if (health.status !== "ok") throw new Error("unhealthy");
    } catch {
      throw new UnprocessableEntityException("dawarich unreachable or key rejected");
    }
    const db = this.db();
    const existing = await this.connection(userId);
    const sealed = seal(encKey(), apiKey);
    if (existing) {
      await db.update(dawarichConnections).set({ baseUrl: clean, encryptedKey: sealed }).where(eq(dawarichConnections.id, existing.id));
    } else {
      await db.insert(dawarichConnections).values({ userId, baseUrl: clean, encryptedKey: sealed });
    }
    return { connected: true };
  }

  async status(userId: string) {
    const conn = await this.connection(userId);
    if (!conn || !conn.encryptedKey) return { connected: false, baseUrl: null };
    return { connected: true, baseUrl: conn.baseUrl };
  }

  async disconnect(userId: string) {
    await this.db().update(dawarichConnections).set({ encryptedKey: null }).where(eq(dawarichConnections.userId, userId));
    return { connected: false };
  }

  private parseRange(from: string, to: string): { start: Date; end: Date } {
    const start = new Date(from);
    const end = new Date(to);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
      throw new UnprocessableEntityException("invalid range");
    }
    if (Math.ceil((end.getTime() - start.getTime()) / 86400000) + 1 > MAX_RANGE_DAYS) {
      throw new UnprocessableEntityException("range too wide (max 62 days)");
    }
    return { start, end };
  }

  private async fetchDays(baseUrl: string, key: string, start: Date, end: Date) {
    const merged = new Map<string, { date: string; summary?: unknown; entries?: unknown[] }>();
    for (let w = new Date(start); w <= end; w = new Date(w.getTime() + WINDOW_DAYS * 86400000)) {
      const wEnd = new Date(Math.min(w.getTime() + (WINDOW_DAYS - 1) * 86400000, end.getTime()));
      let data: { days?: TimelineDay[] };
      try {
        data = (await dawGet(
          baseUrl,
          key,
          `/api/v1/timeline?start_at=${encodeURIComponent(w.toISOString())}&end_at=${encodeURIComponent(wEnd.toISOString())}`,
        )) as typeof data;
      } catch {
        throw new UnprocessableEntityException("dawarich request failed");
      }
      for (const d of data.days ?? []) {
        merged.set(d.date, { date: d.date, summary: d.summary, entries: d.entries ?? [] });
      }
    }
    return merged;
  }

  async timeline(userId: string, organizationId: string, from: string, to: string) {
    const conn = await this.connection(userId);
    if (!conn) throw new UnprocessableEntityException("dawarich not connected");
    const key = await this.openKey(conn);
    const { start, end } = this.parseRange(from, to);
    const merged = await this.fetchDays(conn.baseUrl, key, start, end);
    attachReadings(merged, await this.readingsFor(organizationId, userId, start, end));
    return { days: sortedDays(merged) };
  }

  async teamTimeline(orgId: string, managerId: string, from: string, to: string) {
    const role = await this.orgs.roleOf(orgId, managerId);
    if (role !== "owner" && role !== "admin") throw new ForbiddenException("owner or admin only");
    const { start, end } = this.parseRange(from, to);
    const members = await this.orgs.members(orgId);
    const usersOut: { userId: string; displayName: string; days: unknown[] }[] = [];
    for (const m of members.members) {
      const conn = await this.connection(m.userId);
      if (!conn) continue;
      let key: string;
      try {
        key = await this.openKey(conn);
      } catch {
        continue;
      }
      let merged: Map<string, { date: string; summary?: unknown; entries?: unknown[] }>;
      try {
        merged = await this.fetchDays(conn.baseUrl, key, start, end);
      } catch {
        continue;
      }
      attachReadings(merged, await this.readingsFor(orgId, m.userId, start, end));
      usersOut.push({ userId: m.userId, displayName: m.displayName, days: sortedDays(merged) });
    }
    return { users: usersOut };
  }

  private async readingsFor(organizationId: string, subjectUserId: string, start: Date, end: Date) {
    return this.db()
      .select({ id: bacReadings.id, bac: bacReadings.bacPromille, at: bacReadings.measuredAt, origin: bacReadings.origin })
      .from(bacReadings)
      .where(
        and(
          eq(bacReadings.organizationId, organizationId),
          eq(bacReadings.subjectUserId, subjectUserId),
          gte(bacReadings.measuredAt, start),
          lte(bacReadings.measuredAt, end),
        ),
      )
      .orderBy(desc(bacReadings.measuredAt));
  }
}

type DayBucket = { date: string; summary?: unknown; entries?: unknown[]; readings?: unknown[] };

function attachReadings(
  merged: Map<string, { date: string; summary?: unknown; entries?: unknown[] }>,
  readings: { id: string; bac: string; at: Date; origin: string }[],
): void {
  for (const r of readings) {
    const day = r.at.toISOString().slice(0, 10);
    const existing = (merged.get(day) ?? { date: day }) as DayBucket;
    merged.set(day, {
      ...existing,
      readings: [...(existing.readings ?? []), { id: r.id, bacPromille: r.bac, measuredAt: r.at, origin: r.origin }],
    });
  }
}

function sortedDays(merged: Map<string, { date: string; summary?: unknown; entries?: unknown[] }>) {
  return [...merged.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}
```

- [ ] **Step 3: Controller** (`POST /dawarich/connect` + `@HttpCode(200)`, `GET /dawarich/status`, `DELETE /dawarich/disconnect`, `GET /dawarich/timeline?from&to`, `GET /dawarich/team-timeline?from&to`), all `@UseGuards(JwtAuthGuard)`, membership assert via guard+controller (connect/status/disconnect/timeline bind the CALLER's userId; team-timeline additionally asserts membership then delegates role check to service). Module wiring.

- [ ] **Step 4: Tests first** — `test/dawarich.e2e.spec.ts`: mock fetch routing on URL (`/health` → `{status:"ok"}` or 500 for fail case; `/timeline` → `{days:[{date:"2026-09-01",summary:{},entries:[{type:"visit"}]}]}`). Matrix: connect ok → status shows baseUrl, no key leaked; connect with dead instance → 422; timeline merges a managed reading from same day (create device+session+complete via HTTP first) → day has entries + readings; second user without link gets 422 on own timeline; disconnect → status false, timeline 422; team-timeline as owner shows linked member bucket with readings, skips unlinked; viewer team-timeline → 403. Unstub after each.

- [ ] **Step 5: Migrate + verify + suite + commit** `feat(api): dawarich overlay with merged timeline`.

---

### Task 2: Web toggle + close-out

- [ ] Map page: when toggle on, fetch `/dawarich/timeline?from&to` (last 7d), render day rows (date, entries count, readings count+bac). Stub note removed when connected; 422 → "not connected" hint linking /teams (owner connects — hmm, connect UI? Add minimal connect form on map page gated by role from /auth/me orgs list? Keep: connect form fields baseUrl+apiKey POST, shown always, backend enforces role. 2 inputs + button, 15 lines.)
- [ ] `next build` green, full `pnpm build && pnpm lint && pnpm test`, commit, report.

---

## Self-review

**Spec coverage:** P8 overlay: server-side adapter pinned to probed v1.9.2 shapes ✓, track timeline via timeline entries ✓, privacy (sealed keys, never to browser, disconnect wipes, timeline is per-org member-only) ✓. Fog-of-war/hexagons out of scope (not needed for BAC correlation).
**Placeholder scan:** Exact code/commands. 31d chunking implemented, not described.
**Type consistency:** `{days:[{date,summary,entries,readings[]}]}` union shape stable; error 422 for all provider failures; role model reuses orgs roles.
