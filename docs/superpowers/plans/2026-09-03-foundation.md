# Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Empty repo becomes a working pnpm/Turborepo monorepo with home-lab compose, versioned Postgres migrations applied to the dev DB, and a tested NestJS API skeleton (health, version, error shape).

**Architecture:** `apps/api` (NestJS 11) reads config from validated env, exposes `/health` and `/version`, and serves all future modules. `packages/db` owns the Drizzle schema and SQL migrations as the single source of truth. Nothing else exists yet; web, mobile, worker, and feature modules arrive in later plans.

**Tech Stack:** Node 22+ (dev machine runs 25, engines allow >=20), pnpm 9 via corepack, Turborepo 2, TypeScript 5.6, NestJS 11, Drizzle ORM 0.36 + drizzle-kit, pg 8, vitest 2, Postgres 16 (dev DB at 192.168.21.2:5432, database `bactrackmanager`).

**Plan split:** The approved spec spans six subsystems. One plan each: (1) this foundation plan, (2) capture domain backend (devices, leases, sessions, ingest, audit), (3) hybrid auth (BACtrack PKCE + magic link), (4) consumer-history import, (5) iOS BLE survey app + native bridge, (6) web dashboard + mobile capture UI. Each produces working, testable software alone.

---

## File structure (this plan)

| Path | Responsibility |
|---|---|
| `package.json` | Workspace root scripts + dev tooling |
| `pnpm-workspace.yaml` | Workspace globs `apps/*`, `packages/*` |
| `turbo.json` | Pipeline: build, test, lint, dev |
| `tsconfig.base.json` | Shared strict TS config |
| `.nvmrc` | Pins Node 22 |
| `.gitattributes` | Forces LF line endings (kills CRLF warnings) |
| `.gitignore` | Extends existing (keeps `*.har`, adds `node_modules`, `dist`, `.turbo`) |
| `compose.yaml` | Home-lab runtime: postgres, api, worker, web (api/worker/web use `build:` + `image:` so the file works before images exist) |
| `.env.example` | Every variable compose + api need, with safe example values (no secrets) |
| `packages/db/package.json` | Drizzle + pg + drizzle-kit deps, migration scripts |
| `packages/db/drizzle.config.ts` | Points at `../db/migrations`, reads `DATABASE_URL` |
| `packages/db/src/schema.ts` | All tables v1 (mirror of `docs/postgres-schema.sql` + identity/magic-link/outbox tables) |
| `packages/db/src/index.ts` | Pool factory + exported schema |
| `packages/db/migrations/0001_foundation.sql` | Generated SQL, reviewed, hand-adjusted, idempotent-safe |
| `packages/db/scripts/verify.ts` | Applies nothing; asserts every expected table/index/constraint exists, prints PASS/FAIL per check |
| `apps/api/package.json` | NestJS app deps + scripts |
| `apps/api/src/main.ts` | Bootstrap: validation pipe, error filter, port from config |
| `apps/api/src/config.ts` | Zod-validated env (`DATABASE_URL`, `PORT`, `API_VERSION`, `JWT_*` placeholders for later plans) |
| `apps/api/src/health/health.controller.ts` | `GET /health`, `GET /version` |
| `apps/api/src/common/http-error.filter.ts` | Uniform `{error:{code,message,requestId}}` envelope |
| `apps/api/test/health.e2e.spec.ts` | Supertest: status codes, envelope shape, version value |
| `.github/workflows/ci.yml` | Install, lint, build, test, migration dry-check |
| `README.md` | How to run on home-lab + Windows dev machine |

Schema v1 tables (exact columns in Task 4): `users`, `organizations`, `organization_memberships`, `team_invites`, `devices`, `test_sessions`, `device_leases`, `bac_readings`, `audit_log`, plus new `bactrack_identities`, `magic_links`, `outbox`. Enums: `org_type`, `membership_role`, `invite_status`, `device_status`, `session_status`.

---

### Task 1: Workspace scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `.nvmrc`, `.gitattributes`
- Modify: `.gitignore`

- [ ] **Step 1: Enable pnpm via corepack**

Run: `corepack enable && corepack prepare pnpm@9.15.0 --activate && pnpm --version`
Expected: `9.15.0` (any 9.x is acceptable; record actual version and use it in later steps)

- [ ] **Step 2: Create `package.json`**

