import { INestApplication } from "@nestjs/common";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestApp } from "./bootstrap.js";

let app: INestApplication;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

describe("health contract", () => {
  it("GET /health returns ok with db up", async () => {
    const res = await request(app.getHttpServer()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", db: "up" });
  });

  it("GET /version returns configured version", async () => {
    const res = await request(app.getHttpServer()).get("/version");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ version: process.env.API_VERSION ?? "0.1.0" });
  });

  it("unknown route uses error envelope", async () => {
    const res = await request(app.getHttpServer()).get("/nope");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe(404);
    expect(typeof res.body.error.requestId).toBe("string");
  });
});
