import { INestApplication } from "@nestjs/common";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { closePool } from "@bactrack/db";
import { createTestApp } from "./bootstrap.js";

let app: INestApplication;
const base = () => request(app.getHttpServer());

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
  await closePool();
});

describe("rate limits and headers", () => {
  it("throttles magic/start bursts with 429 envelope", async () => {
    const tag = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    let last = 0;
    for (let i = 0; i < 21; i++) {
      const res = await base().post("/auth/magic/start").send({ email: `${tag}-${i}@example.com` });
      last = res.status;
    }
    expect(last).toBe(429);
  }, 60000);

  it("serves security headers, hides powered-by", async () => {
    const res = await base().get("/health");
    expect(res.status).toBe(200);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });
});
