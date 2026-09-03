import { Inject, Injectable } from "@nestjs/common";
import { and, eq, getDb, organizationMemberships, pushSubscriptions } from "@bactrack/db";
import webpush from "web-push";

export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export type PushTransport = (target: PushTarget, payload: string) => Promise<void>;

function defaultTransport(): PushTransport {
  const pub = process.env.VAPID_PUBLIC;
  const priv = process.env.VAPID_PRIVATE;
  const subject = process.env.VAPID_SUBJECT ?? "mailto:admin@example.com";
  if (!pub || !priv) {
    return async () => {
      // eslint-disable-next-line no-console
      console.log("push skipped: VAPID keys not configured");
    };
  }
  webpush.setVapidDetails(subject, pub, priv);
  return async (target, payload) => {
    try {
      await webpush.sendNotification(
        { endpoint: target.endpoint, keys: target.keys },
        payload,
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.log("push delivery failed", (err as Error).message);
    }
  };
}

export interface ReadingNotice {
  organizationId: string;
  operatorUserId: string;
  subjectUserId: string;
  subjectEmail: string;
  bacPromille: number;
  readingId: string;
}

@Injectable()
export class PushService {
  private readonly transport: PushTransport;

  constructor(@Inject("PUSH_TRANSPORT") transport: PushTransport | null) {
    this.transport = transport ?? defaultTransport();
  }

  private db() {
    return getDb(process.env.DATABASE_URL as string);
  }

  async subscribe(userId: string, endpoint: string, keys: unknown) {
    const db = this.db();
    const parsed =
      typeof keys === "object" && keys !== null
        ? (keys as { p256dh?: unknown; auth?: unknown })
        : {};
    if (typeof parsed.p256dh !== "string" || typeof parsed.auth !== "string") {
      throw new Error("invalid subscription keys");
    }
    const existing = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint)).limit(1);
    if (existing.length > 0) {
      await db
        .update(pushSubscriptions)
        .set({ userId, keys: { p256dh: parsed.p256dh, auth: parsed.auth } })
        .where(eq(pushSubscriptions.id, existing[0].id));
      return { subscribed: true, id: existing[0].id };
    }
    const [row] = await db
      .insert(pushSubscriptions)
      .values({ userId, endpoint, keys: { p256dh: parsed.p256dh, auth: parsed.auth } })
      .returning({ id: pushSubscriptions.id });
    return { subscribed: true, id: row.id };
  }

  async list(userId: string) {
    const rows = await this.db()
      .select({ id: pushSubscriptions.id, endpoint: pushSubscriptions.endpoint, createdAt: pushSubscriptions.createdAt })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId));
    return { subscriptions: rows };
  }

  async unsubscribe(userId: string, endpoint: string) {
    await this.db()
      .delete(pushSubscriptions)
      .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)));
    return { unsubscribed: true };
  }

  async notifyReading(notice: ReadingNotice): Promise<{ attempted: number }> {
    const db = this.db();
    const owners = await db
      .select({ userId: organizationMemberships.userId, role: organizationMemberships.role })
      .from(organizationMemberships)
      .where(and(eq(organizationMemberships.organizationId, notice.organizationId)));
    const targets = owners.filter((o) => (o.role === "owner" || o.role === "admin") && o.userId !== notice.operatorUserId);
    let attempted = 0;
    const payload = JSON.stringify({
      title: "New reading",
      body: `${notice.subjectEmail} tested ${notice.bacPromille.toFixed(3)} ‰`,
      readingId: notice.readingId,
    });
    for (const t of targets) {
      const subs = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, t.userId));
      for (const s of subs) {
        const keys = s.keys as { p256dh: string; auth: string };
        await this.transport({ endpoint: s.endpoint, keys }, payload);
        attempted++;
      }
    }
    return { attempted };
  }
}
