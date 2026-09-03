import { outbox } from "@bactrack/db";

export async function publishOutbox(
  db: {
    insert: (table: typeof outbox) => {
      values: (v: Record<string, unknown>) => Promise<unknown>;
    };
  },
  event: {
    aggregateType: string;
    aggregateId: string;
    eventType: string;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  await db.insert(outbox).values({
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    eventType: event.eventType,
    payload: event.payload ?? {},
  });
}
