import { INestApplication } from "@nestjs/common";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { authenticator } from "otplib";
import request from "supertest";
import { closePool } from "@bactrack/db";
import { AuthService } from "../src/auth/auth.service.js";
import { createTestApp } from "./bootstrap.js";

let app: INestApplication;

const base = () => request(app.getHttpServer());
const SUFFIX = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const email = `${SUFFIX}-mfa@example.com`;

let userId = "";
let userBearer = "";

function secretFromUrl(url: string): string {
  const u = new URL(url);
  const secret = u.searchParams.get("secret");
  if (!secret) throw new Error("no secret in otpauth url");
  return secret;
}

beforeAll(async () => {
  app = await createTestApp();
  const svc: AuthService = app.get(AuthService);
  const started = await base().post("/auth/magic/start").send({ email });
  const token = (started.body as { devToken: string }).devToken;
  const consumed = await base().get("/auth/magic/consume").query({ token });
  userId = (consumed.body as { user: { id: string } }).user.id;
  userBearer = (consumed.body as { pair: { accessToken: string } }).pair.accessToken;
  void svc;
});

afterAll(async () => {
  await app.close();
  await closePool();
});

const auth = () => {
  const b = request(app.getHttpServer());
  const withAuth = <T extends { set(k: string, v: string): T }>(r: T): T =>
    r.set("Authorization", `Bearer ${userBearer}`);
  return {
    get: (p: string) => withAuth(b.get(p)),
    post: (p: string) => withAuth(b.post(p)),
    delete: (p: string) => withAuth(b.delete(p)),
  };
};

describe("mfa", () => {
  it("setup returns otpauth url + backup codes", async () => {
    const res = await auth().post("/auth/mfa/setup").send({});
    expect(res.status).toBe(200);
    expect(res.body.otpauthUrl).toContain("otpauth://totp/");
    expect(res.body.backupCodes).toHaveLength(8);
  });

  it("enable rejects wrong code, accepts totp", async () => {
    expect((await auth().post("/auth/mfa/enable").send({ code: "000000" })).status).toBe(401);
    const setup = await auth().post("/auth/mfa/setup").send({});
    const code = authenticator.generate(secretFromUrl(setup.body.otpauthUrl as string));
    const res = await auth().post("/auth/mfa/enable").send({ code });
    expect(res.status).toBe(200);
  });

  it("login branches to challenge; wrong code 401, totp ok", async () => {
    const started = await base().post("/auth/magic/start").send({ email });
    const token = (started.body as { devToken: string }).devToken;
    const consumed = await base().get("/auth/magic/consume").query({ token });
    expect(consumed.body.mfaRequired).toBe(true);
    expect(consumed.body.pair).toBeUndefined();
    const ticket = consumed.body.mfaTicket as string;
    expect((await base().post("/auth/mfa/challenge").send({ ticket, code: "000000" })).status).toBe(401);
    const svc: AuthService = app.get(AuthService);
    void svc;
    const setup = await auth().post("/auth/mfa/setup").send({});
    const code = authenticator.generate(secretFromUrl(setup.body.otpauthUrl as string));
    await auth().post("/auth/mfa/enable").send({ code });
    const started2 = await base().post("/auth/magic/start").send({ email });
    const token2 = (started2.body as { devToken: string }).devToken;
    const consumed2 = await base().get("/auth/magic/consume").query({ token: token2 });
    const code2 = authenticator.generate(secretFromUrl(setup.body.otpauthUrl as string));
    const ok = await base()
      .post("/auth/mfa/challenge")
      .send({ ticket: consumed2.body.mfaTicket, code: code2 });
    expect(ok.status).toBe(200);
    expect(ok.body.accessToken).toBeTruthy();
  });

  it("backup code works once", async () => {
    const setup = await auth().post("/auth/mfa/setup").send({});
    const codes = setup.body.backupCodes as string[];
    await auth().post("/auth/mfa/enable").send({ code: authenticator.generate(secretFromUrl(setup.body.otpauthUrl as string)) });
    const started = await base().post("/auth/magic/start").send({ email });
    const token = (started.body as { devToken: string }).devToken;
    const consumed = await base().get("/auth/magic/consume").query({ token });
    const first = await base().post("/auth/mfa/challenge").send({ ticket: consumed.body.mfaTicket, code: codes[0] });
    expect(first.status).toBe(200);
    const started2 = await base().post("/auth/magic/start").send({ email });
    const token2 = (started2.body as { devToken: string }).devToken;
    const consumed2 = await base().get("/auth/magic/consume").query({ token: token2 });
    expect(
      (await base().post("/auth/mfa/challenge").send({ ticket: consumed2.body.mfaTicket, code: codes[0] })).status,
    ).toBe(401);
  });

  it("disable restores direct login", async () => {
    expect((await auth().delete("/auth/mfa")).status).toBe(200);
    const started = await base().post("/auth/magic/start").send({ email });
    const token = (started.body as { devToken: string }).devToken;
    const consumed = await base().get("/auth/magic/consume").query({ token });
    expect((consumed.body as { pair: { accessToken: string } }).pair.accessToken).toBeTruthy();
    expect(consumed.body.mfaRequired).toBeUndefined();
  });
});
