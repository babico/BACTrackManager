import { INestApplication } from "@nestjs/common";
import { describe, expect, it, beforeAll, afterAll, vi, afterEach } from "vitest";
import request from "supertest";
import { closePool, eq, getDb, magicLinks, users } from "@bactrack/db";
import { AuthService } from "../src/auth/auth.service.js";
import { hashToken, newOpaqueToken } from "../src/auth/tokens.js";
import { createTestApp } from "./bootstrap.js";

let app: INestApplication;
const base = () => request(app.getHttpServer());
const SUFFIX = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const email = `${SUFFIX}-auth@example.com`;

beforeAll(async () => {
  app = await createTestApp();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await app.close();
  await closePool();
});

function jwtSub(token: string): string {
  const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as { sub: string };
  return payload.sub;
}

async function orgOf(accessToken: string): Promise<string> {
  const svc: AuthService = app.get(AuthService);
  const me = await svc.me(jwtSub(accessToken));
  return me.organizations[0].id as string;
}

async function magicPair(forEmail: string = email) {
  const start = await base().post("/auth/magic/start").send({ email: forEmail });
  const token = start.body.devToken as string;
  const consumed = await base().get("/auth/magic/consume").query({ token });
  const body = consumed.body as { pair: { accessToken: string; refreshToken: string }; user: { id: string } };
  return { accessToken: body.pair.accessToken, refreshToken: body.pair.refreshToken, user: body.user };
}

describe("magic link", () => {
  it("start → consume → me", async () => {
    const { accessToken, user } = await magicPair();
    expect(user.email).toBe(email);
    const org = await orgOf(accessToken);
    const me = await base().get("/auth/me").set("Authorization", `Bearer ${accessToken}`).set("x-org-id", org);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(email);
    expect(me.body.organizations).toHaveLength(1);
    expect(me.body.organizations[0].type).toBe("personal");
    expect(me.body.bactrackLinked).toBe(false);
  });

  it("consume twice → second 401", async () => {
    const start = await base().post("/auth/magic/start").send({ email: `${SUFFIX}-twice@example.com` });
    const token = start.body.devToken as string;
    expect((await base().get("/auth/magic/consume").query({ token })).status).toBe(200);
    expect((await base().get("/auth/magic/consume").query({ token })).status).toBe(401);
  });

  it("expired token → 401", async () => {
    const db = getDb(process.env.DATABASE_URL as string);
    const em = `${SUFFIX}-exp@example.com`;
    const svc: AuthService = app.get(AuthService);
    await svc.registerOrLogin({ email: em, displayName: "exp" });
    const u = await db.select().from(users).where(eq(users.email, em)).limit(1);
    const raw = newOpaqueToken(24);
    await db.insert(magicLinks).values({
      userId: u[0].id,
      tokenHash: hashToken(raw),
      expiresAt: new Date(Date.now() - 1000),
    });
    expect((await base().get("/auth/magic/consume").query({ token: raw })).status).toBe(401);
  });
});

describe("refresh rotation", () => {
  it("rotates; old refresh dies", async () => {
    const { refreshToken } = await magicPair(`${SUFFIX}-rot@example.com`);
    const r1 = await base().post("/auth/refresh").send({ refreshToken });
    expect(r1.status).toBe(200);
    expect(r1.body.accessToken).toBeTruthy();
    expect((await base().post("/auth/refresh").send({ refreshToken })).status).toBe(401);
  });

  it("reuse of rotated token kills family", async () => {
    const { refreshToken: r0 } = await magicPair(`${SUFFIX}-kill@example.com`);
    const r1 = (await base().post("/auth/refresh").send({ refreshToken: r0 })).body.refreshToken as string;
    expect((await base().post("/auth/refresh").send({ refreshToken: r0 })).status).toBe(401);
    expect((await base().post("/auth/refresh").send({ refreshToken: r1 })).status).toBe(401);
  });

  it("logout revokes", async () => {
    const { refreshToken } = await magicPair(`${SUFFIX}-out@example.com`);
    expect((await base().post("/auth/logout").send({ refreshToken })).status).toBe(200);
    expect((await base().post("/auth/refresh").send({ refreshToken })).status).toBe(401);
  });
});

