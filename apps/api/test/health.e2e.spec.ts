import { describe, expect, it } from "vitest";
import request from "supertest";

const base = process.env.API_E2E_BASE ?? "http://127.0.0.1:3001";

describe("health contract", () => {
  it("GET /health returns ok with db up", async () => {
    const res = await request(base).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", db: "up" });
  });

  it("GET /version returns configured version", async () => {
    const res = await request(base).get("/version");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ version: "0.1.0" });
  });

  it("unknown route uses error envelope", async () => {
    const res = await request(base).get("/nope");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe(404);
    expect(typeof res.body.error.requestId).toBe("string");
  });
});
