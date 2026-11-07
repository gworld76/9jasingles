import { BadRequestException, Body, Controller, Get, Injectable, Module, NotFoundException, Post, UseGuards } from '@nestjs/common';
import { IsIn, IsUUID } from 'class-validator';
import { and, eq } from 'drizzle-orm';
import { Database, InjectDb } from '../database/database.module';
import { matches, profiles, swipes, users } from '../database/schema';
import { RedisService } from '../redis/redis.module';
import { LimitsService } from '../limits/limits.module';
import { SettingsService } from '../settings/settings.service';
import { FlagsService } from '../moderation/flags.service';
import { NotificationsService } from '../notifications/notifications.module';
import { RealtimeService } from '../realtime/realtime.service';
import { DiscoveryModule, DiscoveryService } from '../discovery/discovery.module';
import { ProfileCardService } from '../users/profile-card.service';
import { CurrentUser, AuthUser } from '../common/auth.decorators';
import { VerifiedGuard } from '../common/guards';

class SwipeDto {
  @IsUUID() targetId!: string;
  @IsIn(['LIKE', 'PASS']) action!: 'LIKE' | 'PASS';
}

export function orderedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

@Injectable()
export class SwipesService {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly redis: RedisService,
    private readonly limits: LimitsService,
    private readonly settings: SettingsService,
    private readonly flags: FlagsService,
    private readonly notifications: NotificationsService,
    private readonly realtime: RealtimeService,
    private readonly discovery: DiscoveryService,
    private readonly cards: ProfileCardService,
  ) {}

  async swipe(userId: string, dto: SwipeDto) {
    if (dto.targetId === userId) throw new BadRequestException();
    const [target] = await this.db.select().from(users).where(eq(users.id, dto.targetId));
    if (!target || target.verificationStatus !== 'VERIFIED' || target.isBanned || target.deletedAt) throw new NotFoundException();

    // 21st like opens the paywall (LIMIT_REACHED + countdown) for free users.
    const usage = dto.action === 'LIKE' ? await this.limits.consume(userId, 'like') : null;

    await this.db
      .insert(swipes)
      .values({ swiperId: userId, targetId: dto.targetId, action: dto.action })
      .onConflictDoUpdate({ target: [swipes.swiperId, swipes.targetId], set: { action: dto.action, createdAt: new Date() } });
    await this.discovery.removeFromDeck(userId, dto.targetId);
    await this.trackBehaviour(userId, dto.action);

    let match: { id: string } | null = null;
    if (dto.action === 'LIKE') match = await this.tryMatch(userId, dto.targetId);
    return { ok: true, matched: !!match, matchId: match?.id ?? null, usage };
  }

  /** A match is created on the server only when both users have liked each other. */
  private async tryMatch(userId: string, targetId: string) {
    const [back] = await this.db.select().from(swipes).where(and(eq(swipes.swiperId, targetId), eq(swipes.targetId, userId), eq(swipes.action, 'LIKE')));
    if (!back) return null;
    const [a, b] = orderedPair(userId, targetId);
    const [created] = await this.db.insert(matches).values({ userAId: a, userBId: b }).onConflictDoNothing().returning();
    if (!created) return null;

    const names = await this.db.select({ id: profiles.userId, name: profiles.firstName }).from(profiles).where(eq(profiles.userId, userId))
      .union(this.db.select({ id: profiles.userId, name: profiles.firstName }).from(profiles).where(eq(profiles.userId, targetId)));
    const nameOf = (id: string) => names.find((n) => n.id === id)?.name ?? '';
    for (const [me, other] of [[userId, targetId], [targetId, userId]]) {
      await this.notifications.push(me, 'newMatch', { name: nameOf(other) }, { matchId: created.id });
      this.realtime.emitToUser(me, 'match:new', { matchId: created.id, user: await this.cards.card(other) });
    }
    return created;
  }

  /** Flags accounts that like almost everyone. */
  private async trackBehaviour(userId: string, action: 'LIKE' | 'PASS') {
    const key = `beh:${action === 'LIKE' ? 'likes' : 'passes'}:${userId}`;
    const n = await this.redis.client.incr(key);
    if (n === 1) await this.redis.client.expire(key, 86_400);
    if (action !== 'LIKE') return;
    const minSwipes = await this.settings.getNumber('behaviour.likesEveryone.minSwipes');
    const maxPassRatio = await this.settings.getNumber('behaviour.likesEveryone.maxPassRatio');
    const passes = Number((await this.redis.client.get(`beh:passes:${userId}`)) ?? 0);
    if (n + passes >= minSwipes && passes / (n + passes) < maxPassRatio) {
      const once = await this.redis.client.set(`beh:flagged:likes:${userId}`, '1', 'EX', 86_400, 'NX');
      if (once) await this.flags.raise(userId, 'LIKES_EVERYONE', { likes: n, passes }, { hide: true });
    }
  }
}

@UseGuards(VerifiedGuard)
@Controller('swipes')
export class SwipesController {
  constructor(private readonly swipes: SwipesService, private readonly limits: LimitsService) {}

  @Post()
  swipe(@CurrentUser() u: AuthUser, @Body() dto: SwipeDto) {
    return this.swipes.swipe(u.id, dto);
  }

  /** Remaining likes / new chats and the countdown for the paywall timer. */
  @Get('limits')
  limitsStatus(@CurrentUser() u: AuthUser) {
    return this.limits.status(u.id);
  }
}

@Module({ imports: [DiscoveryModule], controllers: [SwipesController], providers: [SwipesService] })
export class SwipesModule {}
