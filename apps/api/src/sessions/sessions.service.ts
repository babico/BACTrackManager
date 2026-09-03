import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { and, deviceLeases, devices, eq, getDb, organizationMemberships, sql, testSessions } from "@bactrack/db";
import { appendAudit } from "../common/audit.js";
import { publishOutbox } from "../common/outbox.js";

const TERMINAL = ["completed", "failed", "expired"] as const;

@Injectable()
export class SessionsService {
  private db() {
    return getDb(process.env.DATABASE_URL as string);
  }

  async create(input: {
    organizationId: string;
    operatorUserId: string;
    deviceId: string;
    subjectUserId: string;
    clientSessionId: string;
    ttlMinutes: number;
  }) {
    const db = this.db();
    const deviceRows = await db
      .select()
      .from(devices)
      .where(and(eq(devices.id, input.deviceId), eq(devices.organizationId, input.organizationId)))
      .limit(1);
    if (deviceRows.length === 0) throw new NotFoundException("device not found");
    const device = deviceRows[0];
    if (device.status === "retired") {
      throw new UnprocessableEntityException("device retired");
    }
    const memberRows = await db
      .select({ id: organizationMemberships.id })
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.organizationId, input.organizationId),
          eq(organizationMemberships.userId, input.subjectUserId),
        ),
      )
      .limit(1);
    if (memberRows.length === 0) {
      throw new UnprocessableEntityException("subject is not an organization member");
    }
    const expiresAt = new Date(Date.now() + input.ttlMinutes * 60_000);

    try {
      return await db.transaction(async (tx) => {
        if (device.status === "provisioned") {
          await tx
            .update(devices)
            .set({ status: "active" })
            .where(eq(devices.id, device.id));
          await appendAudit(tx, {
            organizationId: input.organizationId,
            actorUserId: input.operatorUserId,
            action: "device.activated",
            entityType: "device",
            entityId: device.id,
            details: { serialNumber: device.serialNumber },
          });
        }
        const [session] = await tx
          .insert(testSessions)
          .values({
            organizationId: input.organizationId,
            deviceId: device.id,
            operatorUserId: input.operatorUserId,
            subjectUserId: input.subjectUserId,
            clientSessionId: input.clientSessionId,
            expiresAt,
          })
          .returning();
        const [lease] = await tx
          .insert(deviceLeases)
          .values({
            deviceId: device.id,
            sessionId: session.id,
            holderUserId: input.operatorUserId,
          })
          .returning();
        await appendAudit(tx, {
          organizationId: input.organizationId,
          actorUserId: input.operatorUserId,
          action: "session.created",
          entityType: "session",
          entityId: session.id,
          details: { deviceId: device.id, subjectUserId: input.subjectUserId },
        });
        await publishOutbox(tx, {
          aggregateType: "session",
          aggregateId: session.id,
          eventType: "session.created",
          payload: { status: session.status },
        });
        return { session, lease };
      });
    } catch (err: unknown) {
      if ((err as { code?: string }).code === "23505") {
        throw new ConflictException("device already in use");
      }
      throw err;
    }
  }

  async get(organizationId: string, id: string) {
    const rows = await this.db()
      .select()
      .from(testSessions)
      .where(and(eq(testSessions.id, id), eq(testSessions.organizationId, organizationId)))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException("session not found");
    return rows[0];
  }

  async transition(
    organizationId: string,
    actorUserId: string,
    id: string,
    to: "expired" | "failed",
    details: Record<string, unknown> = {},
  ) {
    const db = this.db();
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM test_sessions WHERE id = ${id} FOR UPDATE`);
      const rows = await tx
        .select()
        .from(testSessions)
        .where(and(eq(testSessions.id, id), eq(testSessions.organizationId, organizationId)))
        .limit(1);
      if (rows.length === 0) throw new NotFoundException("session not found");
      const session = rows[0];
      if ((TERMINAL as readonly string[]).includes(session.status)) {
        throw new ConflictException(`session already ${session.status}`);
      }
      const [updated] = await tx
        .update(testSessions)
        .set({ status: to, updatedAt: new Date() })
        .where(eq(testSessions.id, id))
        .returning();
      await tx
        .update(deviceLeases)
        .set({ releasedAt: new Date() })
        .where(and(eq(deviceLeases.sessionId, id), sql`released_at IS NULL`));
      await appendAudit(tx, {
        organizationId,
        actorUserId,
        action: `session.${to}`,
        entityType: "session",
        entityId: id,
        details,
      });
      await publishOutbox(tx, {
        aggregateType: "session",
        aggregateId: id,
        eventType: `session.${to}`,
        payload: { status: to, ...details },
      });
      return updated;
    });
  }

  async breakGlassRelease(organizationId: string, actorUserId: string, deviceId: string) {
    const db = this.db();
    const leases = await db
      .select()
      .from(deviceLeases)
      .where(and(eq(deviceLeases.deviceId, deviceId), sql`released_at IS NULL`))
      .limit(1);
    if (leases.length === 0) throw new NotFoundException("no active lease");
    await db.transaction(async (tx) => {
      await tx
        .update(deviceLeases)
        .set({ releasedAt: new Date() })
        .where(eq(deviceLeases.id, leases[0].id));
      await appendAudit(tx, {
        organizationId,
        actorUserId,
        action: "lease.released.breakglass",
        entityType: "device",
        entityId: deviceId,
        details: { sessionId: leases[0].sessionId },
      });
    });
    return { released: true, sessionId: leases[0].sessionId };
  }
}
