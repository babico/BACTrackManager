import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { and, devices, eq, getDb } from "@bactrack/db";

const SERIAL_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}[A-Za-z0-9]$/;

@Injectable()
export class DevicesService {
  private db() {
    return getDb(process.env.DATABASE_URL as string);
  }

  async register(organizationId: string, serialNumber: string, model = "C6") {
    if (!SERIAL_RE.test(serialNumber)) {
      throw new ConflictException("invalid serial number");
    }
    try {
      const [row] = await this.db()
        .insert(devices)
        .values({ organizationId, serialNumber, model })
        .returning();
      return row;
    } catch (err: unknown) {
      if ((err as { code?: string }).code === "23505") {
        throw new ConflictException("device serial already registered");
      }
      throw err;
    }
  }

  list(organizationId: string) {
    return this.db()
      .select()
      .from(devices)
      .where(eq(devices.organizationId, organizationId));
  }

  async setStatus(organizationId: string, id: string, status: "provisioned" | "active" | "retired") {
    const rows = await this.db()
      .update(devices)
      .set({ status })
      .where(and(eq(devices.id, id), eq(devices.organizationId, organizationId)))
      .returning();
    if (rows.length === 0) throw new NotFoundException("device not found");
    return rows[0];
  }

  async getForOrg(organizationId: string, id: string) {
    const rows = await this.db()
      .select()
      .from(devices)
      .where(and(eq(devices.id, id), eq(devices.organizationId, organizationId)))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException("device not found");
    return rows[0];
  }
}
