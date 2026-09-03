# Web Dashboard Implementation Plan (P5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Team members log in (magic link), browse history with filters, open reading detail with operator attribution, acknowledge their own readings, manage devices, invite teammates, and inspect the audit log — against the live backend, tested where a browser isn't required.

**Architecture:** `apps/web` is Next.js 15 (app router) with client components only (no SSR data fetching): a tiny `lib/api.ts` fetch wrapper (localStorage tokens, `x-org-id` header, 401→refresh→retry, same semantics as the mobile `ApiClient`), an `AuthContext` (login state, active org switcher), and one route per screen. Backend gaps closed first: org members, invites (create/list/accept with role checks), reading acknowledgement (subject-only). Map page renders BAC markers on Leaflet (OSM tiles, no key); Dawarich layer stays a stubbed toggle (P8).

**Tech Stack:** Next.js 15, React 19, Leaflet 1.9 (markers only). Vitest for `lib/` unit tests (fetch-mocked). No browser available on this machine — page rendering verified by `next build` + a documented manual checklist, stated honestly in the close-out.

**Plan split:** P5 of the phase plan. Backend P1-P3 live. P6+ (sync worker, import, Dawarich) reuse these routes unchanged.

---

## File structure (this plan)

Backend:

| Path | Responsibility |
|---|---|
| `packages/db/migrations/0005_ack.sql` | `bac_readings.acknowledged_at/by` |
| `packages/db/src/schema.ts` | + ack columns |
| `apps/api/src/orgs/orgs.service.ts` | members, invites create/list/accept, role checks |
| `apps/api/src/orgs/orgs.controller.ts` | `GET /orgs/mine`, `GET /orgs/:id/members`, `POST /orgs/:id/invites`, `GET /orgs/:id/invites`, `POST /invites/accept` |
| `apps/api/src/readings/readings.controller.ts` | + `POST /readings/:id/acknowledge` (subject-only) |
| `apps/api/test/orgs.e2e.spec.ts` | Members/invite/accept/role matrix + ack tests |

Frontend (`apps/web`):

| Path | Responsibility |
|---|---|
| `apps/web/package.json`, `tsconfig.json`, `next.config.ts` | Next 15 scaffold (manual, no create-next-app) |
| `apps/web/src/lib/api.ts` | Fetch wrapper: tokens, org header, refresh-retry |
| `apps/web/src/lib/session.ts` | localStorage token/org store |
| `apps/web/src/app/layout.tsx` | Shell + AuthProvider + org switcher |
| `apps/web/src/app/login/page.tsx` | Magic start form + consume via ?token= |
| `apps/web/src/app/page.tsx` | History table + subject/date filters |
| `apps/web/src/app/readings/[id]/page.tsx` | Detail + Tested-by + ack button |
| `apps/web/src/app/devices/page.tsx` | List + register + activate + release |
| `apps/web/src/app/teams/page.tsx` | Members + invite form + pending invites |
| `apps/web/src/app/audit/page.tsx` | Audit table + entity filter |
| `apps/web/src/app/map/page.tsx` | Leaflet BAC markers (dynamic import, ssr:false) |
| `apps/web/test/api.spec.ts` | lib/api unit tests (fetch-mocked) |

Backend endpoint additions (all Bearer + `x-org-id` via JwtAuthGuard unless noted):

- `GET /orgs/mine` → 200 `{organizations}` (from me() shape, no membership needed beyond login)
- `GET /orgs/:id/members` → 200 `{members:[{userId,email,displayName,role}]}` (member-only)
- `POST /orgs/:id/invites` `{email, role}` → 201 `{invite, devToken?}` (owner/admin only; role ∈ operator/viewer/admin; owner excluded)
- `GET /orgs/:id/invites` → 200 pending list (owner/admin only)
- `POST /invites/accept` `{token}` → 200 `{organizationId}` (public-with-token: NO guard; validates hash, expiry, status; requires logged-in? Accept needs an account — accept while authenticated: guard ON, email must match invite email. Simpler + secure: guard on, compare user email.)
- `POST /readings/:id/acknowledge` → 200 `{reading}` (subject-only: `reading.subjectUserId === userId` else 403; idempotent — second call returns same; sets acknowledged_at/by; audit `reading.acknowledged`)

Invite token: opaque 24B, sha256 in `token_hash`, 7d expiry. Email sending: console log + devToken when flag (same pattern as magic).

---

### Task 1: Backend gaps — members, invites, ack (TDD)

