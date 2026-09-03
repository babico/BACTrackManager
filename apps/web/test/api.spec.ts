import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { api, apiGet, apiPost } from "../src/lib/api.js";

const A = "bactrack.access";
const R = "bactrack.refresh";
const O = "bactrack.org";
const store: Record<string, string | null> = {};

function stubStorage() {
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      store[k] = null;
    },
  });
}

describe("web api client", () => {
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    stubStorage();
    process.env.NEXT_PUBLIC_API_BASE = "http://t";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends auth + org headers", async () => {
    store[A] = "acc";
    store[R] = "ref";
    store[O] = "org-1";
    let got: Record<string, string> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: unknown, init?: { headers?: Record<string, string> }) => {
        got = init?.headers ?? {};
        return { ok: true, status: 200, json: async () => ({ ok: 1 }) };
      }),
    );
    await apiGet<{ ok: number }>("/x");
    expect(got["Authorization"]).toBe("Bearer acc");
    expect(got["x-org-id"]).toBe("org-1");
  });

  it("401 → refresh → retry, new tokens saved", async () => {
    store[A] = "old";
    store[R] = "rt";
    store[O] = "org-1";
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: unknown, init?: { headers?: Record<string, string> }) => {
        n++;
        if (String(u).endsWith("/auth/refresh")) {
          return { ok: true, status: 200, json: async () => ({ accessToken: "new", refreshToken: "newr" }) };
        }
        if ((init?.headers?.["Authorization"] ?? "") === "Bearer old") {
          return { ok: false, status: 401, json: async () => ({}) };
        }
        return { ok: true, status: 200, json: async () => ({ ok: n }) };
      }),
    );
    const res = await apiPost<{ ok: number }>("/y", {});
    expect(res.ok).toBe(3);
    expect(store[A]).toBe("new");
    expect(store[R]).toBe("newr");
  });

  it("failed refresh clears session and throws 401", async () => {
    store[A] = "old";
    store[R] = "rt";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })),
    );
    await expect(api("/z")).rejects.toMatchObject({ status: 401 });
    expect(store[A]).toBeNull();
  });
});
