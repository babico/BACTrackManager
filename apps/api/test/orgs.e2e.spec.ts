import { INestApplication } from "@nestjs/common";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { closePool, eq, getDb, users, organizations, organizationMemberships } from "@bactrack/db";
import { AuthService } from "../src/auth/auth.service.js";
import { createTestApp } from "./bootstrap.js";

let app: INestApplication;

let orgId = "";
let ownerId = "";
let viewerId = "";
let subjectId = "";
let ownerAuth = "";
let viewerAuth = "";
let subjectAuth = "";

const authed = (token: string, org: string) => {
  const base = request(app.getHttpServer());
  const auth = <T extends { set(k: string, v: string): T }>(r: T): T =>
    r.set("Authorization", `Bearer ${token}`).set("x-org-id", org);
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
  const [org] = await db
    .insert(organizations)
    .values({ type: "team", name: `org-${suffix}` })
    .returning({ id: organizations.id });
  orgId = org.id;
  const mkUser = async (email: string, role: "owner" | "viewer" | "operator") => {
    const [u] = await db
      .insert(users)
      .values({ email: `${suffix}-${email}`, displayName: email })
      .returning({ id: users.id });
    await db.insert(organizationMemberships).values({ organizationId: orgId, userId: u.id, role });
    return u.id;
  };
  ownerId = await mkUser("owner@example.com", "owner");
  viewerId = await mkUser("viewer@example.com", "viewer");
  subjectId = await mkUser("subject@example.com", "operator");
  const svc: AuthService = app.get(AuthService);
  ownerAuth = (await svc.mintPair(ownerId)).accessToken;
  viewerAuth = (await svc.mintPair(viewerId)).accessToken;
  subjectAuth = (await svc.mintPair(subjectId)).accessToken;
});

afterAll(async () => {
  await app.close();
  await closePool();
});

describe("orgs", () => {
  it("lists members", async () => {
    const res = await authed(ownerAuth, orgId).get("/orgs/members");
    expect(res.status).toBe(200);
    expect(res.body.members).toHaveLength(3);
  });

  it("owner invites, matching user accepts, second accept 409", async () => {
    const inviteEmail = `${Date.now()}-new@example.com`;
    const created = await authed(ownerAuth, orgId).post("/orgs/invites").send({ email: inviteEmail, role: "operator" });
    expect(created.status).toBe(200);
    const token = created.body.devToken as string;
    expect(token).toBeTruthy();
    const svc: AuthService = app.get(AuthService);
    const { user } = await svc.registerOrLogin({ email: inviteEmail, displayName: "new" });
    const userAuth = (await svc.mintPair(user.id)).accessToken;
    const plain = request(app.getHttpServer());
    const first = await plain.post("/invites/accept").set("Authorization", `Bearer ${userAuth}`).send({ token });
    expect(first.status).toBe(200);
    expect(first.body.organizationId).toBe(orgId);
    const members = await authed(ownerAuth, orgId).get("/orgs/members");
    expect(members.body.members).toHaveLength(4);
    expect((await plain.post("/invites/accept").set("Authorization", `Bearer ${userAuth}`).send({ token })).status).toBe(409);
  });

  it("viewer cannot invite (403)", async () => {
    const res = await authed(viewerAuth, orgId).post("/orgs/invites").send({ email: "x@example.com", role: "viewer" });
    expect(res.status).toBe(403);
  });

  it("accept with mismatched email → 403", async () => {
    const inviteEmail = `${Date.now()}-other@example.com`;
    const created = await authed(ownerAuth, orgId).post("/orgs/invites").send({ email: inviteEmail, role: "viewer" });
    const res = await authed(subjectAuth, orgId).post("/invites/accept").send({ token: created.body.devToken });
    expect(res.status).toBe(403);
  });
});

describe("acknowledgement", () => {
  it("subject acks own reading; operator cannot; repeat idempotent; single GET works", async () => {
    const api = authed(ownerAuth, orgId);
    const dev = await api.post("/devices").send({ serialNumber: `ACK-${Date.now()}` });
    await api.patch(`/devices/${dev.body.id}`).send({ status: "active" });
    const sess = await api.post("/sessions").send({
      deviceId: dev.body.id,
      subjectUserId: subjectId,
      clientSessionId: `cs-${Date.now()}`,
    });
    const done = await api
      .post(`/sessions/${sess.body.session.id}/complete`)
      .send({ bacPromille: 0.2, measuredAt: new Date().toISOString() });
    const readingId = done.body.reading.id as string;

    const byOperator = await authed(ownerAuth, orgId).post(`/readings/${readingId}/acknowledge`).send({});
    expect(byOperator.status).toBe(403);

    const sub = authed(subjectAuth, orgId);
    const first = await sub.post(`/readings/${readingId}/acknowledge`).send({});
    expect(first.status).toBe(200);
    expect(first.body.reading.acknowledgedAt).toBeTruthy();
    const second = await sub.post(`/readings/${readingId}/acknowledge`).send({});
    expect(second.status).toBe(200);

    const one = await sub.get(`/readings/${readingId}`);
    expect(one.status).toBe(200);
    expect(one.body.reading.id).toBe(readingId);
  });
});
