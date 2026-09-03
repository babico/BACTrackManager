import { INestApplication } from "@nestjs/common";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { closePool, getDb, users, organizations, organizationMemberships } from "@bactrack/db";
import { AuthService } from "../src/auth/auth.service.js";
import { createTestApp } from "./bootstrap.js";

let app: INestApplication;

let orgId = "";
let ownerId = "";
let subjectId = "";
let ownerBearer = "";

const authed = (token: string) => {
  const base = request(app.getHttpServer());
  const auth = <T extends { set(k: string, v: string): T }>(r: T): T =>
    r.set("Authorization", `Bearer ${token}`).set("x-org-id", orgId);
  return {
    get: (p: string) => auth(base.get(p)),
    post: (p: string) => auth(base.post(p)),
    patch: (p: string) => auth(base.patch(p)),
  };
};

beforeAll(async () => {
  app = await createTestApp();
  const db = getDb(process.env.DATABASE_URL as string);
  const suffix = Date.now().toString(36);
  const [org] = await db.insert(organizations).values({ type: "team", name: `exp-${suffix}` }).returning({ id: organizations.id });
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
  void subjectId;

  const api = authed(ownerBearer);
  const dev = await api.post("/devices").send({ serialNumber: `EXP-${suffix}` });
  await api.patch(`/devices/${dev.body.id}`).send({ status: "active" });
  const sess = await api.post("/sessions").send({
    deviceId: dev.body.id,
    subjectUserId: subjectId,
    clientSessionId: `cs-${suffix}`,
  });
  await api.post(`/sessions/${sess.body.session.id}/complete`).send({ bacPromille: 0.51, measuredAt: "2026-09-01T10:00:00.000Z" });
});

afterAll(async () => {
  await app.close();
  await closePool();
});

describe("exports", () => {
  it("csv has header + row with origin", async () => {
    const csv = await authed(ownerBearer).get("/exports/readings.csv");
    expect(csv.status).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    const lines = (csv.text as string).trim().split("\n");
    expect(lines[0]).toContain("bac_promille");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("0.510");
    expect(lines[1]).toContain("managed");
  });

  it("pdf starts with %PDF and audit records export", async () => {
    const pdf = await authed(ownerBearer).get("/exports/readings.pdf").buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(pdf.status).toBe(200);
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe("%PDF");
    const audit = await authed(ownerBearer).get("/audit?entityType=export");
    expect(audit.body.entries.length).toBeGreaterThanOrEqual(2);
  });
});
