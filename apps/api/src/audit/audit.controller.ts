import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { and, auditLog, desc, eq, getDb } from "@bactrack/db";
import { DevIdentityGuard } from "../identity/dev-identity.guard.js";
import { CurrentUser, OrgContext } from "../identity/current-user.js";
import { assertMembership } from "../identity/membership.js";

@UseGuards(DevIdentityGuard)
@Controller("audit")
export class AuditController {
  @Get()
  async list(
    @CurrentUser() ctx: OrgContext,
    @Query("entityType") entityType?: string,
    @Query("entityId") entityId?: string,
    @Query("limit") limitRaw?: string,
  ) {
    await assertMembership(ctx.organizationId, ctx.userId);
    const limit = Math.min(Math.max(parseInt(limitRaw ?? "100", 10) || 100, 1), 1000);
    const conds = [eq(auditLog.organizationId, ctx.organizationId)];
    if (entityType) conds.push(eq(auditLog.entityType, entityType));
    if (entityId) conds.push(eq(auditLog.entityId, entityId));
    const db = getDb(process.env.DATABASE_URL as string);
    const entries = await db
      .select()
      .from(auditLog)
      .where(and(...conds))
      .orderBy(desc(auditLog.createdAt))
      .limit(limit);
    return { entries };
  }
}
