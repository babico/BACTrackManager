import { Controller, Get } from "@nestjs/common";
import { getPool } from "@bactrack/db";

@Controller()
export class HealthController {
  @Get("health")
  async health(): Promise<{ status: string; db: string }> {
    const pool = getPool(process.env.DATABASE_URL as string);
    await pool.query("SELECT 1");
    return { status: "ok", db: "up" };
  }

  @Get("version")
  version(): { version: string } {
    return { version: process.env.API_VERSION ?? "0.1.0" };
  }
}
