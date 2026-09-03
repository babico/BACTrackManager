import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { and, bacReadings, desc, eq, getDb, gte, lte } from "@bactrack/db";
import { DevIdentityGuard } from "../identity/dev-identity.guard.js";
import { CurrentUser, OrgContext } from "../identity/current-user.js";
import { assertMembership } from "../identity/membership.js";

@UseGuards(DevIdentityGuard)
@Controller("readings")
export class ReadingsController {
  @Get()
  async list(
    @CurrentUser() ctx: OrgContext,
    @Query("subjectUserId") subjectUserId?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("limit") limitRaw?: string,
  ) {
    await assertMembership(ctx.organizationId, ctx.userId);
    const limit = Math.min(Math.max(parseInt(limitRaw ?? "100", 10) || 100, 1), 1000);
    const conds = [eq(bacReadings.organizationId, ctx.organizationId)];
    if (subjectUserId) conds.push(eq(bacReadings.subjectUserId, subjectUserId));
    if (from) conds.push(gte(bacReadings.measuredAt, new Date(from)));
    if (to) conds.push(lte(bacReadings.measuredAt, new Date(to)));
    const db = getDb(process.env.DATABASE_URL as string);
    const readings = await db
      .select()
      .from(bacReadings)
      .where(and(...conds))
      .orderBy(desc(bacReadings.measuredAt))
      .limit(limit);
    return { readings };
  }
}
