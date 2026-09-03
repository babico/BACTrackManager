import { createParamDecorator, ExecutionContext } from "@nestjs/common";

export interface OrgContext {
  userId: string;
  organizationId: string;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): OrgContext => {
    return ctx.switchToHttp().getRequest().user as OrgContext;
  },
);
