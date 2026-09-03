import {
  Injectable,
  UnauthorizedException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import jwt from "jsonwebtoken";
import {
  and,
  bactrackIdentities,
  eq,
  getDb,
  magicLinks,
  organizationMemberships,
  organizations,
  refreshTokens,
  users,
} from "@bactrack/db";
import { hashToken, newOpaqueToken } from "./tokens.js";
import { open, seal } from "./crypto.js";

const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_MS = 30 * 24 * 3600 * 1000;
const MAGIC_TTL_MS = 15 * 60 * 1000;
const PKCE_TTL_MS = 10 * 60 * 1000;
const PROVIDER_SCOPE = "openid profile email read:users offline_access";

export interface AuthPair {
  accessToken: string;
  refreshToken: string;
}

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
}

export function verifyAccess(token: string): { sub: string } {
  try {
    const payload = jwt.verify(token, jwtSecret()) as { sub?: unknown };
    if (typeof payload.sub !== "string") throw new Error("no sub");
    return { sub: payload.sub };
  } catch {
    throw new UnauthorizedException("invalid or expired token");
  }
}

function jwtSecret(): string {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET is required");
  return s;
}

function encKey(): string {
  const k = process.env.TOKEN_ENC_KEY;
  if (!k) throw new Error("TOKEN_ENC_KEY is required");
  return k;
}

function providerDomain(): string {
  return process.env.BACTRACK_DOMAIN ?? "https://login.bactrack.com";
}

function providerApi(): string {
  return process.env.BACTRACK_API ?? "https://consumer-api.bactrack.com";
}

function providerClientId(): string {
  const id = process.env.BACTRACK_CLIENT_ID;
  if (!id) throw new UnprocessableEntityException("bactrack login not configured");
  return id;
}

function providerAudience(): string {
  return process.env.BACTRACK_AUDIENCE ?? "https://api.bactrack.com";
}

function codeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

async function postJson(url: string, body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`provider responded ${res.status}`);
  return res.json() as Promise<unknown>;
}

async function getJson(url: string, bearer: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${bearer}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`provider responded ${res.status}`);
  return res.json() as Promise<unknown>;
}

const pendingPkce = new Map<string, { verifier: string; redirectUri: string; expires: number }>();

@Injectable()
export class AuthService {
  private db() {
    return getDb(process.env.DATABASE_URL as string);
  }

  async registerOrLogin(input: { email: string; displayName: string }): Promise<{ user: PublicUser; created: boolean }> {
    const db = this.db();
    const email = input.email.toLowerCase().trim();
    const existing = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (existing.length > 0) {
      const u = existing[0];
      return { user: { id: u.id, email: u.email, displayName: u.displayName }, created: false };
    }
    return db.transaction(async (tx) => {
      const [u] = await tx.insert(users).values({ email, displayName: input.displayName }).returning();
      const [org] = await tx
        .insert(organizations)
        .values({ type: "personal", name: input.displayName })
        .returning({ id: organizations.id });
      await tx.insert(organizationMemberships).values({ organizationId: org.id, userId: u.id, role: "owner" });
      return { user: { id: u.id, email: u.email, displayName: u.displayName }, created: true };
    });
  }

  async mintPair(userId: string): Promise<AuthPair> {
    const accessToken = jwt.sign({ sub: userId }, jwtSecret(), { expiresIn: ACCESS_TTL_SECONDS });
    const refreshToken = newOpaqueToken();
    await this.db()
      .insert(refreshTokens)
      .values({ userId, tokenHash: hashToken(refreshToken), expiresAt: new Date(Date.now() + REFRESH_TTL_MS) });
    return { accessToken, refreshToken };
  }

