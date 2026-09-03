import { Controller, Get, Header, Query, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { CurrentUser, OrgContext } from "../identity/current-user.js";
import { assertMembership } from "../identity/membership.js";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { fetchExportRows, recordExportAudit, rowsToCsv, rowsToPdf } from "./exports.service.js";

@UseGuards(JwtAuthGuard)
@Controller("exports")
export class ExportsController {

  private filters(subjectUserId?: string, from?: string, to?: string, limit?: string) {
    const parsed = parseInt(limit ?? "1000", 10);
    return {
      subjectUserId: subjectUserId || undefined,
      from: from || undefined,
      to: to || undefined,
      limit: Number.isFinite(parsed) ? parsed : 1000,
    };
  }

  @Get("readings.csv")
  @Header("Content-Type", "text/csv; charset=utf-8")
  @Header("Content-Disposition", 'attachment; filename="readings.csv"')
  async csv(
    @CurrentUser() ctx: OrgContext,
    @Query("subjectUserId") subjectUserId: string | undefined,
    @Query("from") from: string | undefined,
    @Query("to") to: string | undefined,
    @Query("limit") limit: string | undefined,
    @Res({ passthrough: true }) _res: Response,
  ): Promise<string> {
    await assertMembership(ctx.organizationId, ctx.userId);
    const { rows } = await fetchExportRows(ctx.organizationId, this.filters(subjectUserId, from, to, limit));
    await recordExportAudit(ctx.organizationId, ctx.userId, "csv", rows.length);
    return rowsToCsv(rows);
  }

  @Get("readings.pdf")
  @Header("Content-Type", "application/pdf")
  @Header("Content-Disposition", 'attachment; filename="readings.pdf"')
  async pdf(
    @CurrentUser() ctx: OrgContext,
    @Query("subjectUserId") subjectUserId: string | undefined,
    @Query("from") from: string | undefined,
    @Query("to") to: string | undefined,
    @Query("limit") limit: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await assertMembership(ctx.organizationId, ctx.userId);
    const { rows, orgName } = await fetchExportRows(ctx.organizationId, this.filters(subjectUserId, from, to, limit));
    await recordExportAudit(ctx.organizationId, ctx.userId, "pdf", rows.length);
    const buf = await rowsToPdf(orgName, rows);
    res.send(buf);
  }
}
