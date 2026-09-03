import { INestApplication } from "@nestjs/common";
import { describe, expect, it, beforeAll, afterAll, vi, afterEach } from "vitest";
import request from "supertest";
import { closePool, getDb, users, organizations, organizationMemberships } from "@bactrack/db";
import { AuthService } from "../src/auth/auth.service.js";
import { createTestApp } from "./bootstrap.js";

let app: INestApplication;

let orgId = "";
let ownerId = "";
let memberId = "";
let viewerId = "";
let ownerBearer = "";
let memberBearer = "";
let viewerBearer = "";

const authed = (token: string) => {
  const base = request(app.getHttpServer());
  const auth = <T extends { set(k: string, v: string): T }>(r: T): T =>
    r.set("Authorization", `Bearer ${token}`).set("x-org-id", orgId);
  return {
    get: (p: string) => auth(base.get(p)),
    post: (p: string) => auth(base.post(p)),
    delete: (p: string) => auth(base.delete(p)),
  };
};

let healthOk = true;

function mockDawarich() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes("/api/v1/health")) {
        if (!healthOk) return { ok: false, status: 401, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
      }
      if (u.includes("/api/v1/timeline")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ days: [{ date: "2026-09-01", summary: {}, entries: [{ type: "visit" }] }] }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }),
  );
}

beforeAll(async () => {
  app = await createTestApp();
  const db = getDb(process.env.DATABASE_URL as string);
  const suffix = Date.now().toString(36);
  const [org] = await db.insert(organizations).values({ type: "team", name: `daw-${suffix}` }).returning({ id: organizations.id });
  orgId = org.id;
  const mkUser = async (email: string, role: "owner" | "viewer" | "operator") => {
    const [u] = await db.insert(users).values({ email: `${suffix}-${email}`, displayName: email }).returning({ id: users.id });
    await db.insert(organizationMemberships).values({ organizationId: orgId, userId: u.id, role });
    return u.id;
  };
  ownerId = await mkUser("owner@example.com", "owner");
  memberId = await mkUser("member@example.com", "operator");
  viewerId = await mkUser("viewer@example.com", "viewer");
  const svc: AuthService = app.get(AuthService);
  ownerBearer = (await svc.mintPair(ownerId)).accessToken;
  memberBearer = (await svc.mintPair(memberId)).accessToken;
  viewerBearer = (await svc.mintPair(viewerId)).accessToken;
  void memberId;
});

afterEach(() => {
  healthOk = true;
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await app.close();
  await closePool();
});

const RANGE = { from: "2026-09-01T00:00:00.000Z", to: "2026-09-02T00:00:00.000Z" };

describe("dawarich overlay", () => {
  it("connect ok → status masks key; dead instance → 422", async () => {
    mockDawarich();
    const ok = await authed(ownerBearer).post("/dawarich/connect").send({ baseUrl: "http://daw:3000", apiKey: "secret-key-123" });
    expect(ok.status).toBe(200);
    const status = await authed(ownerBearer).get("/dawarich/status");
    expect(status.body).toMatchObject({ connected: true, baseUrl: "http://daw:3000" });
    expect(JSON.stringify(status.body)).not.toContain("secret-key-123");
    healthOk = false;
    const bad = await authed(memberBearer).post("/dawarich/connect").send({ baseUrl: "http://bad:3000", apiKey: "nope-nope-nope" });
    expect(bad.status).toBe(422);
  });

  it("timeline merges provider days with own readings", async () => {
    mockDawarich();
    await authed(memberBearer).post("/dawarich/connect").send({ baseUrl: "http://daw:3000", apiKey: "member-key-123456" });
    const authedPatch = (token: string) => {
      const base = request(app.getHttpServer());
      return (p: string) =>
        base.patch(p).set("Authorization", `Bearer ${token}`).set("x-org-id", orgId);
    };
    const api = authed(memberBearer);
    const dev = await api.post("/devices").send({ serialNumber: `DAW-${Date.now()}` });
    const devId = (dev.body as { id: string }).id;
    await authedPatch(memberBearer)(`/devices/${devId}`).send({ status: "active" });
    const sess = await api.post("/sessions").send({
      deviceId: devId,
      subjectUserId: memberId,
      clientSessionId: `cs-${Date.now()}`,
    });
    const sessionId = (sess.body as { session: { id: string } }).session.id;
    await api.post(`/sessions/${sessionId}/complete`).send({ bacPromille: 0.3, measuredAt: "2026-09-01T12:00:00.000Z" });
    const tl = await api.get(`/dawarich/timeline?from=${RANGE.from}&to=${RANGE.to}`);
    expect(tl.status).toBe(200);
    const day = (tl.body.days as { date: string; entries: unknown[]; readings: { bacPromille: string }[] }[]).find(
      (d) => d.date === "2026-09-01",
    );
    expect(day).toBeTruthy();
    expect(day?.entries).toHaveLength(1);
    expect(day?.readings).toHaveLength(1);
    expect(Number(day?.readings[0].bacPromille)).toBeCloseTo(0.3, 5);
  });

  it("unlinked user timeline → 422; disconnect wipes", async () => {
    mockDawarich();
    expect((await authed(viewerBearer).get(`/dawarich/timeline?from=${RANGE.from}&to=${RANGE.to}`)).status).toBe(422);
    const del = await authed(memberBearer).delete("/dawarich/disconnect");
    expect(del.status).toBe(200);
    const status = await authed(memberBearer).get("/dawarich/status");
    expect(status.body).toMatchObject({ connected: false });
    expect((await authed(memberBearer).get(`/dawarich/timeline?from=${RANGE.from}&to=${RANGE.to}`)).status).toBe(422);
  });

  it("team timeline shows linked members, skips unlinked; viewer → 403", async () => {
    mockDawarich();
    await authed(ownerBearer).post("/dawarich/connect").send({ baseUrl: "http://daw:3000", apiKey: "owner-key-1234567" });
    const team = await authed(ownerBearer).get(`/dawarich/team-timeline?from=${RANGE.from}&to=${RANGE.to}`);
    expect(team.status).toBe(200);
    const ids = (team.body.users as { userId: string }[]).map((u) => u.userId);
    expect(ids).toContain(ownerId);
    expect(ids).not.toContain(viewerId);
    expect((await authed(viewerBearer).get(`/dawarich/team-timeline?from=${RANGE.from}&to=${RANGE.to}`)).status).toBe(403);
  });
});
