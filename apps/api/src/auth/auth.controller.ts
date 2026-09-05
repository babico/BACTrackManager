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
import { MfaService } from "./mfa.service.js";

const emailSchema = z.object({ email: z.string().email().max(320) });
const codeSchema = z.object({ code: z.string().min(4).max(32) });
const challengeSchema = z.object({ ticket: z.string().min(10), code: z.string().min(4).max(32) });
const refreshSchema = z.object({ refreshToken: z.string().min(10) });
const startSchema = z.object({ redirectUri: z.string().url().max(500) });

@Controller("auth")
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(MfaService) private readonly mfa: MfaService,
  ) {}

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
    return this.auth.magicConsume(token);
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
    return this.auth.bactrackCallback(code, state, redirectUri);
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

  @Post("mfa/setup")
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async mfaSetup(@CurrentUser() ctx: OrgContext) {
    const me = await this.auth.me(ctx.userId);
    return this.mfa.setup(ctx.userId, me.user.email);
  }

  @Post("mfa/enable")
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async mfaEnable(@CurrentUser() ctx: OrgContext, @Body() body: unknown) {
    const dto = parseBody(codeSchema, body);
    return this.mfa.enable(ctx.userId, dto.code);
  }

  @Post("mfa/challenge")
  @HttpCode(200)
  @Throttle({ auth: { limit: 20, ttl: 60000 } })
  async mfaChallenge(@Body() body: unknown) {
    const dto = parseBody(challengeSchema, body);
    const { pair, user } = await this.auth.mfaChallenge(dto.ticket, dto.code);
    return { ...pair, user };
  }

  @Delete("mfa")
  @UseGuards(JwtAuthGuard)
  async mfaDisable(@CurrentUser() ctx: OrgContext) {
    return this.mfa.disable(ctx.userId);
  }
}
