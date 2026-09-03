import { Body, Controller, Get, HttpCode, Inject, Post, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { CurrentUser, OrgContext } from "../identity/current-user.js";
import { assertMembership } from "../identity/membership.js";
import { parseBody } from "../common/zod-body.js";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { AuthService } from "../auth/auth.service.js";
import { OrgsService } from "./orgs.service.js";

const inviteSchema = z.object({
  email: z.string().email().max(320),
  role: z.enum(["admin", "operator", "viewer"]),
});
const acceptSchema = z.object({ token: z.string().min(10) });

@UseGuards(JwtAuthGuard)
@Controller()
export class OrgsController {
  constructor(
    @Inject(OrgsService) private readonly orgs: OrgsService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  @Get("orgs/mine")
  async mine(@CurrentUser() ctx: OrgContext) {
    return this.auth.me(ctx.userId);
  }

  @Get("orgs/members")
  async members(@CurrentUser() ctx: OrgContext) {
    await assertMembership(ctx.organizationId, ctx.userId);
    return this.orgs.members(ctx.organizationId);
  }

  @Post("orgs/invites")
  @HttpCode(200)
  async invite(@CurrentUser() ctx: OrgContext, @Body() body: unknown) {
    await assertMembership(ctx.organizationId, ctx.userId);
    const dto = parseBody(inviteSchema, body);
    return this.orgs.invite(ctx.organizationId, ctx.userId, dto.email, dto.role);
  }

  @Get("orgs/invites")
  async invites(@CurrentUser() ctx: OrgContext) {
    await assertMembership(ctx.organizationId, ctx.userId);
    return this.orgs.pendingInvites(ctx.organizationId, ctx.userId);
  }

  @Post("invites/accept")
  @HttpCode(200)
  async accept(@CurrentUser() ctx: OrgContext, @Body() body: unknown) {
    const dto = parseBody(acceptSchema, body);
    return this.orgs.accept(dto.token, ctx.userId);
  }
}
