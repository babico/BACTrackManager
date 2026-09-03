# Sync Worker Implementation Plan (P6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `apps/worker` runs the server-side sync duties on a loop: expire stale sessions (release leases, audit, outbox), prune delivered outbox rows by retention, and expose `RUN_ONCE=true` for manual/CI single passes. Tested against the dev DB; composed for home-lab.

**Architecture:** Standalone `@bactrack/worker` package (own drizzle access, no import from `apps/api` — services stay HTTP-owned; the sweeper reimplements the transition in ~40 lines with identical audit/outbox event names so consumers can't tell the difference). `SELECT ... FOR UPDATE SKIP LOCKED` makes multiple worker replicas safe. Graceful SIGTERM. `Dockerfile` + compose entry target the home-lab host (build unverified here — no Docker on dev machine, stated in close-out).

**Tech Stack:** Existing (drizzle, pg, tsx, vitest, zod for env). No new deps.

**Plan split:** P6 of the phase plan. Mobile backlog-consent + conflict reconciliation already shipped in P4 engine; server idempotency/409s in P2. This plan closes the server loop. P7+ consume outbox/sweeper behavior unchanged.

---

## File structure

| Path | Responsibility |
|---|---|
| `apps/worker/package.json` | `@bactrack/worker`, dev/start scripts |
| `apps/worker/tsconfig.json` | rootDir ".", include src+test |
| `apps/worker/vitest.config.ts` | Standard include |
| `apps/worker/src/config.ts` | Zod env: DATABASE_URL, SWEEP_INTERVAL_MS (60000), OUTBOX_RETENTION_DAYS (7), RUN_ONCE (false) |
| `apps/worker/src/sweeper.ts` | `expireDueSessions(db): Promise<{expired:number}>` |
| `apps/worker/src/outbox.ts` | `prunePublished(db, days): Promise<{deleted:number}>` |
| `apps/worker/src/index.ts` | Loop wiring + SIGTERM + RUN_ONCE |
| `apps/worker/test/sweeper.spec.ts` | Fixture session past expiry → run → expired + lease released + audit + outbox rows |
| `apps/worker/test/outbox.spec.ts` | Hand-inserted published rows pruned by age; unpublished kept |
| `apps/worker/Dockerfile`, `.dockerignore` | Home-lab image (unverified build) |
| `compose.yaml` | + worker service |
| `README.md` | Worker section |

Sweeper semantics (must match `SessionsService.transition` observable behavior):
- Candidate: `status NOT IN ('completed','failed','expired') AND expires_at < now()`, `FOR UPDATE SKIP LOCKED`, limit 100 per pass.
- Per candidate, one transaction: set `status='expired'`, `releasedAt` on its open lease, `audit_log(session.expired)`, `outbox(session.expired)`.
- Returns count. Never touches terminal rows (test asserts completed/failed rows untouched).

---

### Task 1: Package + sweeper + outbox (TDD)

- [ ] **Step 1: `apps/worker/package.json`**

```json
{
  "name": "@bactrack/worker",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsx watch src/index.ts",
    "start": "node dist/src/index.js",
    "test": "vitest run",
    "lint": "tsc --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "@bactrack/db": "workspace:*",
    "pg": "^8.13.1",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^22.7.0",
    "@types/pg": "^8.11.0",
    "drizzle-orm": "^0.36.4",
    "tsx": "^4.19.2",
    "typescript": "^5.6.3",
    "vitest": "^2.1.0"
  }
}
```

Note `start`: rootDir "." → dist mirrors `dist/src/index.js`. Keep exactly (test asserts nothing about paths; build proves it).

- [ ] **Step 2: `tsconfig.json`, `vitest.config.ts`** (same shape as mobile: rootDir ".", include src+test, types node).

- [ ] **Step 3: `src/config.ts`**

```ts
import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(60000),
  OUTBOX_RETENTION_DAYS: z.coerce.number().int().positive().default(7),
  RUN_ONCE: z.coerce.boolean().default(false),
});

export type WorkerConfig = z.infer<typeof schema>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return schema.parse(env);
}
```

- [ ] **Step 4: `src/sweeper.ts`**

```ts
import { and, auditLog, deviceLeases, eq, getDb, outbox, sql, testSessions } from "@bactrack/db";

export async function expireDueSessions(connectionString: string): Promise<{ expired: number }> {
  const db = getDb(connectionString);
  const candidates = await db.execute<{ id: string }>(sql`
    SELECT id FROM test_sessions
    WHERE status NOT IN ('completed', 'failed', 'expired') AND expires_at < now()
    ORDER BY expires_at ASC LIMIT 100 FOR UPDATE SKIP LOCKED
  `);
  let expired = 0;
  for (const c of candidates.rows) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM test_sessions WHERE id = ${c.id} FOR UPDATE`);
      const rows = await tx.select().from(testSessions).where(eq(testSessions.id, c.id)).limit(1);
      if (rows.length === 0) return;
      const s = rows[0];
      if (s.status === "completed" || s.status === "failed" || s.status === "expired") return;
      await tx.update(testSessions).set({ status: "expired", updatedAt: new Date() }).where(eq(testSessions.id, s.id));
      await tx
        .update(deviceLeases)
        .set({ releasedAt: new Date() })
        .where(and(eq(deviceLeases.sessionId, s.id), sql`released_at IS NULL`));
      await tx.insert(auditLog).values({
        organizationId: s.organizationId,
        actorUserId: null,
        action: "session.expired",
        entityType: "session",
        entityId: s.id,
        details: { by: "worker" },
      });
      await tx.insert(outbox).values({
        aggregateType: "session",
        aggregateId: s.id,
        eventType: "session.expired",
        payload: { status: "expired", by: "worker" },
      });
      expired++;
    });
  }
  return { expired };
}
```

`db.execute<T>` typing: drizzle pg `execute` returns `QueryResult<T>`-ish with `.rows`. If tsc complains, fall back to `getPool(connectionString).query(...)`. (Implementer: try drizzle first, pool fallback allowed — record which in report.)

- [ ] **Step 5: `src/outbox.ts`**

```ts
import { getDb, outbox, sql } from "@bactrack/db";

