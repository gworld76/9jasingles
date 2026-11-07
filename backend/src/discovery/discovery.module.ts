import { Controller, Get, Injectable, Module, NotFoundException, Query, UseGuards } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { and, eq, sql } from 'drizzle-orm';
import { Database, InjectDb } from '../database/database.module';
import { profiles, topPicks } from '../database/schema';
import { RedisService } from '../redis/redis.module';
import { SettingsService } from '../settings/settings.service';
import { ProfileCardService } from '../users/profile-card.service';
import { CurrentUser, AuthUser } from '../common/auth.decorators';
import { VerifiedGuard } from '../common/guards';
import { lagosDate } from '../common/time';

const toBool = ({ value }: { value: unknown }) => value === true || value === 'true';

export class DiscoverFiltersDto {
  @IsOptional() @Transform(({ value }) => Number(value)) @IsInt() @Min(18) @Max(99) minAge?: number;
  @IsOptional() @Transform(({ value }) => Number(value)) @IsInt() @Min(18) @Max(99) maxAge?: number;
  @IsOptional() @Transform(({ value }) => Number(value)) @IsInt() @Min(1) @Max(20000) maxDistanceKm?: number;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsIn(['MARRIAGE', 'SERIOUS_RELATIONSHIP', 'FRIENDSHIP_FIRST']) relationshipGoal?: string;
  @IsOptional() @IsString() religion?: string;
  /** "Nigerians in my city" */
  @IsOptional() @Transform(toBool) @IsBoolean() inMyCity?: boolean;
  @IsOptional() @Transform(({ value }) => Number(value)) @IsInt() @Min(1) @Max(50) limit?: number;
}

const DECK_SIZE = 100;

