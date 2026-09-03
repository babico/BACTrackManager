import { INestApplication } from "@nestjs/common";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { closePool, getDb, users, organizations, organizationMemberships } from "@bactrack/db";
import { AuthService } from "../src/auth/auth.service.js";
import { PushService } from "../src/push/push.service.js";
import { createTestApp } from "./bootstrap.js";

let app: INestApplication;

let orgId = "";
let ownerId = "";
let subjectId = "";
let ownerBearer = "";
let subjectBearer = "";

const authed = (token: string) => {
  const base = request(app.getHttpServer());
  const auth = <T extends { set(k: string, v: string): T }>(r: T): T =>
    r.set("Authorization", `Bearer ${token}`).set("x-org-id", orgId);
  return {
    get: (p: string) => auth(base.get(p)),
    post: (p: string) => auth(base.post(p)),
    patch: (p: string) => auth(base.patch(p)),
    delete: (p: string) => auth(base.delete(p)),
  };
};

const SUB = { endpoint: "https://push.example.com/sub-1", keys: { p256dh: "p256", auth: "au" } };

beforeAll(async () => {
  app = await createTestApp();
  const db = getDb(process.env.DATABASE_URL as string);
  const suffix = Date.now().toString(36);
  const [org] = await db.insert(organizations).values({ type: "team", name: `push-${suffix}` }).returning({ id: organizations.id });
  orgId = org.id;
  const mkUser = async (email: string, role: "owner" | "operator") => {
    const [u] = await db.insert(users).values({ email: `${suffix}-${email}`, displayName: email }).returning({ id: users.id });
    await db.insert(organizationMemberships).values({ organizationId: orgId, userId: u.id, role });
    return u.id;
  };
  ownerId = await mkUser("owner@example.com", "owner");
  subjectId = await mkUser("subject@example.com", "operator");
  const svc: AuthService = app.get(AuthService);
  ownerBearer = (await svc.mintPair(ownerId)).accessToken;
  subjectBearer = (await svc.mintPair(subjectId)).accessToken;
});

afterAll(async () => {
  await app.close();
  await closePool();
});

describe("push", () => {
  it("subscribe → list (no keys) → unsubscribe", async () => {
    const api = authed(ownerBearer);
    const sub = await api.post("/push/subscriptions").send(SUB);
    expect(sub.status).toBe(201);
    const list = await api.get("/push/subscriptions");
    expect(list.body.subscriptions).toHaveLength(1);
    expect(list.body.subscriptions[0].endpoint).toBe(SUB.endpoint);
    expect(list.body.subscriptions[0].keys).toBeUndefined();
    const del = await api.delete("/push/subscriptions").send({ endpoint: SUB.endpoint });
    expect(del.status).toBe(200);
    expect((await api.get("/push/subscriptions")).body.subscriptions).toHaveLength(0);
  });

  it("completion fans out to managers with reading payload", async () => {
    const sent: { target: unknown; payload: string }[] = [];
    const push: PushService = app.get(PushService);
    const withFake = new (push.constructor as new (t: unknown) => PushService)(async (target: unknown, payload: string) => {
      sent.push({ target, payload });
    });
    const ownerApi = authed(ownerBearer);
    await ownerApi.post("/push/subscriptions").send(SUB);
    const sub = authed(subjectBearer);
    const dev = await sub.post("/devices").send({ serialNumber: `PUSH-${Date.now()}` });
    await sub.patch(`/devices/${dev.body.id}`).send({ status: "active" });
    const sess = await sub.post("/sessions").send({
      deviceId: dev.body.id,
      subjectUserId: subjectId,
      clientSessionId: `cs-${Date.now()}`,
    });
    const done = await sub
      .post(`/sessions/${sess.body.session.id}/complete`)
      .send({ bacPromille: 0.77, measuredAt: new Date().toISOString() });
    const reading = done.body.reading as { id: string; subjectUserId: string; operatorUserId: string; bacPromille: string };
    await withFake.notifyReading({
      organizationId: orgId,
      operatorUserId: reading.operatorUserId,
      subjectUserId: reading.subjectUserId,
      subjectEmail: "subject@example.com",
      bacPromille: Number(reading.bacPromille),
      readingId: reading.id,
    });
    expect(sent).toHaveLength(1);
    const payload = JSON.parse(sent[0].payload) as { title: string; body: string; readingId: string };
    expect(payload.readingId).toBe(reading.id);
    expect(payload.body).toContain("0.770");
  });

  it("subjectBearer subscribe works (member self-manage)", async () => {
    const res = await authed(subjectBearer)
      .post("/push/subscriptions")
      .send({ endpoint: "https://push.example.com/sub-2", keys: { p256dh: "x", auth: "y" } });
    expect(res.status).toBe(201);
  });
});
