import { Body, Controller, Delete, Get, HttpCode, Inject, Post, Query, UnprocessableEntityException, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { CurrentUser, OrgContext } from "../identity/current-user.js";
import { assertMembership } from "../identity/membership.js";
import { parseBody } from "../common/zod-body.js";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { DawarichService } from "./dawarich.service.js";

const connectSchema = z.object({
  baseUrl: z.string().url().max(200),
  apiKey: z.string().min(8).max(200),
});

@UseGuards(JwtAuthGuard)
@Controller("dawarich")
export class DawarichController {
  constructor(@Inject(DawarichService) private readonly daw: DawarichService) {}

  @Post("connect")
  @HttpCode(200)
  async connect(@CurrentUser() ctx: OrgContext, @Body() body: unknown) {
    await assertMembership(ctx.organizationId, ctx.userId);
    const dto = parseBody(connectSchema, body);
    return this.daw.connect(ctx.userId, dto.baseUrl, dto.apiKey);
  }

  @Get("status")
  async status(@CurrentUser() ctx: OrgContext) {
    await assertMembership(ctx.organizationId, ctx.userId);
    return this.daw.status(ctx.userId);
  }

  @Delete("disconnect")
  async disconnect(@CurrentUser() ctx: OrgContext) {
    await assertMembership(ctx.organizationId, ctx.userId);
    return this.daw.disconnect(ctx.userId);
  }

  @Get("timeline")
  async timeline(@CurrentUser() ctx: OrgContext, @Query("from") from: string, @Query("to") to: string) {
    await assertMembership(ctx.organizationId, ctx.userId);
    if (!from || !to) throw new UnprocessableEntityException("from and to are required");
    return this.daw.timeline(ctx.userId, ctx.organizationId, from, to);
  }

  @Get("team-timeline")
  async teamTimeline(@CurrentUser() ctx: OrgContext, @Query("from") from: string, @Query("to") to: string) {
    await assertMembership(ctx.organizationId, ctx.userId);
    if (!from || !to) throw new UnprocessableEntityException("from and to are required");
    return this.daw.teamTimeline(ctx.organizationId, ctx.userId, from, to);
  }
}
