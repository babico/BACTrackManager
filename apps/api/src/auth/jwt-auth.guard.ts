import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { assertMembership, assertUuid } from "../identity/membership.js";
import { verifyAccess } from "./auth.service.js";

@Injectable()
export class JwtAuthGuard implements CanActivate {
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const header: unknown = req.headers?.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) {
      throw new UnauthorizedException("missing bearer token");
    }
    const { sub } = verifyAccess(header.slice(7));
    const orgId: unknown = req.headers?.["x-org-id"];
    if (typeof orgId === "string" && orgId.length > 0) {
      assertUuid(orgId);
      await assertMembership(orgId, sub);
      req.user = { userId: sub, organizationId: orgId };
      return true;
    }
    req.user = { userId: sub, organizationId: "" };
    return true;
  }
}
