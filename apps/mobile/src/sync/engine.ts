import type { Journal } from "../journal/store.js";
import type { SyncMode, SyncQueue } from "./queue.js";

export interface SessionUploader {
  createSession(input: {
    deviceId: string;
    subjectUserId: string;
    clientSessionId: string;
  }): Promise<{ session: { id: string }; lease: { id: string } }>;
  completeSession(
    id: string,
    input: { bacPromille: number; measuredAt: string; rawPayload?: Record<string, unknown> },
  ): Promise<{ reading: { id: string }; duplicate: boolean }>;
}

export interface EngineEvents {
  onUploaded(key: string): void;
  onError(key: string, message: string): void;
}

export class SyncEngine {
  constructor(
    private readonly mode: SyncMode,
    private readonly queue: SyncQueue,
    private readonly api: SessionUploader,
    private readonly journal: Journal,
    private readonly events: EngineEvents,
    private readonly backlogAllowed: () => boolean,
  ) {}

  async run(): Promise<{ uploaded: number; skipped: number }> {
    if (this.mode === "disabled" || this.mode === "download_only") {
      return { uploaded: 0, skipped: this.queue.size };
    }
    const pending = this.queue.pending();
    if (pending.length > 1 && !this.backlogAllowed()) {
      return { uploaded: 0, skipped: pending.length };
    }
    let uploaded = 0;
    for (const op of pending) {
      try {
        if (op.path === "/sessions" && op.method === "POST") {
          const res = await this.api.createSession(
            op.body as { deviceId: string; subjectUserId: string; clientSessionId: string },
          );
          await this.journal.append("sync.session-created", { key: op.key, sessionId: res.session.id });
        } else if (op.path.endsWith("/complete")) {
          const id = op.path.split("/")[2];
          const res = await this.api.completeSession(id, op.body as { bacPromille: number; measuredAt: string });
          await this.journal.append("sync.reading-uploaded", {
            key: op.key,
            readingId: res.reading.id,
            duplicate: res.duplicate,
          });
        } else {
          throw new Error(`unknown op ${op.method} ${op.path}`);
        }
        this.queue.dequeue(op.key);
        this.events.onUploaded(op.key);
        uploaded++;
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 409 || status === 422) {
          this.queue.dequeue(op.key);
          await this.journal.append("sync.op-rejected", { key: op.key, status });
          uploaded++;
          continue;
        }
        this.events.onError(op.key, (err as Error).message ?? "unknown");
        break;
      }
    }
    return { uploaded, skipped: this.queue.size };
  }
}
