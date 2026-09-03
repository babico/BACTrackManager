import { Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param, Post, Query, UseGuards } from "@nestjs/common";
import { and, bacReadings, desc, eq, getDb, gte, lte } from "@bactrack/db";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { CurrentUser, OrgContext } from "../identity/current-user.js";
import { assertMembership } from "../identity/membership.js";
import { appendAudit } from "../common/audit.js";

@UseGuards(JwtAuthGuard)
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

  @Get(":id")
  async one(@CurrentUser() ctx: OrgContext, @Param("id") id: string) {
    await assertMembership(ctx.organizationId, ctx.userId);
    const db = getDb(process.env.DATABASE_URL as string);
    const rows = await db
      .select()
      .from(bacReadings)
      .where(and(eq(bacReadings.id, id), eq(bacReadings.organizationId, ctx.organizationId)))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException("reading not found");
    return { reading: rows[0] };
  }

  @Post(":id/acknowledge")
  @HttpCode(200)
  async acknowledge(@CurrentUser() ctx: OrgContext, @Param("id") id: string) {
    await assertMembership(ctx.organizationId, ctx.userId);
    const db = getDb(process.env.DATABASE_URL as string);
    const rows = await db
      .select()
      .from(bacReadings)
      .where(and(eq(bacReadings.id, id), eq(bacReadings.organizationId, ctx.organizationId)))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException("reading not found");
    const reading = rows[0];
    if (reading.subjectUserId !== ctx.userId) {
      throw new ForbiddenException("only the subject can acknowledge");
    }
    if (reading.acknowledgedAt !== null) return { reading };
    const [updated] = await db
      .update(bacReadings)
      .set({ acknowledgedAt: new Date(), acknowledgedBy: ctx.userId })
      .where(eq(bacReadings.id, id))
      .returning();
    await appendAudit(db, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: "reading.acknowledged",
      entityType: "reading",
      entityId: id,
      details: {},
    });
    return { reading: updated };
  }
}
