import { INestApplication } from "@nestjs/common";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { closePool, getDb, users, organizations, organizationMemberships } from "@bactrack/db";
import { createTestApp } from "./bootstrap.js";

let app: INestApplication;
const api = () => request(app.getHttpServer());

let orgId = "";
let operatorId = "";
let subjectId = "";

beforeAll(async () => {
  app = await createTestApp();
  const db = getDb(process.env.DATABASE_URL as string);
  const suffix = Date.now().toString(36);
  const [org] = await db
    .insert(organizations)
    .values({ type: "team", name: `e2e-${suffix}` })
    .returning({ id: organizations.id });
  orgId = org.id;
  const mkUser = async (email: string, name: string) => {
    const [u] = await db
      .insert(users)
      .values({ email: `${suffix}-${email}`, displayName: name })
      .returning({ id: users.id });
    await db
      .insert(organizationMemberships)
      .values({ organizationId: orgId, userId: u.id, role: "owner" });
    return u.id;
  };
  operatorId = await mkUser("op@example.com", "Op");
  subjectId = await mkUser("sub@example.com", "Sub");
  process.env.DEV_USER_ID = operatorId;
  process.env.DEV_ORG_ID = orgId;
});

afterAll(async () => {
  await app.close();
  await closePool();
});

describe("devices", () => {
  it("registers a C6 by serial", async () => {
    const res = await api()
      .post("/devices")
      .send({ serialNumber: `SN-${Date.now()}`, model: "C6" });
    expect(res.status).toBe(201);
    expect(res.body.serialNumber).toContain("SN-");
    expect(res.body.status).toBe("provisioned");
  });

  it("rejects duplicate serial with 409", async () => {
    const sn = `DUP-${Date.now()}`;
    await api().post("/devices").send({ serialNumber: sn });
    const res = await api().post("/devices").send({ serialNumber: sn });
    expect(res.status).toBe(409);
  });
});

describe("sessions and leases", () => {
  it("creates session + lease atomically and second acquire races to 409", async () => {
    const sn = `RACE-${Date.now()}`;
    const dev = await api().post("/devices").send({ serialNumber: sn });
    await api().patch(`/devices/${dev.body.id}`).send({ status: "active" });
    const payload = {
      deviceId: dev.body.id,
      subjectUserId: subjectId,
      clientSessionId: `cs-${Date.now()}`,
    };
    const [a, b] = await Promise.all([
      api().post("/sessions").send(payload),
      api().post("/sessions").send({ ...payload, clientSessionId: `cs2-${Date.now()}` }),
    ]);
    const codes = [a.status, b.status].sort();
    expect(codes).toEqual([201, 409]);
  });

  it("rejects session for unknown subject with 422", async () => {
    const sn = `UNK-${Date.now()}`;
    const dev = await api().post("/devices").send({ serialNumber: sn });
    await api().patch(`/devices/${dev.body.id}`).send({ status: "active" });
    const res = await api().post("/sessions").send({
      deviceId: dev.body.id,
      subjectUserId: "00000000-0000-4000-8000-000000000000",
      clientSessionId: `cs-${Date.now()}`,
    });
    expect(res.status).toBe(422);
  });
});

describe("completion and readings", () => {
  it("completes a session into exactly one reading, retry is duplicate", async () => {
    const sn = `CMP-${Date.now()}`;
    const dev = await api().post("/devices").send({ serialNumber: sn });
    await api().patch(`/devices/${dev.body.id}`).send({ status: "active" });
    const sess = await api().post("/sessions").send({
      deviceId: dev.body.id,
      subjectUserId: subjectId,
      clientSessionId: `cs-${Date.now()}`,
    });
    const payload = { bacPromille: 0.42, measuredAt: new Date().toISOString(), rawPayload: { fake: true } };
    const first = await api().post(`/sessions/${sess.body.session.id}/complete`).send(payload);
    expect(first.status).toBe(200);
    expect(first.body.duplicate).toBe(false);
    const readingId = first.body.reading.id;
    const second = await api().post(`/sessions/${sess.body.session.id}/complete`).send(payload);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.reading.id).toBe(readingId);
    const list = await api().get(`/readings?subjectUserId=${subjectId}`);
    const mine = list.body.readings.filter((r: { id: string }) => r.id === readingId);
    expect(mine).toHaveLength(1);
  });

  it("refuses completion of expired sessions with 409", async () => {
    const sn = `EXP-${Date.now()}`;
    const dev = await api().post("/devices").send({ serialNumber: sn });
    await api().patch(`/devices/${dev.body.id}`).send({ status: "active" });
    const sess = await api().post("/sessions").send({
      deviceId: dev.body.id,
      subjectUserId: subjectId,
      clientSessionId: `cs-${Date.now()}`,
    });
    await api().post(`/sessions/${sess.body.session.id}/expire`);
    const res = await api()
      .post(`/sessions/${sess.body.session.id}/complete`)
      .send({ bacPromille: 0.1, measuredAt: new Date().toISOString() });
    expect(res.status).toBe(409);
  });
});
