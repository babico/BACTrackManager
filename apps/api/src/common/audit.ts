import { auditLog } from "@bactrack/db";

export async function appendAudit(
  db: {
    insert: (table: typeof auditLog) => {
      values: (v: Record<string, unknown>) => Promise<unknown>;
    };
  },
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
