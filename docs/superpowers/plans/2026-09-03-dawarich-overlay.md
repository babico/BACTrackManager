# Dawarich Overlay Implementation Plan (P8)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An org connects its Dawarich instance (URL + API key, sealed at rest); the backend proxies timeline data and merges our BAC readings by day; the web map toggle shows the merged view. No Dawarich credentials ever reach the browser.

**Architecture:** `dawarich_connections` (one row per org, unique). `DawarichService` calls the instance server-side with `?api_key=` (verified contract v1.9.2, design doc section 5), validates via `/api/v1/health` on connect, proxies `/api/v1/timeline?start_at&end_at` (≤31d windows, chunked server-side for longer ranges), and attaches our readings grouped by UTC date. Owner/admin only for connect/disconnect; members read merged timeline. Keys AES-GCM sealed (same helper as provider tokens). Disconnect NULLs the key (row kept for audit trail).

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

- `POST /dawarich/connect` `{baseUrl, apiKey}` → 200 `{connected:true}` / 422 unreachable-or-unhealthy (owner/admin only)
- `GET /dawarich/status` → 200 `{connected, baseUrl}` (key never returned)
- `DELETE /dawarich/disconnect` → 200 (owner/admin only; key wiped)
- `GET /dawarich/timeline?from&to` (ISO dates, max 62d, chunked into ≤31d upstream calls) → 200 `{days:[{date, summary, entries, readings:[{id,bacPromille,measuredAt,origin}]}]}` / 422 not connected

Merge rule: readings grouped by `measuredAt` UTC date string; day matched to timeline `day.date`. Days present in either source appear (union).

---

### Task 1: Migration + service + controller + tests (TDD)

- [ ] **Step 1: Schema + SQL.**

```ts
export const dawarichConnections = pgTable(
  "dawarich_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    baseUrl: text("base_url").notNull(),
    encryptedKey: text("encrypted_key"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("uq_dawarich_org").on(t.organizationId)],
);
```

```sql
CREATE TABLE IF NOT EXISTS dawarich_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  base_url text NOT NULL,
  encrypted_key text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_dawarich_org ON dawarich_connections (organization_id);
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

  private async requireManager(orgId: string, userId: string): Promise<void> {
    const role = await this.orgs.roleOf(orgId, userId);
    if (role !== "owner" && role !== "admin") throw new ForbiddenException("owner or admin only");
  }

  private async connection(orgId: string) {
    const rows = await this.db().select().from(dawarichConnections).where(eq(dawarichConnections.organizationId, orgId)).limit(1);
    return rows.length > 0 ? rows[0] : null;
  }

  async connect(orgId: string, userId: string, baseUrl: string, apiKey: string) {
    await this.requireManager(orgId, userId);
    const clean = baseUrl.replace(/\/+$/, "");
    if (!/^https?:\/\/.+/.test(clean)) throw new UnprocessableEntityException("invalid base url");
    try {
      const health = (await dawGet(clean, apiKey, "/api/v1/health")) as { status?: string };
      if (health.status !== "ok") throw new Error("unhealthy");
    } catch {
      throw new UnprocessableEntityException("dawarich unreachable or key rejected");
    }
    const db = this.db();
    const existing = await this.connection(orgId);
    const sealed = seal(encKey(), apiKey);
    if (existing) {
      await db.update(dawarichConnections).set({ baseUrl: clean, encryptedKey: sealed, createdBy: userId }).where(eq(dawarichConnections.id, existing.id));
    } else {
      await db.insert(dawarichConnections).values({ organizationId: orgId, baseUrl: clean, encryptedKey: sealed, createdBy: userId });
    }
    return { connected: true };
  }

  async status(orgId: string) {
    const conn = await this.connection(orgId);
    if (!conn || !conn.encryptedKey) return { connected: false, baseUrl: null };
    return { connected: true, baseUrl: conn.baseUrl };
  }

  async disconnect(orgId: string, userId: string) {
    await this.requireManager(orgId, userId);
    await this.db().update(dawarichConnections).set({ encryptedKey: null }).where(eq(dawarichConnections.organizationId, orgId));
    return { connected: false };
  }

  async timeline(orgId: string, from: string, to: string) {
    const conn = await this.connection(orgId);
    if (!conn || !conn.encryptedKey) throw new UnprocessableEntityException("dawarich not connected");
    const start = new Date(from);
    const end = new Date(to);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
      throw new UnprocessableEntityException("invalid range");
    }
    const days = Math.ceil((end.getTime() - start.getTime()) / 86400000) + 1;
    if (days > MAX_RANGE_DAYS) throw new UnprocessableEntityException("range too wide (max 62 days)");
    let key: string;
    try {
      key = open(encKey(), conn.encryptedKey);
    } catch {
      throw new UnprocessableEntityException("stored key unreadable");
    }
    const merged = new Map<string, { date: string; summary?: unknown; entries?: unknown[] }>();
    for (let w = new Date(start); w <= end; w = new Date(w.getTime() + WINDOW_DAYS * 86400000)) {
      const wEnd = new Date(Math.min(w.getTime() + (WINDOW_DAYS - 1) * 86400000, end.getTime()));
      const fmt = (d: Date) => d.toISOString();
      let data: { days?: TimelineDay[] };
      try {
        data = (await dawGet(conn.baseUrl, key, `/api/v1/timeline?start_at=${encodeURIComponent(fmt(w))}&end_at=${encodeURIComponent(fmt(wEnd))}`)) as typeof data;
      } catch {
        throw new UnprocessableEntityException("dawarich request failed");
      }
      for (const d of data.days ?? []) {
        merged.set(d.date, { date: d.date, summary: d.summary, entries: d.entries ?? [] });
      }
    }
    const db = this.db();
    const readings = await db
      .select({ id: bacReadings.id, bac: bacReadings.bacPromille, at: bacReadings.measuredAt, origin: bacReadings.origin })
      .from(bacReadings)
      .where(and(eq(bacReadings.organizationId, orgId), gte(bacReadings.measuredAt, start), lte(bacReadings.measuredAt, end)))
      .orderBy(desc(bacReadings.measuredAt));
    for (const r of readings) {
      const day = r.at.toISOString().slice(0, 10);
      const existing = merged.get(day) ?? { date: day };
      merged.set(day, { ...existing, readings: [...((existing as { readings?: unknown[] }).readings ?? []), { id: r.id, bacPromille: r.bac, measuredAt: r.at, origin: r.origin }] });
    }
    return { days: [...merged.values()].sort((a, b) => (a.date < b.date ? -1 : 1)) };
  }
}
```

- [ ] **Step 3: Controller** (`POST /dawarich/connect` + `@HttpCode(200)`, `GET /dawarich/status`, `DELETE /dawarich/disconnect`, `GET /dawarich/timeline?from&to`), all `@UseGuards(JwtAuthGuard)`, membership assert, zod bodies. Module wiring.

- [ ] **Step 4: Tests first** — `test/dawarich.e2e.spec.ts`: mock fetch routing on URL (`/health` → `{status:"ok"}` or 500 for fail case; `/timeline` → `{days:[{date:"2026-09-01",summary:{},entries:[{type:"visit"}]}]}`). Matrix: connect ok → status shows baseUrl, no key leaked; connect with dead instance → 422; timeline merges a managed reading from same day (create device+session+complete via HTTP first) → day has entries + readings; disconnect → status false, timeline 422; viewer connect → 403. Unstub after each.

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
