import { Body, Controller, Get, Inject, Param, Post, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { DevIdentityGuard } from "../identity/dev-identity.guard.js";
import { CurrentUser, OrgContext } from "../identity/current-user.js";
import { assertMembership } from "../identity/membership.js";
import { parseBody } from "../common/zod-body.js";
import { SessionsService } from "./sessions.service.js";

const createSchema = z.object({
  deviceId: z.string().uuid(),
  subjectUserId: z.string().uuid(),
  clientSessionId: z.string().min(1).max(64),
  ttlMinutes: z.number().int().min(1).max(1440).default(15),
});
const failSchema = z.object({ reason: z.string().min(1).max(500) });

@UseGuards(DevIdentityGuard)
@Controller("sessions")
export class SessionsController {
  constructor(@Inject(SessionsService) private readonly sessions: SessionsService) {}

  @Post()
  async create(@CurrentUser() ctx: OrgContext, @Body() body: unknown) {
    await assertMembership(ctx.organizationId, ctx.userId);
    const dto = parseBody(createSchema, body);
    return this.sessions.create({ ...dto, organizationId: ctx.organizationId, operatorUserId: ctx.userId });
  }

  @Get(":id")
  async get(@CurrentUser() ctx: OrgContext, @Param("id") id: string) {
    await assertMembership(ctx.organizationId, ctx.userId);
    return this.sessions.get(ctx.organizationId, id);
  }

  @Post(":id/expire")
  async expire(@CurrentUser() ctx: OrgContext, @Param("id") id: string) {
    await assertMembership(ctx.organizationId, ctx.userId);
    return this.sessions.transition(ctx.organizationId, ctx.userId, id, "expired");
  }

  @Post(":id/fail")
  async fail(@CurrentUser() ctx: OrgContext, @Param("id") id: string, @Body() body: unknown) {
    await assertMembership(ctx.organizationId, ctx.userId);
    const dto = parseBody(failSchema, body);
    return this.sessions.transition(ctx.organizationId, ctx.userId, id, "failed", { reason: dto.reason });
  }
}
