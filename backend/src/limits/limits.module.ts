import { Global, Injectable, Module } from '@nestjs/common';
import { Database, InjectDb } from '../database/database.module';
import { paywallEvents } from '../database/schema';
import { RedisService } from '../redis/redis.module';
import { SettingsService } from '../settings/settings.service';
import { EntitlementsService } from '../subscriptions/entitlements.service';
import { NotificationsService } from '../notifications/notifications.module';
import { LimitReachedException, LimitType } from '../common/errors';

type PaywallTrigger = 'LIKE_LIMIT' | 'CHAT_LIMIT' | 'LIKES_YOU_TAP' | 'ONBOARDING_OFFER';

@Injectable()
export class PaywallService {
  constructor(@InjectDb() private readonly db: Database) {}

  /** Every paywall view is logged with its trigger so you can see which one sells best. */
  async log(userId: string, trigger: PaywallTrigger): Promise<string> {
    const [e] = await this.db.insert(paywallEvents).values({ userId, trigger }).returning({ id: paywallEvents.id });
    return e.id;
  }
}

/*
 * Atomic consume. KEYS[1]=count, KEYS[2]=lock. ARGV[1]=limit, ARGV[2]=lockSeconds.
 * Returns {allowed(1/0), lockTtlSeconds, usedAfter}.
 * The 24h lock starts the moment the last free action is used (e.g. the 20th like).
 */
const CONSUME_LUA = `
local ttl = redis.call('TTL', KEYS[2])
if ttl > 0 then return {0, ttl, tonumber(ARGV[1])} end
local used = redis.call('INCR', KEYS[1])
if used >= tonumber(ARGV[1]) then
  redis.call('SET', KEYS[2], '1', 'EX', tonumber(ARGV[2]))
  redis.call('DEL', KEYS[1])
  if used > tonumber(ARGV[1]) then return {0, tonumber(ARGV[2]), used} end
  return {1, tonumber(ARGV[2]), used}
end
return {1, 0, used}
`;

const SETTING: Record<LimitType, 'limits.likes' | 'limits.newChats'> = { like: 'limits.likes', chat: 'limits.newChats' };
const TRIGGER: Record<LimitType, PaywallTrigger> = { like: 'LIKE_LIMIT', chat: 'CHAT_LIMIT' };

/** Free plan: 20 likes and 5 new chats, each followed by a 24h lock from when the limit is hit. Paid plans: unlimited. */
@Injectable()
export class LimitsService {
  constructor(
    private readonly redis: RedisService,
    private readonly settings: SettingsService,
    private readonly entitlements: EntitlementsService,
    private readonly paywall: PaywallService,
    private readonly notifications: NotificationsService,
  ) {}

  private keys(userId: string, type: LimitType) {
    return [`limit:${type}:count:${userId}`, `limit:${type}:lock:${userId}`];
  }

  /** Throws LimitReachedException (and logs the paywall trigger) when the user is locked. */
  async consume(userId: string, type: LimitType) {
    if (await this.entitlements.isSubscriber(userId)) return { unlimited: true };
    const limit = await this.settings.getNumber(SETTING[type]);
    const lockSeconds = (await this.settings.getNumber('limits.lockHours')) * 3600;
    const [allowed, ttl, used] = (await this.redis.client.eval(CONSUME_LUA, 2, ...this.keys(userId, type), limit, lockSeconds)) as number[];
    const resetsAt = new Date(Date.now() + ttl * 1000);

    if (!allowed) {
      const paywallEventId = await this.paywall.log(userId, TRIGGER[type]);
      throw new LimitReachedException(type, resetsAt, paywallEventId);
    }
    if (ttl > 0) {
      // Just hit the limit: tell the user when it comes back.
      await this.notifications.pushAt(userId, type === 'like' ? 'likesBack' : 'chatsBack', resetsAt, `limit-reset-${type}-${userId}`);
    }
    return { unlimited: false, remaining: ttl > 0 ? 0 : limit - used, resetsAt: ttl > 0 ? resetsAt.toISOString() : null };
  }

  /** Lets the app show remaining likes/chats and the live countdown. */
  async status(userId: string) {
    if (await this.entitlements.isSubscriber(userId)) return { unlimited: true };
    const out: Record<string, { limit: number; remaining: number; resetsAt: string | null }> = {};
    for (const type of ['like', 'chat'] as LimitType[]) {
      const [countKey, lockKey] = this.keys(userId, type);
      const limit = await this.settings.getNumber(SETTING[type]);
      const ttl = await this.redis.client.ttl(lockKey);
      const used = Number((await this.redis.client.get(countKey)) ?? 0);
      out[type === 'like' ? 'likes' : 'newChats'] = ttl > 0
        ? { limit, remaining: 0, resetsAt: new Date(Date.now() + ttl * 1000).toISOString() }
        : { limit, remaining: Math.max(0, limit - used), resetsAt: null };
    }
    return { unlimited: false, ...out };
  }
}

@Global()
@Module({ providers: [LimitsService, PaywallService], exports: [LimitsService, PaywallService] })
export class LimitsModule {}
