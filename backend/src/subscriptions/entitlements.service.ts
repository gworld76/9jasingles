import { Global, Injectable, Module } from '@nestjs/common';
import { and, desc, eq, gt, inArray, or } from 'drizzle-orm';
import { Database, InjectDb } from '../database/database.module';
import { subscriptions } from '../database/schema';
import { RedisService } from '../redis/redis.module';

export interface Entitlement {
  subscriber: boolean;
  planId: string | null;
  activeUntil: string | null;
}

/** Single source of truth for "is this user on a paid plan?" - checked on the server for every limited feature. */
@Injectable()
export class EntitlementsService {
  constructor(@InjectDb() private readonly db: Database, private readonly redis: RedisService) {}

  async get(userId: string): Promise<Entitlement> {
    const key = `ent:${userId}`;
    const cached = await this.redis.getJson<Entitlement>(key);
    if (cached) return cached;
    const now = new Date();
    const [sub] = await this.db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.userId, userId),
          or(
            and(inArray(subscriptions.status, ['ACTIVE', 'CANCELLED']), gt(subscriptions.activeUntil, now)),
            and(eq(subscriptions.status, 'GRACE'), gt(subscriptions.graceUntil, now)),
          ),
        ),
      )
      .orderBy(desc(subscriptions.activeUntil))
      .limit(1);
    const ent: Entitlement = sub
      ? { subscriber: true, planId: sub.planId, activeUntil: sub.activeUntil.toISOString() }
      : { subscriber: false, planId: null, activeUntil: null };
    await this.redis.setJson(key, ent, 60);
    return ent;
  }

  async isSubscriber(userId: string) {
    return (await this.get(userId)).subscriber;
  }

  async invalidate(userId: string) {
    await this.redis.client.del(`ent:${userId}`);
  }
}

@Global()
@Module({ providers: [EntitlementsService], exports: [EntitlementsService] })
export class EntitlementsModule {}
