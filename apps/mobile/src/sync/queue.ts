export type SyncMode = "disabled" | "upload_only" | "download_only" | "bidirectional";

export interface QueuedOp {
  key: string;
  path: string;
  method: "POST" | "PATCH";
  body: Record<string, unknown>;
}

export class SyncQueue {
  private ops: QueuedOp[] = [];

  enqueue(op: QueuedOp): boolean {
    if (this.ops.some((o) => o.key === op.key)) return false;
    this.ops.push(op);
    return true;
  }

  pending(): QueuedOp[] {
    return [...this.ops];
  }

  dequeue(key: string): void {
    this.ops = this.ops.filter((o) => o.key !== key);
  }

  get size(): number {
    return this.ops.length;
  }
}