**Files:** migration 0005, schema edit, `orgs.service.ts`, `orgs.controller.ts`, readings controller +ack, module wiring, `orgs.e2e.spec.ts`.

- [ ] **Step 1: Migration + schema.** `0005_ack.sql`:

```sql
ALTER TABLE bac_readings ADD COLUMN IF NOT EXISTS acknowledged_at timestamptz;
ALTER TABLE bac_readings ADD COLUMN IF NOT EXISTS acknowledged_by uuid REFERENCES users(id) ON DELETE SET NULL;
```

Schema: add to `bacReadings`: `acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true })`, `acknowledgedBy: uuid("acknowledged_by").references(() => users.id, { onDelete: "set null" })`.

- [ ] **Step 2: `apps/api/src/orgs/orgs.service.ts`** (complete):

```ts
import { ConflictException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { and, eq, getDb, organizationMemberships, organizations, teamInvites, users } from "@bactrack/db";
import { appendAudit } from "../common/audit.js";
import { hashToken, newOpaqueToken } from "../auth/tokens.js";

const MANAGE_ROLES = ["owner", "admin"] as const;
const INVITE_ROLES = ["admin", "operator", "viewer"] as const;

@Injectable()
export class OrgsService {
  private db() {
    return getDb(process.env.DATABASE_URL as string);
  }

  async roleOf(organizationId: string, userId: string): Promise<string | null> {
    const rows = await this.db()
      .select({ role: organizationMemberships.role })
      .from(organizationMemberships)
      .where(and(eq(organizationMemberships.organizationId, organizationId), eq(organizationMemberships.userId, userId)))
      .limit(1);
    return rows.length > 0 ? rows[0].role : null;
  }

  async members(organizationId: string) {
    const db = this.db();
    const rows = await db
      .select({
        userId: users.id,
        email: users.email,
        displayName: users.displayName,
        role: organizationMemberships.role,
      })
      .from(organizationMemberships)
      .innerJoin(users, eq(users.id, organizationMemberships.userId))
      .where(eq(organizationMemberships.organizationId, organizationId));
    return { members: rows };
  }

  async invite(organizationId: string, actorUserId: string, email: string, role: string) {
    if (!(INVITE_ROLES as readonly string[]).includes(role)) {
      throw new ConflictException("invalid role");
    }
    const actorRole = await this.roleOf(organizationId, actorUserId);
    if (!actorRole || !(MANAGE_ROLES as readonly string[]).includes(actorRole)) {
      throw new ForbiddenException("invite requires owner or admin");
    }
    const normalized = email.toLowerCase().trim();
    const token = newOpaqueToken(24);
    const [invite] = await this.db()
      .insert(teamInvites)
      .values({
        organizationId,
        email: normalized,
        role: role as "admin" | "operator" | "viewer",
        invitedBy: actorUserId,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      })
      .returning();
    await appendAudit(this.db(), {
      organizationId,
      actorUserId,
      action: "invite.created",
      entityType: "invite",
      entityId: invite.id,
      details: { email: normalized, role },
    });
    const masked = normalized.replace(/^(.).*(@.*)$/, "$1***$2");
    // eslint-disable-next-line no-console
    console.log(`invite for ${masked} ready`);
    if (process.env.ALLOW_DEV_MAGIC_TOKEN === "true") {
      return { invite, devToken: token };
    }
    return { invite };
  }

  async pendingInvites(organizationId: string, actorUserId: string) {
    const actorRole = await this.roleOf(organizationId, actorUserId);
    if (!actorRole || !(MANAGE_ROLES as readonly string[]).includes(actorRole)) {
      throw new ForbiddenException("invite list requires owner or admin");
    }
    const rows = await this.db()
      .select()
      .from(teamInvites)
      .where(and(eq(teamInvites.organizationId, organizationId), eq(teamInvites.status, "pending")));
    return { invites: rows };
  }

  async accept(token: string, userId: string) {
    const db = this.db();
    const rows = await db.select().from(teamInvites).where(eq(teamInvites.tokenHash, hashToken(token))).limit(1);
    if (rows.length === 0) throw new NotFoundException("invite not found");
    const invite = rows[0];
    if (invite.status !== "pending" || invite.expiresAt.getTime() < Date.now()) {
      throw new ConflictException("invite expired or used");
    }
    const me = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (me[0].email !== invite.email) {
      throw new ForbiddenException("invite belongs to a different email");
    }
    await db.transaction(async (tx) => {
      await tx.insert(organizationMemberships).values({ organizationId: invite.organizationId, userId, role: invite.role }).onConflictDoNothing();
      await tx.update(teamInvites).set({ status: "accepted" }).where(eq(teamInvites.id, invite.id));
      await appendAudit(tx, {
        organizationId: invite.organizationId,
        actorUserId: userId,
        action: "invite.accepted",
        entityType: "invite",
        entityId: invite.id,
        details: {},
      });
    });
    return { organizationId: invite.organizationId };
  }
}
```