export async function prunePublished(connectionString: string, olderThanDays: number): Promise<{ deleted: number }> {
  const db = getDb(connectionString);
  const res = await db.execute(sql`
    DELETE FROM outbox
    WHERE published_at IS NOT NULL AND published_at < now() - (${olderThanDays} || ' days')::interval
  `);
  return { deleted: (res as unknown as { rowCount?: number }).rowCount ?? 0 };
}
```

Same typing note as sweeper (pool fallback allowed).

- [ ] **Step 6: `src/index.ts`**

```ts
import { getDb } from "@bactrack/db";
import { loadConfig } from "./config.js";
import { expireDueSessions } from "./sweeper.js";
import { prunePublished } from "./outbox.js";

async function pass(url: string, retentionDays: number): Promise<void> {
  const swept = await expireDueSessions(url);
  const pruned = await prunePublished(url, retentionDays);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ at: new Date().toISOString(), ...swept, ...pruned }));
}

async function main(): Promise<void> {
  const config = loadConfig();
  void getDb;
  if (config.RUN_ONCE) {
    await pass(config.DATABASE_URL, config.OUTBOX_RETENTION_DAYS);
    return;
  }
  let stopped = false;
  const shutdown = () => {
    stopped = true;
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  while (!stopped) {
    try {
      await pass(config.DATABASE_URL, config.OUTBOX_RETENTION_DAYS);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("worker pass failed", err);
    }
    await new Promise((r) => setTimeout(r, config.SWEEP_INTERVAL_MS));
  }
}

void main();
```

(Drop the silly `void getDb;` — remove in implementation; config only needs URL strings.)

- [ ] **Step 7: Tests first** — `test/sweeper.spec.ts`: insert org+user+device+session(expires yesterday)+lease directly via drizzle; run `expireDueSessions`; assert session expired, lease releasedAt set, audit row `session.expired`, outbox row `session.expired`; second run returns 0; completed fixture untouched. `test/outbox.spec.ts`: insert published-old, published-recent, unpublished rows; prune(7) deletes only old; returns counts. Fixtures use unique suffixes; delete created rows at end (afterAll cleanup by org id where possible — sessions cascade; outbox/audit rows reference deleted org? FKs: audit/outbox → organizations cascade; delete org cascades audit+outbox+devices? devices → org cascade; sessions → org cascade; leases → session cascade; readings restrict. Order: delete readings? Tests create no readings. Delete org → cascades rest. Magic/invite tables untouched.)

- [ ] **Step 8: Build + tests green + commit** `feat(worker): expiry sweeper and outbox retention`.

---

### Task 2: Dockerfile + compose + README + close-out

- [ ] `apps/worker/Dockerfile`:

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/db/package.json ./packages/db/
COPY apps/worker/package.json ./apps/worker/
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate && pnpm install --frozen-lockfile --filter @bactrack/worker...
COPY packages/db ./packages/db
COPY apps/worker ./apps/worker
RUN pnpm --filter @bactrack/db build && pnpm --filter @bactrack/worker build
CMD ["node", "apps/worker/dist/src/index.js"]
```

`.dockerignore`: node_modules, dist, .turbo, .next, .env.

- [ ] compose += worker (depends postgres healthy, env DATABASE_URL/SWEEP_INTERVAL_MS, restart unless-stopped).
- [ ] README worker section (RUN_ONCE usage, intervals).
- [ ] `pnpm build && pnpm lint && pnpm test` green; commit; report Docker-unverified note.

---

## Self-review

**Spec coverage:** PLAN.md Phase 6 server duties: watchdog expiry ✓, outbox retention ✓, multi-replica safety (SKIP LOCKED) ✓, manual single-pass ✓. Mobile backlog consent + conflicts already in P4 (referenced, not duplicated). SSE already live in P2 (worker doesn't need to serve it).
**Placeholder scan:** Exact code/commands. Dockerfile marked unverified (explicit, with reason).
**Type consistency:** Event/action names identical to service (`session.expired`); `actorUserId: null` matches audit nullable column; outbox payload shapes match SSE replay expectations.
