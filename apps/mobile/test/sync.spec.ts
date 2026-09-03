import { describe, expect, it, vi, afterEach } from "vitest";
import { ApiClient } from "../src/api/client.js";
import { MemoryTokenStore } from "../src/api/tokens.js";
import { Journal } from "../src/journal/store.js";
import { MemoryBackend } from "../src/journal/memory-backend.js";
import { SyncEngine } from "../src/sync/engine.js";
import type { SessionUploader } from "../src/sync/engine.js";
import { SyncQueue } from "../src/sync/queue.js";

const KEY = "ab".repeat(32);

function stubApi(impl: Partial<Record<"createSession" | "completeSession", (a?: unknown, b?: unknown) => Promise<unknown>>>) {
  const calls: string[] = [];
  return {
    calls,
    async createSession(body: unknown) {
      calls.push("create");
      return ((impl.createSession as ((b: unknown) => Promise<unknown>) | undefined)?.(body) ?? {
        session: { id: "s1" },
        lease: { id: "l1" },
      }) as { session: { id: string }; lease: { id: string } };
    },
    async completeSession(id: unknown, body: unknown) {
      calls.push("complete");
      return ((impl.completeSession as ((i: unknown, b: unknown) => Promise<unknown>) | undefined)?.(id, body) ?? {
        reading: { id: "r1" },
        duplicate: false,
      }) as { reading: { id: string }; duplicate: boolean };
    },
    async listReadings() {
      return { readings: [] };
    },
  };
}

function engineWith(api: SessionUploader, mode: "disabled" | "upload_only" | "download_only" | "bidirectional" = "upload_only", consent = true) {
  const queue = new SyncQueue();
  const journal = new Journal(new MemoryBackend(), KEY);
  const uploaded: string[] = [];
  const errors: string[] = [];
  const engine = new SyncEngine(mode, queue, api, journal, {
    onUploaded: (k) => uploaded.push(k),
    onError: (k, m) => errors.push(`${k}:${m}`),
  }, () => consent);
  return { queue, journal, uploaded, errors, engine };
}

describe("sync engine", () => {
  it("uploads single op and journals", async () => {
    const api = stubApi({});
    const { queue, journal, uploaded, engine } = engineWith(api);
    queue.enqueue({ key: "op1", path: "/sessions", method: "POST", body: { a: 1 } });
    const res = await engine.run();
    expect(res).toEqual({ uploaded: 1, skipped: 0 });
    expect(uploaded).toEqual(["op1"]);
    expect((await journal.read()).map((e) => e.kind)).toContain("sync.session-created");
  });

  it("disabled mode skips everything", async () => {
    const api = stubApi({});
    const { queue, engine } = engineWith(api, "disabled");
    queue.enqueue({ key: "op1", path: "/sessions", method: "POST", body: {} });
    expect(await engine.run()).toEqual({ uploaded: 0, skipped: 1 });
    expect(api.calls).toEqual([]);
  });

  it("backlog without consent is held", async () => {
    const api = stubApi({});
    const { queue, engine } = engineWith(api, "upload_only", false);
    queue.enqueue({ key: "a", path: "/sessions", method: "POST", body: {} });
    queue.enqueue({ key: "b", path: "/sessions", method: "POST", body: {} });
    expect(await engine.run()).toEqual({ uploaded: 0, skipped: 2 });
    expect(api.calls).toEqual([]);
  });

  it("409 reconciles and continues", async () => {
    const api = stubApi({
      createSession: async () => {
        throw { status: 409, code: 409, message: "busy" };
      },
    });
    const { queue, journal, engine } = engineWith(api);
    queue.enqueue({ key: "op1", path: "/sessions", method: "POST", body: {} });
    const res = await engine.run();
    expect(res.uploaded).toBe(1);
    expect(queue.size).toBe(0);
    expect((await journal.read()).map((e) => e.kind)).toContain("sync.op-rejected");
  });

  it("network error stops run and keeps rest", async () => {
    let n = 0;
    const api = stubApi({
      createSession: async () => {
        n++;
        if (n === 1) throw new Error("socket hangup");
        return { session: { id: "s" }, lease: { id: "l" } };
      },
    });
    const { queue, errors, engine } = engineWith(api, "upload_only", true);
    queue.enqueue({ key: "op1", path: "/sessions", method: "POST", body: {} });
    const res = await engine.run();
    expect(res.uploaded).toBe(0);
    expect(queue.size).toBe(1);
    expect(errors).toHaveLength(1);
  });
});

describe("api client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retries once after 401 + refresh", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: { headers?: Record<string, string> }) => {
        const u = String(url);
        seen.push(u);
        if (u.endsWith("/auth/refresh")) {
          return { ok: true, status: 200, json: async () => ({ accessToken: "new-a", refreshToken: "new-r" }) };
        }
        const auth = init?.headers?.["Authorization"] ?? "";
        if (auth === "Bearer old-a") return { ok: false, status: 401, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ readings: [1] }) };
      }),
    );
    const tokens = new MemoryTokenStore();
    await tokens.save({ accessToken: "old-a", refreshToken: "old-r" });
    const client = new ApiClient("http://x", "org", tokens);
    const res = await client.listReadings("?a=1");
    expect(res).toEqual({ readings: [1] });
    expect(seen.some((s) => s.endsWith("/auth/refresh"))).toBe(true);
    expect((await tokens.load())?.accessToken).toBe("new-a");
  });

  it("clears tokens when refresh fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        if (String(url).endsWith("/auth/refresh")) return { ok: false, status: 401, json: async () => ({}) };
        return { ok: false, status: 401, json: async () => ({}) };
      }),
    );
    const tokens = new MemoryTokenStore();
    await tokens.save({ accessToken: "a", refreshToken: "r" });
    const client = new ApiClient("http://x", "org", tokens);
    await expect(client.listReadings("")).rejects.toMatchObject({ status: 401 });
    expect(await tokens.load()).toBeNull();
  });
});
