import { outbox } from "@bactrack/db";

interface Inserter {
  insert(table: typeof outbox): { values(v: unknown): unknown };
}

export async function publishOutbox(
  db: Inserter,
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