Note `role: invite.role` type: drizzle infers enum union — `onConflictDoNothing()` needs the uq constraint — works (any conflict → skip; membership unique is the only one on that table... team_invites has unique token_hash but we insert memberships — fine).

`me[0]` — user from guard always exists; add guard `if (me.length === 0) throw new UnauthorizedException(...)`. Include it.

- [ ] **Step 3: `apps/api/src/orgs/orgs.controller.ts`**:

```ts
import { Body, Controller, Get, Inject, Param, Post, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { CurrentUser, OrgContext } from "../identity/current-user.js";
import { assertMembership } from "../identity/membership.js";
import { parseBody } from "../common/zod-body.js";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { OrgsService } from "./orgs.service.js";
import { AuthService } from "../auth/auth.service.js";

const inviteSchema = z.object({
  email: z.string().email().max(320),
  role: z.enum(["admin", "operator", "viewer"]),
});
const acceptSchema = z.object({ token: z.string().min(10) });

@UseGuards(JwtAuthGuard)
@Controller()
export class OrgsController {
  constructor(
    @Inject(OrgsService) private readonly orgs: OrgsService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  @Get("orgs/mine")
  async mine(@CurrentUser() ctx: OrgContext) {
    return this.auth.me(ctx.userId);
  }

  @Get("orgs/:id/members")
  async members(@CurrentUser() ctx: OrgContext, @Param("id") id: string) {
    await assertMembership(ctx.organizationId, ctx.userId);
    if (id !== ctx.organizationId) throw new (await import("@nestjs/common")).ForbiddenException("org mismatch");
    return this.orgs.members(id);
  }
```

Hmm — the dynamic import is ugly. Import ForbiddenException statically. And the org-mismatch pattern repeats: routes take `:id` but guard already binds org — SIMPLIFY: drop `:id` params, use ctx.organizationId everywhere except accept (no org yet). Cleaner routes:

- `GET /orgs/mine`, `GET /orgs/members`, `POST /orgs/invites`, `GET /orgs/invites`, `POST /invites/accept`. No mismatch class. Use this.

```ts
@UseGuards(JwtAuthGuard)
@Controller()
export class OrgsController {
  constructor(
    @Inject(OrgsService) private readonly orgs: OrgsService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  @Get("orgs/mine")
  async mine(@CurrentUser() ctx: OrgContext) {
    return this.auth.me(ctx.userId);
  }

  @Get("orgs/members")
  async members(@CurrentUser() ctx: OrgContext) {
    await assertMembership(ctx.organizationId, ctx.userId);
    return this.orgs.members(ctx.organizationId);
  }

  @Post("orgs/invites")
  @HttpCode(200)
  async invite(@CurrentUser() ctx: OrgContext, @Body() body: unknown) {
    await assertMembership(ctx.organizationId, ctx.userId);
    const dto = parseBody(inviteSchema, body);
    return this.orgs.invite(ctx.organizationId, ctx.userId, dto.email, dto.role);
  }

  @Get("orgs/invites")
  async invites(@CurrentUser() ctx: OrgContext) {
    await assertMembership(ctx.organizationId, ctx.userId);
    return this.orgs.pendingInvites(ctx.organizationId, ctx.userId);
  }

  @Post("invites/accept")
  @HttpCode(200)
  async accept(@CurrentUser() ctx: OrgContext, @Body() body: unknown) {
    const dto = parseBody(acceptSchema, body);
    return this.orgs.accept(dto.token, ctx.userId);
  }
}
```

(Add HttpCode import.)

- [ ] **Step 4: Ack + single-reading GET in readings controller** — ack method as below, plus:

