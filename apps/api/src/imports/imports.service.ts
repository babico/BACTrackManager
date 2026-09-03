import { Inject, Injectable, UnauthorizedException, UnprocessableEntityException } from "@nestjs/common";
import { bacReadings, bactrackIdentities, consumerImports, desc, eq, getDb } from "@bactrack/db";
import { AuthService } from "../auth/auth.service.js";
import { open } from "../auth/crypto.js";

const PAGE_LIMIT = 100;

interface ProviderReading {
  id: string;
  bacLevel: number;
  deviceSN: string;
  testedAt: string;
}

function providerApi(): string {
  return process.env.BACTRACK_API ?? "https://consumer-api.bactrack.com";
}

function encKey(): string {
  const k = process.env.TOKEN_ENC_KEY;
  if (!k) throw new Error("TOKEN_ENC_KEY is required");
  return k;
}

@Injectable()
export class ImportsService {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  private db() {
    return getDb(process.env.DATABASE_URL as string);
  }

  private async providerGet(identityId: string, userId: string, path: string): Promise<unknown> {
    const db = this.db();
    const rows = await db.select().from(bactrackIdentities).where(eq(bactrackIdentities.id, identityId)).limit(1);
    if (rows.length === 0 || !rows[0].encryptedAccess) {
      throw new UnauthorizedException("provider not linked");
    }
    let access: string;
    try {
      access = open(encKey(), rows[0].encryptedAccess);
    } catch {
      throw new UnauthorizedException("provider token unreadable");
    }
    const attempt = async (token: string) =>
      fetch(`${providerApi()}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8000),
      });
    let res = await attempt(access);
    if (res.status === 401) {
      const fresh = await this.auth.providerRefresh(userId);
      if (!fresh) throw new UnauthorizedException("provider session expired");
      res = await attempt(fresh);
    }
    if (!res.ok) throw new UnprocessableEntityException("provider request failed");
    return res.json() as Promise<unknown>;
  }

  async runConsumerImport(userId: string, organizationId: string) {
    const db = this.db();
    const identities = await db.select().from(bactrackIdentities).where(eq(bactrackIdentities.userId, userId)).limit(1);
    if (identities.length === 0 || !identities[0].encryptedAccess) {
      throw new UnprocessableEntityException("no linked bactrack account");
    }
    const identity = identities[0];
    const [run] = await db
      .insert(consumerImports)
      .values({ identityId: identity.id, organizationId, status: "running" })
      .returning({ id: consumerImports.id });
    let imported = 0;
    let skipped = 0;
    let total = 0;
    try {
      for (let page = 1; ; page++) {
        const data = (await this.providerGet(
          identity.id,
          userId,
          `/api/v1/readings?page=${page}&limit=${PAGE_LIMIT}`,
        )) as { readings: ProviderReading[] };
        const readings = Array.isArray(data.readings) ? data.readings : [];
        total += readings.length;
        for (const r of readings) {
          if (typeof r.id !== "string") {
            skipped++;
            continue;
          }
          const existing = await db
            .select({ id: bacReadings.id })
            .from(bacReadings)
            .where(eq(bacReadings.providerReadingId, r.id))
            .limit(1);
          if (existing.length > 0) {
            skipped++;
            continue;
          }
          await db.insert(bacReadings).values({
            sessionId: null,
            organizationId,
            bacPromille: String(r.bacLevel ?? 0),
            deviceSerial: typeof r.deviceSN === "string" ? r.deviceSN : "unknown",
            operatorUserId: userId,
            subjectUserId: userId,
            origin: "consumer_import",
            rawPayload: r as unknown as Record<string, unknown>,
            measuredAt: new Date(r.testedAt),
            providerReadingId: r.id,
          });
          imported++;
        }
        if (readings.length < PAGE_LIMIT) break;
      }
      await db
        .update(consumerImports)
        .set({ status: "completed", importedCount: imported, skippedCount: skipped, finishedAt: new Date() })
        .where(eq(consumerImports.id, run.id));
      return { imported, skipped, total };
    } catch (err) {
      await db
        .update(consumerImports)
        .set({ status: "failed", importedCount: imported, skippedCount: skipped, finishedAt: new Date() })
        .where(eq(consumerImports.id, run.id));
      throw err;
    }
  }

  async importStatus(userId: string) {
    const db = this.db();
    const identities = await db.select().from(bactrackIdentities).where(eq(bactrackIdentities.userId, userId)).limit(1);
    if (identities.length === 0) return { lastRun: null };
    const runs = await db
      .select()
      .from(consumerImports)
      .where(eq(consumerImports.identityId, identities[0].id))
      .orderBy(desc(consumerImports.startedAt))
      .limit(1);
    if (runs.length === 0) return { lastRun: null };
    const r = runs[0];
    return {
      lastRun: { status: r.status, imported: r.importedCount, skipped: r.skippedCount, finishedAt: r.finishedAt },
    };
  }
}
