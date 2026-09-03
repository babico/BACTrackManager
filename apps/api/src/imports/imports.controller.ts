import { Controller, Get, HttpCode, Inject, Post, UseGuards } from "@nestjs/common";
import { CurrentUser, OrgContext } from "../identity/current-user.js";
import { assertMembership } from "../identity/membership.js";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { ImportsService } from "./imports.service.js";

@UseGuards(JwtAuthGuard)
@Controller("imports")
export class ImportsController {
  constructor(@Inject(ImportsService) private readonly imports: ImportsService) {}

  @Post("consumer/run")
  @HttpCode(200)
  async run(@CurrentUser() ctx: OrgContext) {
    await assertMembership(ctx.organizationId, ctx.userId);
    return this.imports.runConsumerImport(ctx.userId, ctx.organizationId);
  }

  @Get("consumer/status")
  async status(@CurrentUser() ctx: OrgContext) {
    await assertMembership(ctx.organizationId, ctx.userId);
    return this.imports.importStatus(ctx.userId);
  }
}
