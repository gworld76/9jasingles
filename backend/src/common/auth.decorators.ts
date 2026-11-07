import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const ROLES = 'roles';
export const Roles = (...roles: ('USER' | 'MODERATOR' | 'ADMIN')[]) => SetMetadata(ROLES, roles);

export interface AuthUser {
  id: string;
  role: 'USER' | 'MODERATOR' | 'ADMIN';
}

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().user;
});
