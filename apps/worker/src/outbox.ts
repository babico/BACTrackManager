import { getPool } from "@bactrack/db";

export async function prunePublished(connectionString: string, olderThanDays: number): Promise<{ deleted: number }> {
  const pool = getPool(connectionString);
  const res = await pool.query(
    "DELETE FROM outbox WHERE published_at IS NOT NULL AND published_at < now() - ($1 || ' days')::interval",
    [String(olderThanDays)],
  );
  return { deleted: res.rowCount ?? 0 };
}
