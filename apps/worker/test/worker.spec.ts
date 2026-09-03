import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { and, auditLog, deviceLeases, eq, getDb, getPool, organizations, organizationMemberships, outbox, devices, testSessions, users } from "@bactrack/db";
import { expireDueSessions } from "../src/sweeper.js";
import { prunePublished } from "../src/outbox.js";

const URL = process.env.DATABASE_URL as string;
const SUFFIX = Date.now().toString(36);

let orgId = "";
let userId = "";
let deviceId = "";
const sessionIds: string[] = [];

async function mkSession(status: "pending" | "completed", expiresAt: Date) {
  const db = getDb(URL);
  const [d] = await db
    .insert(devices)
    .values({ organizationId: orgId, serialNumber: `W-${SUFFIX}-${Math.random().toString(36).slice(2)}`, model: "C6", status: "active" })
    .returning({ id: devices.id });
  const [s] = await db
    .insert(testSessions)
    .values({
      organizationId: orgId,
      deviceId: d.id,
      operatorUserId: userId,
      subjectUserId: userId,
      status,
      clientSessionId: `w-${SUFFIX}-${Math.random().toString(36).slice(2)}`,
      expiresAt,
    })
    .returning({ id: testSessions.id });
  await db.insert(deviceLeases).values({ deviceId: d.id, sessionId: s.id, holderUserId: userId });
  sessionIds.push(s.id);
  return s.id;
}

beforeAll(async () => {
  const db = getDb(URL);
  const [org] = await db.insert(organizations).values({ type: "team", name: `w-${SUFFIX}` }).returning({ id: organizations.id });
  orgId = org.id;
  const [u] = await db.insert(users).values({ email: `${SUFFIX}-w@example.com`, displayName: "W" }).returning({ id: users.id });
  userId = u.id;
  await db.insert(organizationMemberships).values({ organizationId: orgId, userId, role: "owner" });
  const [d] = await db.insert(devices).values({ organizationId: orgId, serialNumber: `W-${SUFFIX}`, model: "C6", status: "active" }).returning({ id: devices.id });
  deviceId = d.id;
});

afterAll(async () => {
  const pool = getPool(URL);
  if (sessionIds.length > 0) {
    await pool.query("DELETE FROM outbox WHERE aggregate_id = ANY($1)", [sessionIds]);
  }
  await pool.query("DELETE FROM organizations WHERE id = $1", [orgId]);
  const { closePool } = await import("@bactrack/db");
  await closePool();
});

describe("sweeper", () => {
  it("expires stale sessions, releases leases, audits + outboxes; rerun is 0", async () => {
    const stale = await mkSession("pending", new Date(Date.now() - 60_000));
    const first = await expireDueSessions(URL);
    expect(first.expired).toBeGreaterThanOrEqual(1);
    const db = getDb(URL);
    const s = await db.select().from(testSessions).where(eq(testSessions.id, stale)).limit(1);
    expect(s[0].status).toBe("expired");
    const leases = await db.select().from(deviceLeases).where(eq(deviceLeases.sessionId, stale)).limit(1);
    expect(leases[0].releasedAt).not.toBeNull();
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.entityId, stale), eq(auditLog.action, "session.expired")));
    expect(audits.length).toBe(1);
    const events = await db.select().from(outbox).where(and(eq(outbox.aggregateId, stale), eq(outbox.eventType, "session.expired")));
    expect(events.length).toBe(1);
    expect((await expireDueSessions(URL)).expired).toBe(0);
  });

  it("leaves terminal and future sessions alone", async () => {
    const done = await mkSession("completed", new Date(Date.now() - 60_000));
    const future = await mkSession("pending", new Date(Date.now() + 3600_000));
    expect((await expireDueSessions(URL)).expired).toBe(0);
    const db = getDb(URL);
    expect((await db.select().from(testSessions).where(eq(testSessions.id, done)).limit(1))[0].status).toBe("completed");
    expect((await db.select().from(testSessions).where(eq(testSessions.id, future)).limit(1))[0].status).toBe("pending");
  });
});

describe("outbox prune", () => {
  it("deletes only old published rows", async () => {
    const pool = getPool(URL);
    const mk = async (publishedAt: string | null) => {
      const r = await pool.query(
        "INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload, published_at) VALUES ('t','00000000-0000-4000-8000-000000000001','e','{}',$1) RETURNING id",
        [publishedAt],
      );
      return r.rows[0].id as string;
    };
    const oldRow = await mk(new Date(Date.now() - 10 * 86400_000).toISOString());
    const recentRow = await mk(new Date().toISOString());
    const unpubRow = await mk(null);
    const res = await prunePublished(URL, 7);
    expect(res.deleted).toBeGreaterThanOrEqual(1);
    const check = async (id: string) => (await pool.query("SELECT id FROM outbox WHERE id = $1", [id])).rows.length;
    expect(await check(oldRow)).toBe(0);
    expect(await check(recentRow)).toBe(1);
    expect(await check(unpubRow)).toBe(1);
    await pool.query("DELETE FROM outbox WHERE id = ANY($1)", [[recentRow, unpubRow]]);
  });
});