```ts
@Post(":id/acknowledge")
@HttpCode(200)
async acknowledge(@CurrentUser() ctx: OrgContext, @Param("id") id: string) {
  await assertMembership(ctx.organizationId, ctx.userId);
  const db = getDb(process.env.DATABASE_URL as string);
  const rows = await db.select().from(bacReadings).where(and(eq(bacReadings.id, id), eq(bacReadings.organizationId, ctx.organizationId))).limit(1);
  if (rows.length === 0) throw new NotFoundException("reading not found");
  const reading = rows[0];
  if (reading.subjectUserId !== ctx.userId) throw new ForbiddenException("only the subject can acknowledge");
  if (reading.acknowledgedAt !== null) return { reading };
  const [updated] = await db.update(bacReadings).set({ acknowledgedAt: new Date(), acknowledgedBy: ctx.userId }).where(eq(bacReadings.id, id)).returning();
  await appendAudit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "reading.acknowledged", entityType: "reading", entityId: id, details: {} });
  return { reading: updated };
}

```ts
@Get(":id")
async one(@CurrentUser() ctx: OrgContext, @Param("id") id: string) {
  await assertMembership(ctx.organizationId, ctx.userId);
  const db = getDb(process.env.DATABASE_URL as string);
  const rows = await db.select().from(bacReadings).where(and(eq(bacReadings.id, id), eq(bacReadings.organizationId, ctx.organizationId))).limit(1);
  if (rows.length === 0) throw new NotFoundException("reading not found");
  return { reading: rows[0] };
}
```

(Add imports: HttpCode, Post, Param, ForbiddenException, NotFoundException, appendAudit.)

- [ ] **Step 5: Module wiring** — add OrgsController + OrgsService.

- [ ] **Step 6: `apps/api/test/orgs.e2e.spec.ts`** — own app bootstrap + unique org/users via AuthService registerOrLogin? Needs memberships in a team org: create via drizzle directly (same pattern as capture spec helper — duplicate the small helper, fine). Matrix:
  1. members lists owner (operator creates team org? helper creates team org + 2 users like capture).
  2. invite by owner → 200 + devToken; invitee (new magic user with SAME email) accepts → membership exists → 200; accept twice → 409.
  3. viewer cannot invite → 403. (Need viewer membership: insert with role viewer directly.)
  4. invite wrong email → 403 on accept.
  5. ack: complete a session for subject → subject acks → 200 with acknowledgedAt; operator ack → 403; ack twice idempotent.
  Reuse device/session creation via HTTP like capture spec (needs auth headers — mint via container AuthService like capture spec).

- [ ] **Step 7: Migrate + verify + full suite + commit** `feat(api): org members, invites and reading ack`.

---

### Task 2: Web scaffold + lib + auth + history (TDD where possible)

**Files:** per structure table (scaffold through `readings/[id]`).

- [ ] **Step 1: `apps/web/package.json`**

```json
{
  "name": "@bactrack/web",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "build": "next build",
    "dev": "next dev -p 3100",
    "start": "next start -p 3100",
    "test": "vitest run",
    "lint": "tsc --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "leaflet": "^1.9.4",
    "next": "^15.1.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@types/leaflet": "^1.9.12",
    "@types/node": "^22.7.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "typescript": "^5.6.3",
    "vitest": "^2.1.0"
  }
}
```

`tsconfig.json` (Next App Router needs `jsx: preserve`, `paths @/*`):

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

`next.config.ts`: `import type { NextConfig } from "next"; const config: NextConfig = { env: { API_BASE: process.env.API_BASE ?? "http://127.0.0.1:3001" } }; export default config;`

Hmm — API base must be runtime-configurable: use `NEXT_PUBLIC_API_BASE` with default `http://127.0.0.1:3001`. NEXT_PUBLIC inlines at build; document rebuild for other hosts (home-lab: build arg). Acceptable MVP.

- [ ] **Step 2: `src/lib/session.ts`**

```ts
export interface SessionTokens { accessToken: string; refreshToken: string; }

const A_KEY = "bactrack.access";
const R_KEY = "bactrack.refresh";
const O_KEY = "bactrack.org";
const U_KEY = "bactrack.user";

export const sessionStore = {
  load(): SessionTokens | null {
    const a = localStorage.getItem(A_KEY);
    const r = localStorage.getItem(R_KEY);
    return a && r ? { accessToken: a, refreshToken: r } : null;
  },
  save(t: SessionTokens): void {
    localStorage.setItem(A_KEY, t.accessToken);
    localStorage.setItem(R_KEY, t.refreshToken);
  },
  clear(): void {
    localStorage.removeItem(A_KEY);
    localStorage.removeItem(R_KEY);
    localStorage.removeItem(O_KEY);
    localStorage.removeItem(U_KEY);
  },
  org(): string | null { return localStorage.getItem(O_KEY); },
  setOrg(id: string): void { localStorage.setItem(O_KEY, id); },
  user(): { id: string; email: string } | null {
    const raw = localStorage.getItem(U_KEY);
    return raw ? (JSON.parse(raw) as { id: string; email: string }) : null;
  },
  setUser(u: { id: string; email: string }): void { localStorage.setItem(U_KEY, JSON.stringify(u)); },
};
```

- [ ] **Step 3: `src/lib/api.ts`** (mirror mobile client semantics):

```ts
import { sessionStore } from "./session.js";

export interface ApiError { status: number; message: string; }

const base = () => process.env.NEXT_PUBLIC_API_BASE ?? "http://127.0.0.1:3001";

async function refresh(): Promise<boolean> {
  const s = sessionStore.load();
  if (!s) return false;
  const res = await fetch(`${base()}/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: s.refreshToken }),
  });
  if (!res.ok) {
    sessionStore.clear();
    return false;
  }
  const pair = (await res.json()) as { accessToken: string; refreshToken: string };
  sessionStore.save(pair);
  return true;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const call = async (): Promise<Response> => {
    const s = sessionStore.load();
    const org = sessionStore.org();
    return fetch(`${base()}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(s ? { Authorization: `Bearer ${s.accessToken}` } : {}),
        ...(org ? { "x-org-id": org } : {}),
        ...(init?.headers ?? {}),
      },
    });
  };
  let res = await call();
  if (res.status === 401 && sessionStore.load()) {
    if (await refresh()) res = await call();
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    const err: ApiError = { status: res.status, message: data.error?.message ?? "request failed" };
    throw err;
  }
  return (await res.json()) as T;
}

export const apiPost = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
export const apiGet = <T>(path: string) => api<T>(path);
```

Careful: public routes (magic/start) with no session — `sessionStore.load()` null → no header; 401 without session → no refresh attempt (guard `&& sessionStore.load()`). Good.

- [ ] **Step 4: Unit tests first** — `test/api.spec.ts` (localStorage stub + fetch stub): header injection, 401→refresh→retry with new token saved, refresh-fail clears + throws 401. localStorage in vitest node env: stub minimal `{getItem,setItem,removeItem}` object on globalThis. Write tests → FAIL → write lib → GREEN.

- [ ] **Step 5: Pages** — layout (nav + org switcher loading `/auth/me`), login (start form; if `devToken` in response auto-consume; consume via `?token=` search param on mount), history (filters: subject select from `/orgs/members`, from/to date inputs → `/readings?...`), detail (`/readings/:id` — hmm, backend has NO single-reading GET! Add `GET /readings/:id` to readings controller in Task 1 (org-scoped, 404). Include in Task 1 scope.)

Detail shows bac, measuredAt, deviceSerial, origin, operator vs subject (resolve names via members map), ack state + ack button when subject==me and not acked.

- [ ] **Step 6: `next build`** green + commit `feat(web): auth, history, reading detail`.

---

### Task 3: Devices, teams, audit, map pages

- Devices page: list, register form (serial+model), activate button (PATCH active), release button (POST release), status badges.
- Teams page: members table, invite form (email+role), pending invites list.
- Audit page: entityType/entityId filters + table.
- Map page: `next/dynamic` Leaflet, `ssr: false`; fetch readings with limit 1000, plot markers with bac popup; OSM tiles; note tile-policy comment.
- Manual checklist in `apps/web/MANUAL_CHECKLIST.md` (login, history filter, ack, invite accept across two users, map renders).
- Commit `feat(web): devices, teams, audit and map pages`.

---

### Task 4: Close-out

- `pnpm build && pnpm lint`, api suite + web unit suite green, commit pending, update design doc (map markers live, Dawarich toggle stubbed).

---

## Self-review

**Spec coverage:** S2 web slice: auth (magic; BACtrack button deferred to P7 live probe — login page notes it), personal/team history + filters, detail with Tested-by attribution, subject ack, devices, invites, audit, BAC-only markers. CSV/PDF/exports → P9. Notifications/kiosk → P9.
**Placeholder scan:** No TBD; exact code/commands. Manual checklist is explicit about what automation doesn't cover.
**Type consistency:** `x-org-id` header everywhere; error envelope `{error:{code,message}}` parsed uniformly; org shape `{id,name,type,role}` shared between me() and switcher; invite roles match backend enum.