```json
{
  "name": "bactrack-manager",
  "version": "0.1.0",
  "private": true,
  "packageManager": "pnpm@9.15.0",
  "scripts": {
    "build": "turbo run build",
    "test": "turbo run test",
    "lint": "turbo run lint",
    "dev": "turbo run dev --parallel",
    "db:generate": "pnpm --filter @bactrack/db db:generate",
    "db:migrate": "pnpm --filter @bactrack/db db:migrate",
    "db:verify": "pnpm --filter @bactrack/db db:verify"
  },
  "devDependencies": {
    "turbo": "^2.5.0",
    "typescript": "^5.6.3"
  },
  "engines": {
    "node": ">=20",
    "pnpm": ">=9"
  }
}
```

- [ ] **Step 3: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

- [ ] **Step 4: Create `turbo.json`**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "test": { "dependsOn": ["^build"] },
    "lint": {},
    "dev": { "cache": false, "persistent": true }
  }
}
```

- [ ] **Step 5: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "declaration": true,
    "sourceMap": true
  }
}
```

- [ ] **Step 6: Create `.nvmrc`, `.gitattributes`, extend `.gitignore`**

`.nvmrc` content: `22`
`.gitattributes` content: `* text=auto eol=lf`
Append to existing `.gitignore` (keep the secrets block untouched):

```
node_modules/
dist/
.turbo/
*.tsbuildinfo
coverage/
```

- [ ] **Step 7: Install and commit**

Run: `pnpm install`
Expected: `pnpm-lock.yaml` created, no errors.
Run: `git add package.json pnpm-workspace.yaml turbo.json tsconfig.base.json .nvmrc .gitattributes .gitignore pnpm-lock.yaml && git commit -m "chore: pnpm workspace scaffold with turbo and LF endings" && git status --short`
Expected: clean tree.

---

### Task 2: Compose + env examples

**Files:**
- Create: `compose.yaml`, `.env.example`

- [ ] **Step 1: Create `compose.yaml`**

```yaml
name: bactrack
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER:?POSTGRES_USER required}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?POSTGRES_PASSWORD required}
      POSTGRES_DB: ${POSTGRES_DB:?POSTGRES_DB required}
    ports:
      - "${POSTGRES_PORT:-5432}:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER}"]
      interval: 10s
      timeout: 5s
      retries: 5

  api:
    build: ./apps/api
    image: bactrack/api:local
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      DATABASE_URL: postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}
      PORT: "3001"
      API_VERSION: ${API_VERSION:-0.1.0}
    ports:
      - "${API_PORT:-3001}:3001"

volumes:
  pgdata:
```

- [ ] **Step 2: Create `.env.example`** (example values only, never real secrets)

```
POSTGRES_USER=bactrackmanager
POSTGRES_PASSWORD=change-me-in-real-env-file
POSTGRES_DB=bactrackmanager
POSTGRES_PORT=5432
API_PORT=3001
API_VERSION=0.1.0
DATABASE_URL=postgres://bactrackmanager:change-me-in-real-env-file@192.168.21.2:5432/bactrackmanager
```

- [ ] **Step 3: Validate compose file parses**

Run: `docker compose -f compose.yaml config --quiet 2>&1 || echo "DOCKER-MISSING-OR-INVALID"`
Expected on this Windows dev machine: `DOCKER-MISSING-OR-INVALID` (no Docker here; file targets the home-lab host). If Docker exists, quiet output means valid.
Then: `git add compose.yaml .env.example && git commit -m "chore: home-lab compose and env example" && git status --short`
Expected: clean tree.

---

### Task 3: DB package shell

**Files:**
- Create: `packages/db/package.json`, `packages/db/tsconfig.json`, `packages/db/drizzle.config.ts`

- [ ] **Step 1: Create `packages/db/package.json`**

```json
{
  "name": "@bactrack/db",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "echo \"db: no unit tests; see db:verify\"",
    "lint": "tsc --noEmit -p tsconfig.json",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "tsx ./scripts/migrate.ts",
    "db:verify": "tsx ./scripts/verify.ts"
  },
  "dependencies": {
    "drizzle-orm": "^0.36.4",
    "pg": "^8.13.1"
  },
  "devDependencies": {
    "@types/pg": "^8.11.0",
    "drizzle-kit": "^0.28.1",
    "tsx": "^4.19.2",
    "typescript": "^5.6.3"
  }
}
```

