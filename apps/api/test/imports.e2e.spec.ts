import { INestApplication } from "@nestjs/common";
import { describe, expect, it, beforeAll, afterAll, vi, afterEach } from "vitest";
import request from "supertest";
import { bactrackIdentities, closePool, eq, getDb, users, organizations, organizationMemberships } from "@bactrack/db";
import { AuthService } from "../src/auth/auth.service.js";
import { seal } from "../src/auth/crypto.js";
import { createTestApp } from "./bootstrap.js";

let app: INestApplication;

let orgId = "";
let userId = "";
let bearer = "";
let plainId = "";
let plainBearer = "";
let plainOrg = "";

const authed = (token: string, org: string = orgId) => {
  const base = request(app.getHttpServer());
  const auth = <T extends { set(k: string, v: string): T }>(r: T): T =>
    r.set("Authorization", `Bearer ${token}`).set("x-org-id", org);
  return {
    get: (p: string) => auth(base.get(p)),
    post: (p: string) => auth(base.post(p)),
  };
};

const RUN_TAG = Date.now().toString(36);
const gen = (n: number, prefix: string) =>
  Array.from({ length: n }, (_, i) => ({
    id: `${RUN_TAG}-${prefix}-${i}`,
    bacLevel: 0.21,
    deviceSN: "03-8CF-0-06887",
    deviceType: "c6",
    testedAt: "2026-08-01T10:00:00.000Z",
  }));
const PAGE1 = gen(100, "a");
const PAGE2 = gen(1, "b");

function mockPages() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      const u = String(url);
      const readings = u.includes("page=1") ? PAGE1 : PAGE2;
      return { ok: true, status: 200, json: async () => ({ readings }) };
    }),
  );
}

beforeAll(async () => {
  app = await createTestApp();
  const db = getDb(process.env.DATABASE_URL as string);
  const suffix = Date.now().toString(36);
  const svc: AuthService = app.get(AuthService);
  const mkUser = async (email: string) => {
    const { user } = await svc.registerOrLogin({ email: `${suffix}-${email}`, displayName: email });
    const me = await svc.me(user.id);
    const org = me.organizations[0].id as string;
    return { user, org };
  };
  const linked = await mkUser("linked@example.com");
  userId = linked.user.id;
  orgId = linked.org;
  bearer = (await svc.mintPair(userId)).accessToken;
  await db.insert(bactrackIdentities).values({
    userId,
    providerUserId: `prov-${suffix}`,
    encryptedAccess: seal(process.env.TOKEN_ENC_KEY as string, "prov-access-token"),
    encryptedRefresh: seal(process.env.TOKEN_ENC_KEY as string, "prov-refresh-token"),
  });
  const plain = await mkUser("plain@example.com");
  plainId = plain.user.id;
  void plainId;
  plainBearer = (await svc.mintPair(plain.user.id)).accessToken;
  plainOrg = plain.org;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await app.close();
  await closePool();
});

describe("consumer import", () => {
  it("imports paged history with origin flag, rerun skips", async () => {
    mockPages();
    const first = await authed(bearer).post("/imports/consumer/run").send({});
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ imported: 101, skipped: 0, total: 101 });

    const list = await authed(bearer).get("/readings?limit=1000");
    const imported = list.body.readings.filter((r: { origin: string }) => r.origin === "consumer_import");
    expect(imported).toHaveLength(101);
    expect(imported[0].deviceSerial).toBe("03-8CF-0-06887");
    expect(Number(imported[0].bacPromille)).toBeGreaterThanOrEqual(0);

    const second = await authed(bearer).post("/imports/consumer/run").send({});
    expect(second.body).toMatchObject({ imported: 0, skipped: 101, total: 101 });

    const status = await authed(bearer).get("/imports/consumer/status");
    expect(status.body.lastRun.status).toBe("completed");
    expect(status.body.lastRun.imported).toBe(0);
  });

  it("unlinked user → 422", async () => {
    const res = await authed(plainBearer, plainOrg).post("/imports/consumer/run").send({});
    expect(res.status).toBe(422);
  });

  it("dead provider token → 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        if (String(url).includes("/oauth/token")) {
          return { ok: false, status: 400, json: async () => ({}) };
        }
        return { ok: false, status: 401, json: async () => ({}) };
      }),
    );
    const res = await authed(bearer).post("/imports/consumer/run").send({});
    expect(res.status).toBe(401);
  });
});
