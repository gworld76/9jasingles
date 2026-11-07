import { BadRequestException, Body, Controller, Get, Injectable, Module, Post } from '@nestjs/common';
import { IsDateString, IsIn, IsLatitude, IsLongitude, IsOptional, IsString, IsUUID, Length, Matches, MaxLength } from 'class-validator';
import { and, countDistinct, eq, gt, or } from 'drizzle-orm';
import { Database, InjectDb } from '../database/database.module';
import { blocks, dateShares, matches, profiles, reports, sosEvents, users } from '../database/schema';
import { RedisService } from '../redis/redis.module';
import { SettingsService } from '../settings/settings.service';
import { FlagsService } from '../moderation/flags.service';
import { TrustService } from '../trust/trust.service';
import { NotificationsService } from '../notifications/notifications.module';
import { SmsProvider } from '../providers/sms.provider';
import { orderedPair } from '../swipes/swipes.module';
import { CurrentUser, AuthUser } from '../common/auth.decorators';
import { clearAccessCache } from '../common/guards';
import { addDays } from '../common/time';

class BlockDto { @IsUUID() userId!: string; }
class ReportDto {
  @IsUUID() userId!: string;
  @IsIn(['FAKE_PROFILE', 'SCAM_OR_MONEY_REQUEST', 'HARASSMENT', 'NUDITY', 'UNDERAGE', 'OTHER'])
  reason!: 'FAKE_PROFILE' | 'SCAM_OR_MONEY_REQUEST' | 'HARASSMENT' | 'NUDITY' | 'UNDERAGE' | 'OTHER';
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
  @IsOptional() @IsUUID() matchId?: string;
}
class ShareDateDto {
  @IsUUID() matchId!: string;
  @Matches(/^\+[1-9]\d{7,14}$/) friendPhone!: string;
  @IsString() @Length(2, 200) venue!: string;
  @IsDateString() dateTime!: string;
}
class SosDto {
  @IsOptional() @IsLatitude() latitude?: number;
  @IsOptional() @IsLongitude() longitude?: number;
}

@Injectable()
export class SafetyService {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly redis: RedisService,
    private readonly settings: SettingsService,
    private readonly flags: FlagsService,
    private readonly trust: TrustService,
    private readonly notifications: NotificationsService,
    private readonly sms: SmsProvider,
  ) {}

  async block(userId: string, targetId: string) {
    if (userId === targetId) throw new BadRequestException();
    await this.db.insert(blocks).values({ blockerId: userId, blockedId: targetId }).onConflictDoNothing();
    const [a, b] = orderedPair(userId, targetId);
    await this.db.update(matches).set({ unmatchedAt: new Date() }).where(and(eq(matches.userAId, a), eq(matches.userBId, b)));
    await this.redis.client.lrem(`deck:${userId}`, 0, targetId);
    return { ok: true };
  }

  /**
   * Any report: the reported user must pass a fresh selfie check before they can keep using the app.
   * Many reports in a short time: account hidden until an admin reviews it.
   */
  async report(userId: string, dto: ReportDto) {
    if (userId === dto.userId) throw new BadRequestException();
    await this.db.insert(reports).values({ reporterId: userId, reportedId: dto.userId, reason: dto.reason, note: dto.note ?? null, matchId: dto.matchId ?? null });
    await this.block(userId, dto.userId);

    await this.db.update(users).set({ mustReverify: true, updatedAt: new Date() }).where(eq(users.id, dto.userId));
    await clearAccessCache(this.redis, dto.userId);
    await this.notifications.push(dto.userId, 'reverify');

    const threshold = await this.settings.getNumber('reports.autoHideThreshold');
    const [{ n }] = await this.db.select({ n: countDistinct(reports.reporterId) }).from(reports)
      .where(and(eq(reports.reportedId, dto.userId), gt(reports.createdAt, addDays(new Date(), -7))));
    if (n >= threshold) await this.flags.raise(dto.userId, 'REPORT_SPIKE', { reporters7d: n }, { hide: true });
    if (dto.reason === 'UNDERAGE') await this.flags.hideUntilReview(dto.userId);

    await this.trust.recompute(dto.userId);
    return { ok: true };
  }

  /** "Share my date": sends the date details to a friend by SMS. */
  async shareDate(userId: string, dto: ShareDateDto) {
    const [m] = await this.db.select().from(matches).where(and(eq(matches.id, dto.matchId), or(eq(matches.userAId, userId), eq(matches.userBId, userId))));
    if (!m) throw new BadRequestException({ code: 'NOT_YOUR_MATCH' });
    const otherId = m.userAId === userId ? m.userBId : m.userAId;
    const [me] = await this.db.select().from(profiles).where(eq(profiles.userId, userId));
    const [other] = await this.db.select().from(profiles).where(eq(profiles.userId, otherId));
    const when = new Date(dto.dateTime);
    await this.db.insert(dateShares).values({ userId, matchId: dto.matchId, friendPhone: dto.friendPhone, venue: dto.venue, dateTime: when });
    const msg = `9jaSingles safety: ${me?.firstName} is meeting ${other?.firstName} at ${dto.venue} on ${when.toLocaleString('en-GB', { timeZone: 'Africa/Lagos' })}. Check in with them.`;
    await this.sms.send(dto.friendPhone, msg, dto.friendPhone.startsWith('+234'));
    return { ok: true };
  }

  /** In-app SOS: logged and raised to the moderation team; the app also shows the local emergency number. */
  async sos(userId: string, dto: SosDto) {
    await this.db.insert(sosEvents).values({ userId, latitude: dto.latitude ?? null, longitude: dto.longitude ?? null });
    const [p] = await this.db.select({ country: profiles.residenceCountry }).from(profiles).where(eq(profiles.userId, userId));
    const emergency: Record<string, string> = { NG: '112', GB: '999', US: '911', CA: '911', IE: '112' };
    return { ok: true, emergencyNumber: emergency[p?.country ?? 'NG'] ?? '112' };
  }

  async centre() {
    return { tips: await this.settings.get('safety.tips'), features: ['share-date', 'sos', 'block', 'report'] };
  }
}

@Controller('safety')
export class SafetyController {
  constructor(private readonly safety: SafetyService) {}

  @Get('centre') centre() { return this.safety.centre(); }
  @Post('block') block(@CurrentUser() u: AuthUser, @Body() dto: BlockDto) { return this.safety.block(u.id, dto.userId); }
  @Post('report') report(@CurrentUser() u: AuthUser, @Body() dto: ReportDto) { return this.safety.report(u.id, dto); }
  @Post('share-date') share(@CurrentUser() u: AuthUser, @Body() dto: ShareDateDto) { return this.safety.shareDate(u.id, dto); }
  @Post('sos') sos(@CurrentUser() u: AuthUser, @Body() dto: SosDto) { return this.safety.sos(u.id, dto); }
}

@Module({ controllers: [SafetyController], providers: [SafetyService] })
export class SafetyModule {}
