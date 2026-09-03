import { ForbiddenException } from "@nestjs/common";
import { and, eq, getDb, organizationMemberships } from "@bactrack/db";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertUuid(value: string): void {
  if (!UUID_RE.test(value)) throw new ForbiddenException("invalid organization");
}

export async function assertMembership(organizationId: string, userId: string): Promise<void> {
  assertUuid(organizationId);
  assertUuid(userId);
  const db = getDb(process.env.DATABASE_URL as string);
  const rows = await db
    .select({ id: organizationMemberships.id })
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.organizationId, organizationId),
        eq(organizationMemberships.userId, userId),
      ),
    )
    .limit(1);
  if (rows.length === 0) {
    throw new ForbiddenException("not a member of this organization");
  }
}
