import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";

@Injectable()
export class DevIdentityGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    if (process.env.NODE_ENV === "production") {
      throw new ServiceUnavailableException("dev identity disabled in production");
    }
    const userId = process.env.DEV_USER_ID;
    const organizationId = process.env.DEV_ORG_ID;
    if (!userId || !organizationId) {
      throw new UnauthorizedException("DEV_USER_ID and DEV_ORG_ID are required");
    }
    ctx.switchToHttp().getRequest().user = { userId, organizationId };
    return true;
  }
}