describe("guard", () => {
  it("no token → 401, bad token → 401, missing org → 403", async () => {
    expect((await base().get("/devices")).status).toBe(401);
    expect((await base().get("/devices").set("Authorization", "Bearer junk")).status).toBe(401);
    const { accessToken } = await magicPair(`${SUFFIX}-nog@example.com`);
    expect((await base().get("/devices").set("Authorization", `Bearer ${accessToken}`)).status).toBe(403);
  });

  it("foreign org → 403", async () => {
    const { accessToken } = await magicPair(`${SUFFIX}-for@example.com`);
    const res = await base()
      .get("/devices")
      .set("Authorization", `Bearer ${accessToken}`)
      .set("x-org-id", "00000000-0000-4000-8000-000000000000");
    expect(res.status).toBe(403);
  });
});

describe("bactrack pkce", () => {
  it("start returns authorize url with challenge", async () => {
    const res = await base().post("/auth/bactrack/start").send({ redirectUri: "http://127.0.0.1:9/cb" });
    expect(res.status).toBe(200);
    expect(res.body.url).toContain("/authorize?");
    expect(res.body.url).toContain("code_challenge=");
    expect(res.body.state).toBeTruthy();
  });

  it("callback with mocked provider links identity", async () => {
    const redirectUri = "http://127.0.0.1:9/cb";
    const started = await base().post("/auth/bactrack/start").send({ redirectUri });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const u = String(url);
        if (u.includes("/oauth/token")) {
          return { ok: true, status: 200, json: async () => ({ access_token: "prov-access", refresh_token: "prov-refresh", token_type: "Bearer", expires_in: 3600 }) };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: `prov-${SUFFIX}`, email: `${SUFFIX}-prov@example.com`, firstName: "Prov", lastName: "User" }),
        };
      }),
    );
    const cb = await base()
      .get("/auth/bactrack/callback")
      .query({ code: "authcode", state: started.body.state, redirect_uri: redirectUri });
    expect(cb.status).toBe(200);
    expect(cb.body.pair.accessToken).toBeTruthy();
    const org = await orgOf(cb.body.pair.accessToken as string);
    const me = await base().get("/auth/me").set("Authorization", `Bearer ${cb.body.pair.accessToken}`).set("x-org-id", org);
    expect(me.body.bactrackLinked).toBe(true);
  });

  it("callback with bad state → 401", async () => {
    const res = await base()
      .get("/auth/bactrack/callback")
      .query({ code: "x", state: "nope", redirect_uri: "http://127.0.0.1:9/cb" });
    expect(res.status).toBe(401);
  });

  it("unlink wipes ciphertext", async () => {
    const redirectUri = "http://127.0.0.1:9/cb";
    const started = await base().post("/auth/bactrack/start").send({ redirectUri });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const u = String(url);
        if (u.includes("/oauth/token")) {
          return { ok: true, status: 200, json: async () => ({ access_token: "a", refresh_token: "r", token_type: "Bearer", expires_in: 1 }) };
        }
        return { ok: true, status: 200, json: async () => ({ id: `prov2-${SUFFIX}`, email: `${SUFFIX}-prov2@example.com` }) };
      }),
    );
    const cb = await base()
      .get("/auth/bactrack/callback")
      .query({ code: "c", state: started.body.state, redirect_uri: redirectUri });
    const token = cb.body.pair.accessToken as string;
    const org = await orgOf(token);
    const del = await base().delete("/auth/bactrack").set("Authorization", `Bearer ${token}`).set("x-org-id", org);
    expect(del.status).toBe(200);
    const me = await base().get("/auth/me").set("Authorization", `Bearer ${token}`).set("x-org-id", org);
    expect(me.body.bactrackLinked).toBe(false);
  });
});
