import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, Post, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { CurrentUser, OrgContext } from "../identity/current-user.js";
import { assertMembership } from "../identity/membership.js";
import { parseBody } from "../common/zod-body.js";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { PushService } from "./push.service.js";

const subSchema = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
});
const unsubSchema = z.object({ endpoint: z.string().url().max(2000) });

@UseGuards(JwtAuthGuard)
@Controller("push")
export class PushController {
  constructor(@Inject(PushService) private readonly push: PushService) {}

  @Post("subscriptions")
  @HttpCode(201)
  async subscribe(@CurrentUser() ctx: OrgContext, @Body() body: unknown) {
    await assertMembership(ctx.organizationId, ctx.userId);
    const dto = parseBody(subSchema, body);
    try {
      return await this.push.subscribe(ctx.userId, dto.endpoint, dto.keys);
    } catch {
      throw new BadRequestException("invalid subscription");
    }
  }

  @Get("subscriptions")
  async list(@CurrentUser() ctx: OrgContext) {
    await assertMembership(ctx.organizationId, ctx.userId);
    return this.push.list(ctx.userId);
  }

  @Delete("subscriptions")
  async unsubscribe(@CurrentUser() ctx: OrgContext, @Body() body: unknown) {
    const dto = parseBody(unsubSchema, body);
    return this.push.unsubscribe(ctx.userId, dto.endpoint);
  }
}
