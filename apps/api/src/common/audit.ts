import { auditLog } from "@bactrack/db";

interface Inserter {
  insert(table: typeof auditLog): { values(v: unknown): unknown };
}

export async function appendAudit(
  db: Inserter,
  entry: {
    organizationId: string;
    actorUserId: string | null;
    action: string;
    entityType: string;
    entityId?: string;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  await db.insert(auditLog).values({
    organizationId: entry.organizationId,
    actorUserId: entry.actorUserId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    details: entry.details ?? {},
  });
}
