import { ConflictException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { and, eq, getDb, organizationMemberships, organizations, teamInvites, users } from "@bactrack/db";
import { appendAudit } from "../common/audit.js";
import { hashToken, newOpaqueToken } from "../auth/tokens.js";

const MANAGE_ROLES = ["owner", "admin"] as const;
const INVITE_ROLES = ["admin", "operator", "viewer"] as const;

@Injectable()
export class OrgsService {
  private db() {
    return getDb(process.env.DATABASE_URL as string);
  }

  async roleOf(organizationId: string, userId: string): Promise<string | null> {
    const rows = await this.db()
      .select({ role: organizationMemberships.role })
      .from(organizationMemberships)
      .where(and(eq(organizationMemberships.organizationId, organizationId), eq(organizationMemberships.userId, userId)))
      .limit(1);
    return rows.length > 0 ? rows[0].role : null;
  }

  async members(organizationId: string) {
    const rows = await this.db()
      .select({
        userId: users.id,
        email: users.email,
        displayName: users.displayName,
        role: organizationMemberships.role,
      })
      .from(organizationMemberships)
      .innerJoin(users, eq(users.id, organizationMemberships.userId))
      .where(eq(organizationMemberships.organizationId, organizationId));
    return { members: rows };
  }

  async invite(organizationId: string, actorUserId: string, email: string, role: string) {
    if (!(INVITE_ROLES as readonly string[]).includes(role)) {
      throw new ConflictException("invalid role");
    }
    const actorRole = await this.roleOf(organizationId, actorUserId);
    if (!actorRole || !(MANAGE_ROLES as readonly string[]).includes(actorRole)) {
      throw new ForbiddenException("invite requires owner or admin");
    }
    const normalized = email.toLowerCase().trim();
    const token = newOpaqueToken(24);
    const [invite] = await this.db()
      .insert(teamInvites)
      .values({
        organizationId,
        email: normalized,
        role: role as "admin" | "operator" | "viewer",
        invitedBy: actorUserId,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      })
      .returning();
    await appendAudit(this.db(), {
      organizationId,
      actorUserId,
      action: "invite.created",
      entityType: "invite",
      entityId: invite.id,
      details: { email: normalized, role },
    });
    const masked = normalized.replace(/^(.).*(@.*)$/, "$1***$2");
    // eslint-disable-next-line no-console
    console.log(`invite for ${masked} ready`);
    if (process.env.ALLOW_DEV_MAGIC_TOKEN === "true") {
      return { invite, devToken: token };
    }
    return { invite };
  }

  async pendingInvites(organizationId: string, actorUserId: string) {
    const actorRole = await this.roleOf(organizationId, actorUserId);
    if (!actorRole || !(MANAGE_ROLES as readonly string[]).includes(actorRole)) {
      throw new ForbiddenException("invite list requires owner or admin");
    }
    const rows = await this.db()
      .select()
      .from(teamInvites)
      .where(and(eq(teamInvites.organizationId, organizationId), eq(teamInvites.status, "pending")));
    return { invites: rows };
  }

  async accept(token: string, userId: string) {
    const db = this.db();
    const rows = await db.select().from(teamInvites).where(eq(teamInvites.tokenHash, hashToken(token))).limit(1);
    if (rows.length === 0) throw new NotFoundException("invite not found");
    const invite = rows[0];
    if (invite.status !== "pending" || invite.expiresAt.getTime() < Date.now()) {
      throw new ConflictException("invite expired or used");
    }
    const me = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (me.length === 0) throw new UnauthorizedException("unknown user");
    if (me[0].email !== invite.email) {
      throw new ForbiddenException("invite belongs to a different email");
    }
    await db.transaction(async (tx) => {
      await tx
        .insert(organizationMemberships)
        .values({ organizationId: invite.organizationId, userId, role: invite.role })
        .onConflictDoNothing();
      await tx.update(teamInvites).set({ status: "accepted" }).where(eq(teamInvites.id, invite.id));
      await appendAudit(tx, {
        organizationId: invite.organizationId,
        actorUserId: userId,
        action: "invite.accepted",
        entityType: "invite",
        entityId: invite.id,
        details: {},
      });
    });
    return { organizationId: invite.organizationId };
  }
}
