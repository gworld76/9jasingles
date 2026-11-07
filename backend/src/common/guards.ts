import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { eq } from 'drizzle-orm';
import { Database, InjectDb } from '../database/database.module';
import { users } from '../database/schema';
import { RedisService } from '../redis/redis.module';
import { IS_PUBLIC, ROLES } from './auth.decorators';

/** Global: every route needs a valid access token unless marked @Public(). */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService, private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;
    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException();
    try {
      const payload = this.jwt.verify<{ sub: string; role: 'USER' | 'MODERATOR' | 'ADMIN' }>(header.slice(7));
      req.user = { id: payload.sub, role: payload.role };
      return true;
    } catch {
      throw new UnauthorizedException();
    }
  }
}

/** Global: enforces @Roles() for admin/moderator routes. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(ctx: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<string[]>(ROLES, [ctx.getHandler(), ctx.getClass()]);
    if (!roles?.length) return true;
    const user = ctx.switchToHttp().getRequest().user;
    if (!user || !roles.includes(user.role)) throw new ForbiddenException();
    return true;
  }
}

export interface AccessState {
  verificationStatus: string;
  mustReverify: boolean;
  isBanned: boolean;
  onboardingComplete: boolean;
  deleted: boolean;
}

/**
 * No green badge = no access. Applied to discover, swipes, matches, chat and Likes You.
 * Also blocks banned users, users who must pass a fresh selfie check, and users who haven't finished onboarding.
 */
@Injectable()
export class VerifiedGuard implements CanActivate {
  constructor(@InjectDb() private readonly db: Database, private readonly redis: RedisService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const userId: string | undefined = req.user?.id;
    if (!userId) throw new UnauthorizedException();
    const state = await this.getState(userId);
    if (!state || state.deleted) throw new UnauthorizedException();
    if (state.isBanned) throw new ForbiddenException({ code: 'BANNED' });
    if (state.verificationStatus !== 'VERIFIED') throw new ForbiddenException({ code: 'NOT_VERIFIED' });
    if (state.mustReverify) throw new ForbiddenException({ code: 'REVERIFY_REQUIRED' });
    if (!state.onboardingComplete) throw new ForbiddenException({ code: 'ONBOARDING_INCOMPLETE' });
    return true;
  }

  private async getState(userId: string): Promise<AccessState | null> {
    const key = `access:${userId}`;
    const cached = await this.redis.getJson<AccessState>(key);
    if (cached) return cached;
    const [u] = await this.db.select().from(users).where(eq(users.id, userId));
    if (!u) return null;
    const state: AccessState = {
      verificationStatus: u.verificationStatus,
      mustReverify: u.mustReverify,
      isBanned: u.isBanned,
      onboardingComplete: u.onboardingComplete,
      deleted: !!u.deletedAt,
    };
    await this.redis.setJson(key, state, 30);
    return state;
  }
}

/** Call after changing anything VerifiedGuard reads. */
export async function clearAccessCache(redis: RedisService, userId: string) {
  await redis.client.del(`access:${userId}`);
}
