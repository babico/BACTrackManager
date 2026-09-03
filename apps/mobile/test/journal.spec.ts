import { describe, expect, it } from "vitest";
import { Journal } from "../src/journal/store.js";
import { MemoryBackend } from "../src/journal/memory-backend.js";
import { SyncQueue } from "../src/sync/queue.js";

const KEY = "ab".repeat(32);

describe("journal", () => {
  it("round-trips entries with seq order", async () => {
    const j = new Journal(new MemoryBackend(), KEY);
    await j.append("test.countdown", { left: 3 });
    await j.append("test.result", { bac: 0 });
    const rows = await j.read();
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
    expect(rows[1].kind).toBe("test.result");
  });

  it("ciphertext differs per row and is opaque", async () => {
    const backend = new MemoryBackend();
    const j = new Journal(backend, KEY);
    await j.append("x", { v: 1 });
    await j.append("x", { v: 1 });
    const raw = await backend.readAll();
    expect(raw[0]).not.toBe(raw[1]);
    expect(raw.join("")).not.toContain("test");
  });

  it("markSyncedThrough drops synced prefix", async () => {
    const j = new Journal(new MemoryBackend(), KEY);
    await j.append("a", {});
    await j.append("b", {});
    await j.append("c", {});
    await j.markSyncedThrough(2);
    expect((await j.read()).map((r) => r.kind)).toEqual(["c"]);
  });

  it("wrong key throws", async () => {
    const backend = new MemoryBackend();
    await new Journal(backend, KEY).append("a", {});
    await expect(new Journal(backend, "cd".repeat(32)).read()).rejects.toThrow();
  });
});

describe("sync queue", () => {
  it("rejects duplicate idempotency keys", () => {
    const q = new SyncQueue();
    const op = { key: "k1", path: "/sessions", method: "POST" as const, body: {} };
    expect(q.enqueue(op)).toBe(true);
    expect(q.enqueue(op)).toBe(false);
    expect(q.size).toBe(1);
    q.dequeue("k1");
    expect(q.size).toBe(0);
  });
});
