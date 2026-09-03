import { ForbiddenException } from "@nestjs/common";
import { and, eq, getDb, organizationMemberships } from "@bactrack/db";

export async function assertMembership(organizationId: string, userId: string): Promise<void> {
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
