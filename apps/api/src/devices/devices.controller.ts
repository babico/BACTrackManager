import { Body, Controller, Get, Inject, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { DevIdentityGuard } from "../identity/dev-identity.guard.js";
import { CurrentUser, OrgContext } from "../identity/current-user.js";
import { assertMembership } from "../identity/membership.js";
import { parseBody } from "../common/zod-body.js";
import { DevicesService } from "./devices.service.js";

const registerSchema = z.object({
  serialNumber: z.string().min(2).max(64),
  model: z.string().min(1).max(16).default("C6"),
});
const statusSchema = z.object({
  status: z.enum(["provisioned", "active", "retired"]),
});

@UseGuards(DevIdentityGuard)
@Controller("devices")
export class DevicesController {
  constructor(@Inject(DevicesService) private readonly devices: DevicesService) {}

  @Post()
  async register(@CurrentUser() ctx: OrgContext, @Body() body: unknown) {
    await assertMembership(ctx.organizationId, ctx.userId);
    const dto = parseBody(registerSchema, body);
    return this.devices.register(ctx.organizationId, dto.serialNumber, dto.model);
  }

  @Get()
  async list(@CurrentUser() ctx: OrgContext) {
    await assertMembership(ctx.organizationId, ctx.userId);
    return this.devices.list(ctx.organizationId);
  }

  @Patch(":id")
  async setStatus(@CurrentUser() ctx: OrgContext, @Param("id") id: string, @Body() body: unknown) {
    await assertMembership(ctx.organizationId, ctx.userId);
    const dto = parseBody(statusSchema, body);
    return this.devices.setStatus(ctx.organizationId, id, dto.status);
  }
}
