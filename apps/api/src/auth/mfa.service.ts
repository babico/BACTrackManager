import { Injectable, UnauthorizedException } from "@nestjs/common";
import { authenticator } from "otplib";
import jwt from "jsonwebtoken";
import { eq, getDb, users } from "@bactrack/db";
import { hashToken, newOpaqueToken } from "./tokens.js";
import { open, seal } from "./crypto.js";

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

@Injectable()
export class MfaService {
  private db() {
    return getDb(process.env.DATABASE_URL as string);
  }

  async setup(userId: string, email: string): Promise<{ otpauthUrl: string; backupCodes: string[] }> {
    const secret = authenticator.generateSecret();
    const codes = Array.from({ length: 8 }, () => newOpaqueToken(4));
    await this.db()
      .update(users)
      .set({ mfaSecret: seal(encKey(), secret), mfaEnabled: false, mfaBackupHashes: codes.map(hashToken) })
      .where(eq(users.id, userId));
    return { otpauthUrl: authenticator.keyuri(email, "BACTrackManager", secret), backupCodes: codes };
  }

  async verifyCode(userId: string, code: string): Promise<boolean> {
    const rows = await this.db().select().from(users).where(eq(users.id, userId)).limit(1);
    if (rows.length === 0) return false;
    const sealed = rows[0].mfaSecret;
    if (!sealed) return false;
    const user = rows[0];
    let secret: string;
    try {
      secret = open(encKey(), sealed);
    } catch {
      return false;
    }
    if (authenticator.check(code, secret)) return true;
    const hashes = (user.mfaBackupHashes ?? []) as string[];
    const match = hashes.indexOf(hashToken(code));
    if (match === -1) return false;
    hashes.splice(match, 1);
    await this.db().update(users).set({ mfaBackupHashes: hashes }).where(eq(users.id, userId));
    return true;
  }

  mintTicket(userId: string): string {
    return jwt.sign({ sub: userId, purpose: "mfa" }, jwtSecret(), { expiresIn: 300 });
  }

  verifyTicket(ticket: string): string {
    try {
      const payload = jwt.verify(ticket, jwtSecret()) as { sub?: unknown; purpose?: unknown };
      if (typeof payload.sub !== "string" || payload.purpose !== "mfa") throw new Error("bad ticket");
      return payload.sub;
    } catch {
      throw new UnauthorizedException("invalid or expired challenge");
    }
  }

  async enable(userId: string, code: string): Promise<{ enabled: boolean }> {
    if (!(await this.verifyCode(userId, code))) {
      throw new UnauthorizedException("invalid code");
    }
    await this.db().update(users).set({ mfaEnabled: true }).where(eq(users.id, userId));
    return { enabled: true };
  }

  async disable(userId: string): Promise<{ disabled: boolean }> {
    await this.db()
      .update(users)
      .set({ mfaEnabled: false, mfaSecret: null, mfaBackupHashes: [] })
      .where(eq(users.id, userId));
    return { disabled: true };
  }

  async isEnabled(userId: string): Promise<boolean> {
    const rows = await this.db().select({ enabled: users.mfaEnabled }).from(users).where(eq(users.id, userId)).limit(1);
    return rows.length > 0 && rows[0].enabled;
  }
}