- [ ] **Step 2: Create `packages/db/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node"]
  },
  "include": ["src", "scripts"]
}
```

- [ ] **Step 3: Create `packages/db/drizzle.config.ts`**

```ts
import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required for drizzle-kit");
}

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL },
  verbose: true,
  strict: true,
});
```

- [ ] **Step 4: Install and commit shell**

Run: `pnpm install`
Expected: workspace links `@bactrack/db`, no errors.
Run: `git add packages/db/package.json packages/db/tsconfig.json packages/db/drizzle.config.ts pnpm-lock.yaml && git commit -m "chore: db package shell with drizzle-kit" && git status --short`
Expected: clean tree.

---

### Task 4: Schema v1 + migration (the load-bearing task)

**Files:**
- Create: `packages/db/src/schema.ts`, `packages/db/src/index.ts`, `packages/db/scripts/migrate.ts`, `packages/db/scripts/verify.ts`
- Generate: `packages/db/migrations/0001_foundation.sql` (via drizzle-kit, then hand-review)

Column rules (mirror `docs/postgres-schema.sql` exactly, plus three new tables): ids `uuid PRIMARY KEY DEFAULT gen_random_uuid()`, timestamps `timestamptz NOT NULL DEFAULT now()`, money-like BAC as `numeric(5,3)`, JSON payloads as `jsonb NOT NULL DEFAULT '{}'`, every FK `ON DELETE` explicit, unique lease guard via partial unique index `WHERE released_at IS NULL`.

- [ ] **Step 1: Write `packages/db/src/schema.ts`** (complete file, no omissions)

```ts
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const orgType = pgEnum("org_type", ["personal", "team"]);
export const membershipRole = pgEnum("membership_role", [
  "owner",
  "admin",
  "operator",
  "viewer",
]);
export const inviteStatus = pgEnum("invite_status", [
  "pending",
  "accepted",
  "revoked",
  "expired",
]);
export const deviceStatus = pgEnum("device_status", [
  "provisioned",
  "active",
  "retired",
]);
export const sessionStatus = pgEnum("session_status", [
  "pending",
  "awaiting_blow",
  "analyzing",
  "completed",
  "failed",
  "expired",
]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: varchar("email", { length: 320 }).notNull().unique(),
  displayName: varchar("display_name", { length: 120 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: orgType("type").notNull(),
  name: varchar("name", { length: 160 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const organizationMemberships = pgTable(
  "organization_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: membershipRole("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_membership_org_user").on(t.organizationId, t.userId),
    index("ix_membership_user").on(t.userId),
  ],
);

export const teamInvites = pgTable(
  "team_invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: varchar("email", { length: 320 }).notNull(),
    role: membershipRole("role").notNull(),
    status: inviteStatus("status").notNull().default("pending"),
    tokenHash: text("token_hash").notNull().unique(),
    invitedBy: uuid("invited_by").references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ix_invites_org_status").on(t.organizationId, t.status)],
);

export const devices = pgTable(
  "devices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    serialNumber: varchar("serial_number", { length: 64 }).notNull().unique(),
    model: varchar("model", { length: 16 }).notNull().default("C6"),
    status: deviceStatus("status").notNull().default("provisioned"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ix_devices_org").on(t.organizationId)],
);

export const testSessions = pgTable(
  "test_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "restrict" }),
    operatorUserId: uuid("operator_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    subjectUserId: uuid("subject_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    status: sessionStatus("status").notNull().default("pending"),
    clientSessionId: varchar("client_session_id", { length: 64 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 64 }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_session_client").on(t.deviceId, t.clientSessionId),
    index("ix_sessions_org_status").on(t.organizationId, t.status),
  ],
);

export const deviceLeases = pgTable(
  "device_leases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => testSessions.id, { onDelete: "cascade" }),
    holderUserId: uuid("holder_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull().defaultNow(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("uq_lease_one_holder").on(t.deviceId).where(sql`released_at IS NULL`),
    index("ix_leases_session").on(t.sessionId),
  ],
);

export const bacReadings = pgTable(
  "bac_readings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => testSessions.id, { onDelete: "restrict" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    bacPromille: numeric("bac_promille", { precision: 5, scale: 3 }).notNull(),
    deviceSerial: varchar("device_serial", { length: 64 }).notNull(),
    operatorUserId: uuid("operator_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    subjectUserId: uuid("subject_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    origin: varchar("origin", { length: 24 }).notNull().default("managed"),
    rawPayload: jsonb("raw_payload").notNull().default({}),
    measuredAt: timestamp("measured_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ix_readings_org_measured").on(t.organizationId, t.measuredAt),
    index("ix_readings_subject").on(t.subjectUserId),
    check("ck_readings_bac_range", sql`bac_promille >= 0 AND bac_promille <= 10`),
  ],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    action: varchar("action", { length: 64 }).notNull(),
    entityType: varchar("entity_type", { length: 64 }).notNull(),
    entityId: uuid("entity_id"),
    details: jsonb("details").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ix_audit_org_created").on(t.organizationId, t.createdAt)],
);

export const bactrackIdentities = pgTable(
  "bactrack_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    providerUserId: uuid("provider_user_id").notNull(),
    providerOrganizationId: uuid("provider_organization_id"),
    encryptedRefresh: text("encrypted_refresh"),
    tokenKeyVersion: integer("token_key_version").notNull().default(1),
    linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("uq_identity_provider_user").on(t.providerUserId)],
);

export const magicLinks = pgTable(
  "magic_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ix_magic_user").on(t.userId)],
);

export const outbox = pgTable(
  "outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    aggregateType: varchar("aggregate_type", { length: 64 }).notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    eventType: varchar("event_type", { length: 64 }).notNull(),
    payload: jsonb("payload").notNull().default({}),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ix_outbox_unpublished").on(t.publishedAt)],
);
```