  async refresh(presented: string): Promise<AuthPair> {
    const db = this.db();
    const rows = await db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hashToken(presented)))
      .limit(1);
    if (rows.length === 0) throw new UnauthorizedException("unknown refresh token");
    const row = rows[0];
    if (row.revokedAt !== null || row.expiresAt.getTime() < Date.now()) {
      if (row.revokedAt !== null) {
        await db
          .update(refreshTokens)
          .set({ revokedAt: new Date() })
          .where(eq(refreshTokens.userId, row.userId));
      }
      throw new UnauthorizedException("refresh token reuse detected");
    }
    const next = newOpaqueToken();
    const [inserted] = await db
      .insert(refreshTokens)
      .values({ userId: row.userId, tokenHash: hashToken(next), expiresAt: new Date(Date.now() + REFRESH_TTL_MS) })
      .returning({ id: refreshTokens.id });
    await db
      .update(refreshTokens)
      .set({ revokedAt: new Date(), replacedBy: inserted.id })
      .where(eq(refreshTokens.id, row.id));
    const accessToken = jwt.sign({ sub: row.userId }, jwtSecret(), { expiresIn: ACCESS_TTL_SECONDS });
    return { accessToken, refreshToken: next };
  }

  async logout(presented: string): Promise<{ revoked: boolean }> {
    const db = this.db();
    const rows = await db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hashToken(presented)))
      .limit(1);
    if (rows.length === 0) return { revoked: false };
    const row = rows[0];
    await db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.id, row.id));
    await this.revokeProviderTokens(row.userId);
    return { revoked: true };
  }

  private async revokeProviderTokens(userId: string): Promise<void> {
    const db = this.db();
    const identities = await db
      .select()
      .from(bactrackIdentities)
      .where(eq(bactrackIdentities.userId, userId));
    for (const ident of identities) {
      if (!ident.encryptedRefresh) continue;
      try {
        const refresh = open(encKey(), ident.encryptedRefresh);
        await postJson(`${providerDomain()}/oauth/revoke`, {
          token: refresh,
          client_id: providerClientId(),
        });
      } catch {
        // best effort only
      }
    }
  }

  async unlinkProvider(userId: string): Promise<{ unlinked: boolean }> {
    await this.revokeProviderTokens(userId);
    const db = this.db();
    await db
      .update(bactrackIdentities)
      .set({ encryptedAccess: null, encryptedRefresh: null })
      .where(eq(bactrackIdentities.userId, userId));
    return { unlinked: true };
  }

  async magicStart(email: string): Promise<{ sent: boolean; devToken?: string }> {
    const normalized = email.toLowerCase().trim();
    const prefix = normalized.split("@")[0] || "user";
    await this.registerOrLogin({ email: normalized, displayName: prefix });
    const db = this.db();
    const userRows = await db.select().from(users).where(eq(users.email, normalized)).limit(1);
    const token = newOpaqueToken(24);
    await db.insert(magicLinks).values({
      userId: userRows[0].id,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + MAGIC_TTL_MS),
    });
    const masked = normalized.replace(/^(.).*(@.*)$/, "$1***$2");
    // eslint-disable-next-line no-console
    console.log(`magic link for ${masked} ready`);
    if (process.env.ALLOW_DEV_MAGIC_TOKEN === "true") {
      return { sent: true, devToken: token };
    }
    return { sent: true };
  }

  async magicConsume(token: string): Promise<{ pair: AuthPair; user: PublicUser }> {
    const db = this.db();
    const rows = await db
      .select()
      .from(magicLinks)
      .where(eq(magicLinks.tokenHash, hashToken(token)))
      .limit(1);
    if (rows.length === 0) throw new UnauthorizedException("unknown magic token");
    const row = rows[0];
    if (row.consumedAt !== null || row.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException("magic token invalid or expired");
    }
    const userRows = await db.select().from(users).where(eq(users.id, row.userId)).limit(1);
    const user = userRows[0];
    await db.update(magicLinks).set({ consumedAt: new Date() }).where(eq(magicLinks.id, row.id));
    const pair = await this.mintPair(user.id);
    return { pair, user: { id: user.id, email: user.email, displayName: user.displayName } };
  }

  bactrackStart(redirectUri: string): { url: string; state: string } {
    const clientId = providerClientId();
    const verifier = newOpaqueToken(32);
    const state = newOpaqueToken(16);
    pendingPkce.set(state, { verifier, redirectUri, expires: Date.now() + PKCE_TTL_MS });
    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      code_challenge: codeChallenge(verifier),
      code_challenge_method: "S256",
      redirect_uri: redirectUri,
      scope: PROVIDER_SCOPE,
      audience: providerAudience(),
      state,
    });
    return { url: `${providerDomain()}/authorize?${params.toString()}`, state };
  }

  async bactrackCallback(
    code: string,
    state: string,
    redirectUri: string,
  ): Promise<{ pair: AuthPair; user: PublicUser }> {
    const pending = pendingPkce.get(state);
    pendingPkce.delete(state);
    if (!pending || pending.expires < Date.now() || pending.redirectUri !== redirectUri) {
      throw new UnauthorizedException("invalid or expired login state");
    }
    let tokenJson: { access_token?: unknown; refresh_token?: unknown };
    try {
      tokenJson = (await postJson(`${providerDomain()}/oauth/token`, {
        grant_type: "authorization_code",
        code,
        client_id: providerClientId(),
        code_verifier: pending.verifier,
        redirect_uri: redirectUri,
      })) as { access_token?: unknown; refresh_token?: unknown };
    } catch {
      throw new UnauthorizedException("bactrack exchange failed");
    }
    if (typeof tokenJson.access_token !== "string") {
      throw new UnauthorizedException("bactrack exchange failed");
    }
    let me: { id?: unknown; email?: unknown; firstName?: unknown; lastName?: unknown };
    try {
      me = (await getJson(`${providerApi()}/api/v1/users/me`, tokenJson.access_token)) as typeof me;
    } catch {
      throw new UnauthorizedException("bactrack profile fetch failed");
    }
    if (typeof me.id !== "string" || typeof me.email !== "string") {
      throw new UnauthorizedException("bactrack profile fetch failed");
    }
    const displayName =
      [me.firstName, me.lastName].filter((p) => typeof p === "string" && p.length > 0).join(" ") ||
      me.email.split("@")[0];
    const db = this.db();
    const byIdentity = await db
      .select()
      .from(bactrackIdentities)
      .where(eq(bactrackIdentities.providerUserId, me.id))
      .limit(1);
    let userId: string;
    if (byIdentity.length > 0) {
      userId = byIdentity[0].userId;
    } else {
      const { user } = await this.registerOrLogin({ email: me.email, displayName });
      userId = user.id;
    }
    const sealedAccess = seal(encKey(), tokenJson.access_token);
    const sealedRefresh =
      typeof tokenJson.refresh_token === "string" ? seal(encKey(), tokenJson.refresh_token) : null;
    const existing = await db
      .select({ id: bactrackIdentities.id })
      .from(bactrackIdentities)
      .where(eq(bactrackIdentities.providerUserId, me.id))
      .limit(1);
    if (existing.length > 0) {
      await db
        .update(bactrackIdentities)
        .set({ encryptedAccess: sealedAccess, encryptedRefresh: sealedRefresh })
        .where(eq(bactrackIdentities.id, existing[0].id));
    } else {
      await db.insert(bactrackIdentities).values({
        userId,
        providerUserId: me.id,
        encryptedAccess: sealedAccess,
        encryptedRefresh: sealedRefresh,
      });
    }
    const pair = await this.mintPair(userId);
    const userRows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    const u = userRows[0];
    return { pair, user: { id: u.id, email: u.email, displayName: u.displayName } };
  }

  async providerRefresh(userId: string): Promise<string | null> {
    const db = this.db();
    const rows = await db
      .select()
      .from(bactrackIdentities)
      .where(eq(bactrackIdentities.userId, userId))
      .limit(1);
    if (rows.length === 0 || !rows[0].encryptedRefresh) return null;
    try {
      const refresh = open(encKey(), rows[0].encryptedRefresh);
      const res = (await postJson(`${providerDomain()}/oauth/token`, {
        grant_type: "refresh_token",
        refresh_token: refresh,
        client_id: providerClientId(),
      })) as { access_token?: unknown; refresh_token?: unknown };
      if (typeof res.access_token !== "string") return null;
      await db
        .update(bactrackIdentities)
        .set({
          encryptedAccess: seal(encKey(), res.access_token),
          encryptedRefresh:
            typeof res.refresh_token === "string" ? seal(encKey(), res.refresh_token) : rows[0].encryptedRefresh,
        })
        .where(eq(bactrackIdentities.id, rows[0].id));
      return res.access_token;
    } catch {
      return null;
    }
  }

  async me(userId: string) {
    const db = this.db();
    const userRows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (userRows.length === 0) throw new UnauthorizedException("unknown user");
    const u = userRows[0];
    const memberships = await db
      .select({
        id: organizations.id,
        name: organizations.name,
        type: organizations.type,
        role: organizationMemberships.role,
      })
      .from(organizationMemberships)
      .innerJoin(organizations, eq(organizations.id, organizationMemberships.organizationId))
      .where(eq(organizationMemberships.userId, userId));
    const linked = await db
      .select({ id: bactrackIdentities.id })
      .from(bactrackIdentities)
      .where(eq(bactrackIdentities.userId, userId))
      .limit(1);
    return {
      user: { id: u.id, email: u.email, displayName: u.displayName },
      organizations: memberships,
      bactrackLinked: linked.length > 0,
    };
  }
}
