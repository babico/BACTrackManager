import { Controller, Get, Inject, Param, Sse, UseGuards } from "@nestjs/common";
import { and, asc, eq, getDb, outbox } from "@bactrack/db";
import { Observable, concatMap, interval, map, take, toArray } from "rxjs";
import { DevIdentityGuard } from "../identity/dev-identity.guard.js";
import { CurrentUser, OrgContext } from "../identity/current-user.js";
import { assertMembership } from "../identity/membership.js";
import { SessionsService } from "./sessions.service.js";

interface SseEvent {
  type: string;
  data: Record<string, unknown>;
}

@UseGuards(DevIdentityGuard)
@Controller("sessions")
export class SessionEventsController {
  constructor(@Inject(SessionsService) private readonly sessions: SessionsService) {}

  @Sse(":id/events")
  async events(@CurrentUser() ctx: OrgContext, @Param("id") id: string): Promise<Observable<SseEvent>> {
    await assertMembership(ctx.organizationId, ctx.userId);
    const session = await this.sessions.get(ctx.organizationId, id);
    const db = getDb(process.env.DATABASE_URL as string);
    const snapshot: SseEvent = {
      type: "session.snapshot",
      data: { id: session.id, status: session.status },
    };
    const replay = async (): Promise<SseEvent[]> => {
      const rows = await db
        .select()
        .from(outbox)
        .where(and(eq(outbox.aggregateType, "session"), eq(outbox.aggregateId, id)))
        .orderBy(asc(outbox.createdAt));
      return rows.map((r) => ({ type: r.eventType, data: (r.payload ?? {}) as Record<string, unknown> }));
    };
    return new Observable<SseEvent>((sub) => {
      sub.next(snapshot);
      const poll = interval(2000)
        .pipe(
          take(7),
          concatMap(() => replay()),
          map((events) => events),
        )
        .subscribe({
          next: (events) => {
            for (const e of events) sub.next(e);
            sub.complete();
          },
          error: (err) => sub.error(err),
        });
      return () => poll.unsubscribe();
    }).pipe(toArray(), concatMap((all) => all));
  }
}