- [ ] **Step 2: Write `packages/db/src/index.ts`**

```ts
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";

export * from "./schema.js";

let pool: Pool | undefined;

export function getPool(connectionString: string): Pool {
  if (!pool) {
    pool = new Pool({ connectionString, max: 10 });
  }
  return pool;
}

export function getDb(connectionString: string): NodePgDatabase<typeof schema> {
  return drizzle(getPool(connectionString), { schema });
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}
```

- [ ] **Step 3: Generate the migration SQL**

Run: `$env:DATABASE_URL="postgres://bactrackmanager:123456789bA+bactrackmanager@192.168.21.2:5432/bactrackmanager"; pnpm --filter @bactrack/db db:generate`
Expected: `packages/db/migrations/0001_*.sql` created plus `meta/` journal. Rename the SQL file to `0001_foundation.sql` and update the journal `_snapshot` reference if drizzle-kit names it differently (keep the journal consistent: edit `meta/_journal.json` entry `idx`/`when` untouched, only the filename if renamed).

- [ ] **Step 4: Hand-review the SQL** — open `0001_foundation.sql` and confirm: `CREATE TYPE` for all five enums, eleven `CREATE TABLE`, partial unique index with `WHERE released_at IS NULL`, BAC range CHECK, then commit the reviewed file. Do NOT apply yet.

- [ ] **Step 5: Write `packages/db/scripts/migrate.ts`**

```ts
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getPool, closePool } from "../src/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

const pool = getPool(url);
const files = readdirSync(root).filter((f) => f.endsWith(".sql")).sort();
for (const f of files) {
  console.log(`applying ${f}`);
  await pool.query(readFileSync(join(root, f), "utf8"));
}
console.log(`applied ${files.length} migration(s)`);
await closePool();
```

- [ ] **Step 6: Write `packages/db/scripts/verify.ts`** — asserts, never mutates:

```ts
import { getPool, closePool } from "../src/index.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

const expectedTables = [
  "users", "organizations", "organization_memberships", "team_invites",
  "devices", "test_sessions", "device_leases", "bac_readings", "audit_log",
  "bactrack_identities", "magic_links", "outbox",
];
const expectedIndexes = [
  "uq_membership_org_user", "uq_session_client", "uq_lease_one_holder",
  "uq_identity_provider_user",
];

let failed = 0;
const pool = getPool(url);

const { rows: tables } = await pool.query(
  "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
);
const have = new Set(tables.map((r) => r.tablename as string));
for (const t of expectedTables) {
  const ok = have.has(t);
  console.log(`${ok ? "PASS" : "FAIL"} table ${t}`);
  if (!ok) failed++;
}

const { rows: idx } = await pool.query("SELECT indexname FROM pg_indexes WHERE schemaname = 'public'");
const haveIdx = new Set(idx.map((r) => r.indexname as string));
for (const i of expectedIndexes) {
  const ok = haveIdx.has(i);
  console.log(`${ok ? "PASS" : "FAIL"} index ${i}`);
  if (!ok) failed++;
}

await closePool();
if (failed > 0) {
  console.error(`${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("ALL CHECKS PASSED");
```

- [ ] **Step 7: Apply to the empty dev DB and verify** (safe: DB has 0 tables, confirmed 2026-09-03)

Run: `$env:DATABASE_URL="postgres://bactrackmanager:123456789bA+bactrackmanager@192.168.21.2:5432/bactrackmanager"; pnpm --filter @bactrack/db db:migrate`
Expected: `applying 0001_foundation.sql` then `applied 1 migration(s)`.
Run: `$env:DATABASE_URL="postgres://bactrackmanager:123456789bA+bactrackmanager@192.168.21.2:5432/bactrackmanager"; pnpm --filter @bactrack/db db:verify`
Expected: 16 PASS lines + `ALL CHECKS PASSED`.
Re-run migrate once more to prove rerun behavior is understood (plain SQL without guards will error on re-apply — record that outcome in the commit message; guard migration comes in plan 2 with the migrate-up ledger).

- [ ] **Step 8: Commit**

Run: `git add packages/db && git commit -m "feat(db): schema v1 and foundation migration, verified on dev DB" && git status --short`
Expected: clean tree.

---

### Task 5: API skeleton with tested health contract

**Files:**
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/src/main.ts`, `apps/api/src/config.ts`, `apps/api/src/app.module.ts`, `apps/api/src/health/health.controller.ts`, `apps/api/src/common/http-error.filter.ts`, `apps/api/test/health.e2e.spec.ts`, `apps/api/vitest.config.ts`

- [ ] **Step 1: Create `apps/api/package.json`**

```json
{
  "name": "@bactrack/api",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsx watch src/main.ts",
    "start": "node dist/main.js",
    "test": "vitest run",
    "lint": "tsc --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "@bactrack/db": "workspace:*",
    "@nestjs/common": "^11.0.0",
    "@nestjs/core": "^11.0.0",
    "@nestjs/platform-express": "^11.0.0",
    "pg": "^8.13.1",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.1",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^22.7.0",
    "supertest": "^7.0.0",
    "tsx": "^4.19.2",
    "typescript": "^5.6.3",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `apps/api/tsconfig.json` and `apps/api/vitest.config.ts`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node"],
    "emitDecoratorMetadata": true,
    "experimentalDecorators": true
  },
  "include": ["src"]
}
```

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.spec.ts"], testTimeout: 30000 },
});
```

- [ ] **Step 3: Create `apps/api/src/config.ts`**

```ts
import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3001),
  API_VERSION: z.string().default("0.1.0"),
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return schema.parse(env);
}
```

- [ ] **Step 4: Create `apps/api/src/common/http-error.filter.ts`**

```ts
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse();
    const requestId = randomUUID();
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    const message =
      exception instanceof HttpException
        ? (exception.getResponse() as { message?: unknown }).message ?? exception.message
        : "Internal server error";
    res.status(status).json({ error: { code: status, message, requestId } });
  }
}
```

- [ ] **Step 5: Create health controller + module + bootstrap**

`apps/api/src/health/health.controller.ts`:

```ts
import { Controller, Get } from "@nestjs/common";
import { getPool } from "@bactrack/db";

@Controller()
export class HealthController {
  @Get("health")
  async health(): Promise<{ status: string; db: string }> {
    const pool = getPool(process.env.DATABASE_URL as string);
    await pool.query("SELECT 1");
    return { status: "ok", db: "up" };
  }

  @Get("version")
  version(): { version: string } {
    return { version: process.env.API_VERSION ?? "0.1.0" };
  }
}
```

`apps/api/src/app.module.ts`:

```ts
import { Module } from "@nestjs/common";
import { HealthController } from "./health/health.controller.js";

@Module({ controllers: [HealthController] })
export class AppModule {}
```

`apps/api/src/main.ts`:

```ts
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { HttpErrorFilter } from "./common/http-error.filter.js";
import { loadConfig } from "./config.js";

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule);
  app.useGlobalFilters(new HttpErrorFilter());
  await app.listen(config.PORT);
  // eslint-disable-next-line no-console
  console.log(`api listening on ${config.PORT}`);
}

void bootstrap();
```

- [ ] **Step 6: Write failing e2e test first (TDD)**

`apps/api/test/health.e2e.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import request from "supertest";

