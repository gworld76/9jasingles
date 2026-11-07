import { Global, Injectable, Module } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { Database, InjectDb } from '../database/database.module';
import { settings } from '../database/schema';
import { RedisService } from '../redis/redis.module';
import { DEFAULT_SETTINGS, SettingKey } from './settings.defaults';

const CACHE_SECONDS = 60;

@Injectable()
export class SettingsService {
  constructor(@InjectDb() private readonly db: Database, private readonly redis: RedisService) {}

  async get<K extends SettingKey>(key: K): Promise<(typeof DEFAULT_SETTINGS)[K]> {
    const cacheKey = `setting:${key}`;
    const cached = await this.redis.getJson<(typeof DEFAULT_SETTINGS)[K]>(cacheKey);
    if (cached !== null) return cached;
    const [row] = await this.db.select().from(settings).where(eq(settings.key, key));
    const value = (row?.value ?? DEFAULT_SETTINGS[key]) as (typeof DEFAULT_SETTINGS)[K];
    await this.redis.setJson(cacheKey, value, CACHE_SECONDS);
    return value;
  }

  async getNumber(key: SettingKey): Promise<number> {
    return Number(await this.get(key));
  }

  async set(key: SettingKey, value: unknown) {
    await this.db
      .insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
    await this.redis.client.del(`setting:${key}`);
  }

  async all() {
    const rows = await this.db.select().from(settings);
    const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    return { ...DEFAULT_SETTINGS, ...stored };
  }
}

@Global()
@Module({ providers: [SettingsService], exports: [SettingsService] })
export class SettingsModule {}
