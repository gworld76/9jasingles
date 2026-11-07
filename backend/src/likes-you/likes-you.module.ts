import { Controller, Get, Injectable, Module, Post, UseGuards } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Database, InjectDb } from '../database/database.module';
import { EntitlementsService } from '../subscriptions/entitlements.service';
import { PaywallService } from '../limits/limits.module';
import { ProfileCardService } from '../users/profile-card.service';
import { StorageService } from '../providers/storage.service';
import { CurrentUser, AuthUser } from '../common/auth.decorators';
import { VerifiedGuard } from '../common/guards';

@Injectable()
export class LikesYouService {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly entitlements: EntitlementsService,
    private readonly paywall: PaywallService,
    private readonly cards: ProfileCardService,
    private readonly storage: StorageService,
  ) {}

  /** People who liked me that I haven't swiped on yet. */
  private async likerIds(userId: string) {
    const res = await this.db.execute<{ id: string }>(sql`
      SELECT s.swiper_id AS id FROM swipes s
      JOIN users u ON u.id = s.swiper_id
      WHERE s.target_id = ${userId} AND s.action = 'LIKE'
        AND u.verification_status = 'VERIFIED' AND NOT u.is_banned AND NOT u.hidden_until_review AND u.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM swipes mine WHERE mine.swiper_id = ${userId} AND mine.target_id = s.swiper_id)
        AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = ${userId} AND b.blocked_id = s.swiper_id) OR (b.blocker_id = s.swiper_id AND b.blocked_id = ${userId}))
      ORDER BY s.created_at DESC
      LIMIT 200`);
    return res.rows.map((r) => r.id);
  }

  /** Free: count + blurred photos only (no names or ids sent). Paid: full profiles. */
  async list(userId: string) {
    const ids = await this.likerIds(userId);
    if (await this.entitlements.isSubscriber(userId)) {
      return { count: ids.length, locked: false, profiles: await this.cards.cards(ids) };
    }
    const res = ids.length
      ? await this.db.execute<{ storage_key: string }>(sql`
          SELECT DISTINCT ON (user_id) storage_key FROM photos
          WHERE user_id IN (${sql.join(ids.slice(0, 30).map((i) => sql`${i}`), sql`, `)}) AND approved
          ORDER BY user_id, position`)
      : { rows: [] };
    return {
      count: ids.length,
      locked: true,
      blurredPhotos: res.rows.map((r) => this.storage.cdnUrl(r.storage_key, { blur: true, lowData: true })),
    };
  }

  /** Free user taps a blurred profile -> paywall trigger 3. */
  async tap(userId: string) {
    if (await this.entitlements.isSubscriber(userId)) return { paywall: false };
    const paywallEventId = await this.paywall.log(userId, 'LIKES_YOU_TAP');
    return { paywall: true, trigger: 'LIKES_YOU_TAP', paywallEventId };
  }
}

@UseGuards(VerifiedGuard)
@Controller('likes-you')
export class LikesYouController {
  constructor(private readonly likesYou: LikesYouService) {}

  @Get() list(@CurrentUser() u: AuthUser) { return this.likesYou.list(u.id); }
  @Post('tap') tap(@CurrentUser() u: AuthUser) { return this.likesYou.tap(u.id); }
}

@Module({ controllers: [LikesYouController], providers: [LikesYouService] })
export class LikesYouModule {}