const base = process.env.API_E2E_BASE ?? "http://127.0.0.1:3001";

describe("health contract", () => {
  it("GET /health returns ok with db up", async () => {
    const res = await request(base).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", db: "up" });
  });

  it("GET /version returns configured version", async () => {
    const res = await request(base).get("/version");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ version: "0.1.0" });
  });

  it("unknown route uses error envelope", async () => {
    const res = await request(base).get("/nope");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe(404);
    expect(typeof res.body.error.requestId).toBe("string");
  });
});
```

Run: `pnpm --filter @bactrack/api test`
Expected: FAIL (connection refused — app does not exist yet). This is the correct TDD red.

- [ ] **Step 7: Install, build, run, test green**

Run: `pnpm install`
Expected: no errors.
Run: `pnpm --filter @bactrack/api build`
Expected: `apps/api/dist/main.js` exists.
Run in background: `$env:DATABASE_URL="postgres://bactrackmanager:123456789bA+bactrackmanager@192.168.21.2:5432/bactrackmanager"; $env:API_VERSION="0.1.0"; pnpm --filter @bactrack/api start`
Expected: `api listening on 3001`.
Run: `$env:API_E2E_BASE="http://127.0.0.1:3001"; pnpm --filter @bactrack/api test`
Expected: 3 passed. Stop the background app afterwards.

- [ ] **Step 8: Commit**

Run: `git add apps/api && git commit -m "feat(api): health and version contract with error envelope" && git status --short`
Expected: clean tree.

---

### Task 6: CI + README + close-out

**Files:**
- Create: `.github/workflows/ci.yml`, `README.md`

- [ ] **Step 1: Create `.github/workflows/ci.yml`**

```yaml
name: ci
on:
  push:
    branches: [main]
  pull_request:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9.15.0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: pnpm lint
      - run: pnpm --filter @bactrack/api test
        env:
          API_E2E_BASE: http://127.0.0.1:3001
```

Note: CI runs the API e2e against a started server in a later plan once a postgres service + pre-start step is added; if the test step fails on a runner without the API running, start the API in a background step before tests as the first fix (do not delete the tests).

- [ ] **Step 2: Create `README.md`**

```markdown
# BACTrackManager

Team breathalyzer management: supervised BACtrack capture, history, and review.

## Run (home-lab host with Docker)

1. `cp .env.example .env` and set `POSTGRES_PASSWORD`.
2. `docker compose up -d --build`
3. API: `http://<host>:3001/health`

## Develop (Windows)

1. `corepack enable && corepack prepare pnpm@9.15.0 --activate`
2. `pnpm install`
3. Set `DATABASE_URL` to the dev Postgres, then `pnpm db:migrate && pnpm db:verify`.
4. `pnpm --filter @bactrack/api dev`

## Docs

- `PLAN.md` — full vision and phase map.
- `docs/superpowers/specs/2026-09-03-bactrack-capture-design.md` — approved capture-first design.
```

- [ ] **Step 3: Final full check + commit**

Run: `pnpm build && pnpm lint`
Expected: both green.
Run: `git add .github README.md && git commit -m "chore: CI workflow and README" && git log --oneline -8 && git status --short`
Expected: clean tree, 8+ commits visible.

---

## Self-review

**Spec coverage:** Spec sections mapped: S2 backend slice starts here (auth/tenancy/device/session/readings/audit tables all in Task 4; API skeleton Task 5). S1 survey app is plan 5. Hybrid auth tables (`bactrack_identities`, `magic_links`) land now so plan 3 needs no re-migration for auth. Consumer import uses `bac_readings.origin` + `rawPayload` (plan 4). Dawarich untouched per deferral. Outbox table included for plan 2 SSE/worker events.

**Placeholder scan:** No TBD/TODO; every command has exact args and expected output; Task 2 documents the Docker-missing outcome instead of assuming Docker. Version pins exact with caret ranges standard for pnpm.

**Type consistency:** Table names and enums match `docs/postgres-schema.sql` vocabulary (`organization_memberships`, `team_invites`, `device_leases`, `bac_readings`, `audit_log`). `@bactrack/db` export path `./src/index.ts` matches the `exports` map and the API import. `DATABASE_URL` name consistent across compose, drizzle config, scripts, and README. Error envelope `{error:{code,message,requestId}}` matches the e2e assertion.
