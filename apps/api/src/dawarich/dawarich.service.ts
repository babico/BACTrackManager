import { ForbiddenException, Inject, Injectable, UnprocessableEntityException } from "@nestjs/common";
import { and, bacReadings, dawarichConnections, desc, eq, getDb, gte, lte } from "@bactrack/db";
import { OrgsService } from "../orgs/orgs.service.js";
import { open, seal } from "../auth/crypto.js";

const WINDOW_DAYS = 31;
const MAX_RANGE_DAYS = 62;

function encKey(): string {
  const k = process.env.TOKEN_ENC_KEY;
  if (!k) throw new Error("TOKEN_ENC_KEY is required");
  return k;
}

interface TimelineDay {
  date: string;
  summary?: unknown;
  entries?: unknown[];
}

type DayBucket = { date: string; summary?: unknown; entries?: unknown[]; readings?: unknown[] };

async function dawGet(baseUrl: string, key: string, path: string): Promise<unknown> {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${baseUrl}${path}${sep}api_key=${encodeURIComponent(key)}`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`dawarich responded ${res.status}`);
  return res.json() as Promise<unknown>;
}

function attachReadings(
  merged: Map<string, DayBucket>,
  readings: { id: string; bac: string; at: Date; origin: string }[],
): void {
  for (const r of readings) {
    const day = r.at.toISOString().slice(0, 10);
    const existing = (merged.get(day) ?? { date: day }) as DayBucket;
    merged.set(day, {
      ...existing,
      readings: [...(existing.readings ?? []), { id: r.id, bacPromille: r.bac, measuredAt: r.at, origin: r.origin }],
    });
  }
}

function sortedDays(merged: Map<string, DayBucket>) {
  return [...merged.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

@Injectable()
export class DawarichService {
  constructor(@Inject(OrgsService) private readonly orgs: OrgsService) {}

  private db() {
    return getDb(process.env.DATABASE_URL as string);
  }

  private async connection(userId: string) {
    const rows = await this.db().select().from(dawarichConnections).where(eq(dawarichConnections.userId, userId)).limit(1);
    return rows.length > 0 ? rows[0] : null;
  }

  private async openKey(conn: { encryptedKey: string | null }): Promise<string> {
    if (!conn.encryptedKey) throw new UnprocessableEntityException("dawarich not connected");
    try {
      return open(encKey(), conn.encryptedKey);
    } catch {
      throw new UnprocessableEntityException("stored key unreadable");
    }
  }

  async connect(userId: string, baseUrl: string, apiKey: string) {
    const clean = baseUrl.replace(/\/+$/, "");
    if (!/^https?:\/\/.+/.test(clean)) throw new UnprocessableEntityException("invalid base url");
    try {
      const health = (await dawGet(clean, apiKey, "/api/v1/health")) as { status?: string };
      if (health.status !== "ok") throw new Error("unhealthy");
    } catch {
      throw new UnprocessableEntityException("dawarich unreachable or key rejected");
    }
    const db = this.db();
    const existing = await this.connection(userId);
    const sealed = seal(encKey(), apiKey);
    if (existing) {
      await db
        .update(dawarichConnections)
        .set({ baseUrl: clean, encryptedKey: sealed })
        .where(eq(dawarichConnections.id, existing.id));
    } else {
      await db.insert(dawarichConnections).values({ userId, baseUrl: clean, encryptedKey: sealed });
    }
    return { connected: true };
  }

  async status(userId: string) {
    const conn = await this.connection(userId);
    if (!conn || !conn.encryptedKey) return { connected: false, baseUrl: null };
    return { connected: true, baseUrl: conn.baseUrl };
  }

  async disconnect(userId: string) {
    await this.db().update(dawarichConnections).set({ encryptedKey: null }).where(eq(dawarichConnections.userId, userId));
    return { connected: false };
  }

  private parseRange(from: string, to: string): { start: Date; end: Date } {
    const start = new Date(from);
    const end = new Date(to);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
      throw new UnprocessableEntityException("invalid range");
    }
    if (Math.ceil((end.getTime() - start.getTime()) / 86400000) + 1 > MAX_RANGE_DAYS) {
      throw new UnprocessableEntityException("range too wide (max 62 days)");
    }
    return { start, end };
  }

  private async fetchDays(baseUrl: string, key: string, start: Date, end: Date) {
    const merged = new Map<string, DayBucket>();
    for (let w = new Date(start); w <= end; w = new Date(w.getTime() + WINDOW_DAYS * 86400000)) {
      const wEnd = new Date(Math.min(w.getTime() + (WINDOW_DAYS - 1) * 86400000, end.getTime()));
      let data: { days?: TimelineDay[] };
      try {
        data = (await dawGet(
          baseUrl,
          key,
          `/api/v1/timeline?start_at=${encodeURIComponent(w.toISOString())}&end_at=${encodeURIComponent(wEnd.toISOString())}`,
        )) as typeof data;
      } catch {
        throw new UnprocessableEntityException("dawarich request failed");
      }
      for (const d of data.days ?? []) {
        merged.set(d.date, { date: d.date, summary: d.summary, entries: d.entries ?? [] });
      }
    }
    return merged;
  }

  private async readingsFor(organizationId: string, subjectUserId: string, start: Date, end: Date) {
    return this.db()
      .select({ id: bacReadings.id, bac: bacReadings.bacPromille, at: bacReadings.measuredAt, origin: bacReadings.origin })
      .from(bacReadings)
      .where(
        and(
          eq(bacReadings.organizationId, organizationId),
          eq(bacReadings.subjectUserId, subjectUserId),
          gte(bacReadings.measuredAt, start),
          lte(bacReadings.measuredAt, end),
        ),
      )
      .orderBy(desc(bacReadings.measuredAt));
  }

  async timeline(userId: string, organizationId: string, from: string, to: string) {
    const conn = await this.connection(userId);
    if (!conn) throw new UnprocessableEntityException("dawarich not connected");
    const key = await this.openKey(conn);
    const { start, end } = this.parseRange(from, to);
    const merged = await this.fetchDays(conn.baseUrl, key, start, end);
    attachReadings(merged, await this.readingsFor(organizationId, userId, start, end));
    return { days: sortedDays(merged) };
  }

  async teamTimeline(orgId: string, managerId: string, from: string, to: string) {
    const role = await this.orgs.roleOf(orgId, managerId);
    if (role !== "owner" && role !== "admin") throw new ForbiddenException("owner or admin only");
    const { start, end } = this.parseRange(from, to);
    const members = await this.orgs.members(orgId);
    const usersOut: { userId: string; displayName: string; days: unknown[] }[] = [];
    for (const m of members.members) {
      const conn = await this.connection(m.userId);
      if (!conn) continue;
      let key: string;
      try {
        key = await this.openKey(conn);
      } catch {
        continue;
      }
      let merged: Map<string, { date: string; summary?: unknown; entries?: unknown[] }>;
      try {
        merged = await this.fetchDays(conn.baseUrl, key, start, end);
      } catch {
        continue;
      }
      attachReadings(merged, await this.readingsFor(orgId, m.userId, start, end));
      usersOut.push({ userId: m.userId, displayName: m.displayName, days: sortedDays(merged) });
    }
    return { users: usersOut };
  }
}
