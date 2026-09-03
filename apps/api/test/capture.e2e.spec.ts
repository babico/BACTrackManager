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
