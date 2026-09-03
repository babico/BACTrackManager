import { and, auditLog, deviceLeases, eq, getDb, getPool, outbox, sql, testSessions } from "@bactrack/db";

export async function expireDueSessions(connectionString: string): Promise<{ expired: number }> {
  const db = getDb(connectionString);
  const pool = getPool(connectionString);
  const found = await pool.query("SELECT id FROM test_sessions WHERE status NOT IN ('completed','failed','expired') AND expires_at < now() ORDER BY expires_at ASC LIMIT 100 FOR UPDATE SKIP LOCKED");
  const ids = (found.rows as { id: string }[]).map((r) => r.id);
  let expired = 0;
  for (const id of ids) {
    const done = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM test_sessions WHERE id = ${id} FOR UPDATE`);
      const rows = await tx.select().from(testSessions).where(eq(testSessions.id, id)).limit(1);
      if (rows.length === 0) return false;
      const s = rows[0];
      if (s.status === "completed" || s.status === "failed" || s.status === "expired") return false;
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
      return true;
    });
    if (done) expired++;
  }
  return { expired };
}
