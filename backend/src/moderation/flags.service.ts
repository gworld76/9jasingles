import { Global, Injectable, Module } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { Database, InjectDb } from '../database/database.module';
import { moderationFlags, users } from '../database/schema';
import { RedisService } from '../redis/redis.module';
import { clearAccessCache } from '../common/guards';

export type FlagType = (typeof moderationFlags.$inferInsert)['type'];

@Injectable()
export class FlagsService {
  constructor(@InjectDb() private readonly db: Database, private readonly redis: RedisService) {}

  async raise(userId: string, type: FlagType, detail?: Record<string, unknown>, opts: { hide?: boolean } = {}) {
    await this.db.insert(moderationFlags).values({ userId, type, detail: detail ?? null });
    if (opts.hide) await this.hideUntilReview(userId);
  }

  /** Suspicious accounts disappear from Discover until an admin reviews them. */
  async hideUntilReview(userId: string) {
    await this.db.update(users).set({ hiddenUntilReview: true, updatedAt: new Date() }).where(eq(users.id, userId));
    await this.redis.client.del(`deck:${userId}`);
    await clearAccessCache(this.redis, userId);
  }
}

@Global()
@Module({ providers: [FlagsService], exports: [FlagsService] })
export class FlagsModule {}
