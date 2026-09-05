import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { z } from "zod";
import { CurrentUser, OrgContext } from "../identity/current-user.js";
import { parseBody } from "../common/zod-body.js";
import { AuthService } from "./auth.service.js";
import { JwtAuthGuard } from "./jwt-auth.guard.js";

const emailSchema = z.object({ email: z.string().email().max(320) });
const refreshSchema = z.object({ refreshToken: z.string().min(10) });
const startSchema = z.object({ redirectUri: z.string().url().max(500) });

@Controller("auth")
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Post("magic/start")
  @HttpCode(200)
  @Throttle({ auth: { limit: 20, ttl: 60000 } })
  async magicStart(@Body() body: unknown) {
    const dto = parseBody(emailSchema, body);
    return this.auth.magicStart(dto.email);
  }

  @Get("magic/consume")
  @Throttle({ auth: { limit: 20, ttl: 60000 } })
  async magicConsume(@Query("token") token: string) {
    if (!token) throw new BadRequestException("token is required");
    const { pair, user } = await this.auth.magicConsume(token);
    return { ...pair, user };
  }

  @Post("bactrack/start")
  @HttpCode(200)
  @Throttle({ auth: { limit: 20, ttl: 60000 } })
  async bactrackStart(@Body() body: unknown) {
    const dto = parseBody(startSchema, body);
    return this.auth.bactrackStart(dto.redirectUri);
  }

  @Get("bactrack/callback")
  @Throttle({ auth: { limit: 20, ttl: 60000 } })
  async bactrackCallback(
    @Query("code") code: string,
    @Query("state") state: string,
    @Query("redirect_uri") redirectUri: string,
  ) {
    if (!code || !state || !redirectUri) {
      throw new BadRequestException("code, state and redirect_uri are required");
    }
    const { pair, user } = await this.auth.bactrackCallback(code, state, redirectUri);
    return { ...pair, user };
  }

  @Post("refresh")
  @HttpCode(200)
  @Throttle({ auth: { limit: 20, ttl: 60000 } })
  async refresh(@Body() body: unknown) {
    const dto = parseBody(refreshSchema, body);
    return this.auth.refresh(dto.refreshToken);
  }

  @Post("logout")
  @HttpCode(200)
  async logout(@Body() body: unknown) {
    const dto = parseBody(refreshSchema, body);
    return this.auth.logout(dto.refreshToken);
  }

  @Get("me")
  @UseGuards(JwtAuthGuard)
  async me(@CurrentUser() ctx: OrgContext) {
    return this.auth.me(ctx.userId);
  }

  @Delete("bactrack")
  @UseGuards(JwtAuthGuard)
  async unlink(@CurrentUser() ctx: OrgContext) {
    return this.auth.unlinkProvider(ctx.userId);
  }
}