@Injectable()
export class DiscoveryService {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly redis: RedisService,
    private readonly settings: SettingsService,
    private readonly cards: ProfileCardService,
  ) {}

  /** Candidate ids for a user. Verified, onboarded, not hidden/banned, not swiped, not blocked, not matched. Low trust is shown less. */
  async candidates(userId: string, f: DiscoverFiltersDto, take: number, order: 'deck' | 'top'): Promise<string[]> {
    const [me] = await this.db.select().from(profiles).where(eq(profiles.userId, userId));
    if (!me) throw new NotFoundException();
    const minAge = f.minAge ?? me.minAgePref;
    const maxAge = f.maxAge ?? me.maxAgePref;
    const km = f.maxDistanceKm ?? me.maxDistanceKm;
    const city = f.inMyCity ? me.residenceCity : f.city;

    const conds = [
      sql`u.id <> ${userId}`,
      sql`u.verification_status = 'VERIFIED' AND u.onboarding_complete AND NOT u.is_banned AND NOT u.hidden_until_review AND NOT u.must_reverify AND u.deleted_at IS NULL`,
      sql`p.gender = ${me.interestedIn} AND p.interested_in = ${me.gender}`,
      sql`p.date_of_birth <= now() - make_interval(years => ${minAge})`,
      sql`p.date_of_birth > now() - make_interval(years => ${maxAge + 1})`,
      sql`NOT EXISTS (SELECT 1 FROM swipes s WHERE s.swiper_id = ${userId} AND s.target_id = u.id)`,
      sql`NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = ${userId} AND b.blocked_id = u.id) OR (b.blocker_id = u.id AND b.blocked_id = ${userId}))`,
      sql`NOT EXISTS (SELECT 1 FROM matches m WHERE m.unmatched_at IS NULL AND ((m.user_a_id = ${userId} AND m.user_b_id = u.id) OR (m.user_b_id = ${userId} AND m.user_a_id = u.id)))`,
    ];
    if (city) {
      conds.push(sql`lower(p.residence_city) = lower(${city})`);
      if (f.inMyCity) conds.push(sql`p.residence_country = ${me.residenceCountry}`);
    } else if (me.latitude != null && me.longitude != null) {
      conds.push(sql`ST_DWithin(
        ST_SetSRID(ST_MakePoint(p.longitude, p.latitude), 4326)::geography,
        ST_SetSRID(ST_MakePoint(${me.longitude}, ${me.latitude}), 4326)::geography,
        ${km * 1000})`);
    }
    if (f.relationshipGoal) conds.push(sql`p.relationship_goal = ${f.relationshipGoal}`);
    if (f.religion) conds.push(sql`lower(p.religion) = lower(${f.religion})`);

    const orderBy = order === 'top'
      ? sql`COALESCE(t.score, 50) DESC, u.last_active_at DESC`
      : sql`(COALESCE(t.score, 50) + random() * 30) DESC`;

    const res = await this.db.execute<{ id: string }>(sql`
      SELECT u.id FROM users u
      JOIN profiles p ON p.user_id = u.id
      LEFT JOIN trust_scores t ON t.user_id = u.id
      WHERE ${sql.join(conds, sql` AND `)}
      ORDER BY ${orderBy}
      LIMIT ${take}`);
    return res.rows.map((r) => r.id);
  }

  /** Decks are pre-built and kept in Redis so the database isn't queried on every swipe. */
  async buildDeck(userId: string, f: DiscoverFiltersDto = {}) {
    const ids = await this.candidates(userId, f, DECK_SIZE, 'deck');
    const key = `deck:${userId}`;
    const pipe = this.redis.client.multi().del(key);
    if (ids.length) pipe.rpush(key, ...ids);
    await pipe.expire(key, 6 * 3600).set(`deck:sig:${userId}`, this.signature(f), 'EX', 6 * 3600).exec();
    return ids;
  }

  async deck(userId: string, f: DiscoverFiltersDto) {
    const limit = f.limit ?? 20;
    const sig = this.signature(f);
    const key = `deck:${userId}`;
    let ids = (await this.redis.client.get(`deck:sig:${userId}`)) === sig ? await this.redis.client.lrange(key, 0, limit - 1) : [];
    if (!ids.length) ids = (await this.buildDeck(userId, f)).slice(0, limit);
    const [me] = await this.db.select({ lowData: profiles.lowDataMode }).from(profiles).where(eq(profiles.userId, userId));
    return { cards: await this.cards.cards(ids, { lowData: me?.lowData }) };
  }

  async removeFromDeck(userId: string, targetId: string) {
    await this.redis.client.lrem(`deck:${userId}`, 0, targetId);
  }

  /** 5 hand-picked verified profiles per day (Lagos date). */
  async topPicks(userId: string) {
    const today = lagosDate();
    let rows = await this.db.select().from(topPicks).where(and(eq(topPicks.ownerId, userId), eq(topPicks.forDate, today)));
    if (!rows.length) {
      const n = await this.settings.getNumber('topPicks.count');
      const ids = await this.candidates(userId, {}, n, 'top');
      if (ids.length) {
        rows = await this.db.insert(topPicks).values(ids.map((pickId) => ({ ownerId: userId, pickId, forDate: today }))).onConflictDoNothing().returning();
      }
    }
    const ids = rows.map((r) => r.pickId);
    const swiped = ids.length
      ? await this.db.execute<{ target_id: string }>(sql`SELECT target_id FROM swipes WHERE swiper_id = ${userId} AND target_id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`)
      : { rows: [] };
    const done = new Set(swiped.rows.map((r) => r.target_id));
    const [me] = await this.db.select({ lowData: profiles.lowDataMode }).from(profiles).where(eq(profiles.userId, userId));
    return { date: today, cards: await this.cards.cards(ids.filter((i) => !done.has(i)), { lowData: me?.lowData }) };
  }

  private signature(f: DiscoverFiltersDto) {
    const { limit, ...rest } = f;
    return JSON.stringify(Object.keys(rest).sort().map((k) => [k, (rest as Record<string, unknown>)[k]]));
  }
}

@UseGuards(VerifiedGuard)
@Controller('discover')
export class DiscoveryController {
  constructor(private readonly discovery: DiscoveryService) {}

  @Get()
  deck(@CurrentUser() u: AuthUser, @Query() f: DiscoverFiltersDto) {
    return this.discovery.deck(u.id, f);
  }

  @Get('top-picks')
  topPicks(@CurrentUser() u: AuthUser) {
    return this.discovery.topPicks(u.id);
  }
}

@Module({ controllers: [DiscoveryController], providers: [DiscoveryService], exports: [DiscoveryService] })
export class DiscoveryModule {}

