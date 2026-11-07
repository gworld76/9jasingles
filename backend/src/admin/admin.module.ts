import {
  Body, Controller, Get, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query,
} from '@nestjs/common';
import { Transform } from 'class-transformer';
import { Allow, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { and, count, desc, eq, gte, ilike, inArray, lte, or, sql, sum } from 'drizzle-orm';
import { Database, InjectDb } from '../database/database.module';
import {
  adminAuditLogs, matches, messages, moderationFlags, paywallEvents, plans, profiles, reports, sosEvents, subscriptions,
  trustScores, userDevices, devices, users, verifications,
} from '../database/schema';
import { RedisService } from '../redis/redis.module';
import { SettingsService } from '../settings/settings.service';
import { DEFAULT_SETTINGS, SettingKey } from '../settings/settings.defaults';
import { BansService } from '../bans/bans.service';
import { TrustService } from '../trust/trust.service';
import { VerificationModule } from '../verification/verification.module';
import { VerificationService } from '../verification/verification.service';
import { SubscriptionsModule, SubscriptionsService } from '../subscriptions/subscriptions.module';
import { ProfileCardService } from '../users/profile-card.service';
import { CurrentUser, AuthUser, Roles } from '../common/auth.decorators';
import { clearAccessCache } from '../common/guards';
import { addDays } from '../common/time';

class ReasonDto { @IsString() @MaxLength(500) reason!: string; }
class ReportActionDto {
  @IsIn(['dismiss', 'ban', 'reverify', 'hide']) action!: 'dismiss' | 'ban' | 'reverify' | 'hide';
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
class CompDto {
  @IsString() userId!: string;
  @IsString() planId!: string;
  @IsInt() @Min(1) @Max(366) days!: number;
}
class PlanUpdateDto {
  @IsOptional() @IsInt() @Min(1) amountMinor?: number;
  @IsOptional() @IsString() @MaxLength(30) label?: string;
  @IsOptional() @IsString() paystackPlanCode?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}
class SettingDto { @Allow() value!: unknown; }
class SearchQuery { @IsOptional() @IsString() q?: string; }
class RangeQuery {
  @IsOptional() @Transform(({ value }) => new Date(value)) from?: Date;
  @IsOptional() @Transform(({ value }) => new Date(value)) to?: Date;
}

@Injectable()
export class AdminService {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly redis: RedisService,
    private readonly settings: SettingsService,
    private readonly bans: BansService,
    private readonly trust: TrustService,
    private readonly verification: VerificationService,
    private readonly subs: SubscriptionsService,
    private readonly cards: ProfileCardService,
  ) {}

  audit(adminId: string, action: string, targetId?: string, detail?: Record<string, unknown>) {
    return this.db.insert(adminAuditLogs).values({ adminId, action, targetId: targetId ?? null, detail: detail ?? null });
  }

  /** Verification review queue: failed checks after retry, mismatches, location conflicts. */
  async verificationQueue() {
    const rows = await this.db
      .select({ user: users, profile: profiles })
      .from(users).leftJoin(profiles, eq(profiles.userId, users.id))
      .where(eq(users.verificationStatus, 'IN_REVIEW'))
      .orderBy(users.updatedAt).limit(100);
    const ids = rows.map((r) => r.user.id);
    const [vs, fs] = ids.length
      ? await Promise.all([
          this.db.select().from(verifications).where(inArray(verifications.userId, ids)).orderBy(desc(verifications.createdAt)),
          this.db.select().from(moderationFlags).where(and(inArray(moderationFlags.userId, ids), eq(moderationFlags.resolved, false))),
        ])
      : [[], []];
    return rows.map((r) => ({
      userId: r.user.id, phone: r.user.phone, phoneCountry: r.user.phoneCountry, route: r.user.verificationRoute,
      attempts: r.user.verificationAttempts, profile: r.profile,
      verifications: vs.filter((v) => v.userId === r.user.id).slice(0, 3),
      flags: fs.filter((f) => f.userId === r.user.id),
    }));
  }

  async reportsQueue(status: 'OPEN' | 'ACTIONED' | 'DISMISSED' = 'OPEN') {
    const rows = await this.db.select().from(reports).where(eq(reports.status, status)).orderBy(desc(reports.createdAt)).limit(100);
    return Promise.all(rows.map(async (r) => ({
      ...r,
      reported: await this.cards.card(r.reportedId),
      // Chat evidence: the last 30 messages of the conversation, if the report came from a chat.
      evidence: r.matchId ? await this.db.select().from(messages).where(eq(messages.matchId, r.matchId)).orderBy(desc(messages.createdAt)).limit(30) : [],
    })));
  }

  async actionReport(adminId: string, id: string, dto: ReportActionDto) {
    const [r] = await this.db.select().from(reports).where(eq(reports.id, id));
    if (!r) throw new NotFoundException();
    if (dto.action === 'ban') await this.bans.banUser(r.reportedId, dto.reason ?? `Report ${r.reason}`, adminId);
    if (dto.action === 'reverify') await this.verification.forceReverify(r.reportedId);
    if (dto.action === 'hide') await this.db.update(users).set({ hiddenUntilReview: true }).where(eq(users.id, r.reportedId));
    await this.db.update(reports).set({ status: dto.action === 'dismiss' ? 'DISMISSED' : 'ACTIONED', handledById: adminId }).where(eq(reports.id, id));
    await clearAccessCache(this.redis, r.reportedId);
    await this.audit(adminId, `report.${dto.action}`, r.reportedId, { reportId: id });
    return { ok: true };
  }

  async flags(type?: string) {
    return this.db.select().from(moderationFlags)
      .where(type ? and(eq(moderationFlags.resolved, false), eq(moderationFlags.type, type as never)) : eq(moderationFlags.resolved, false))
      .orderBy(desc(moderationFlags.createdAt)).limit(200);
  }

  async resolveFlag(adminId: string, id: string) {
    const [f] = await this.db.update(moderationFlags).set({ resolved: true }).where(eq(moderationFlags.id, id)).returning();
    if (f) await this.trust.recompute(f.userId);
    await this.audit(adminId, 'flag.resolve', f?.userId, { flagId: id });
    return { ok: true };
  }

  async searchUsers(q?: string) {
    const where = q ? or(ilike(users.phone, `%${q}%`), ilike(profiles.firstName, `%${q}%`)) : undefined;
    return this.db.select({ id: users.id, phone: users.phone, name: profiles.firstName, status: users.verificationStatus, banned: users.isBanned, hidden: users.hiddenUntilReview })
      .from(users).leftJoin(profiles, eq(profiles.userId, users.id)).where(where).orderBy(desc(users.createdAt)).limit(50);
  }

  /** Full user view: profile, trust score, devices, subscription, reports and flags. */
  async userDetail(id: string) {
    const [u] = await this.db.select().from(users).where(eq(users.id, id));
    if (!u) throw new NotFoundException();
    const [[p], [t], devs, subs, rep, fl, ver] = await Promise.all([
      this.db.select().from(profiles).where(eq(profiles.userId, id)),
      this.db.select().from(trustScores).where(eq(trustScores.userId, id)),
      this.db.select({ device: devices, lastSeenAt: userDevices.lastSeenAt }).from(userDevices).innerJoin(devices, eq(devices.id, userDevices.deviceId)).where(eq(userDevices.userId, id)),
      this.db.select().from(subscriptions).where(eq(subscriptions.userId, id)).orderBy(desc(subscriptions.createdAt)),
      this.db.select().from(reports).where(eq(reports.reportedId, id)).orderBy(desc(reports.createdAt)),
      this.db.select().from(moderationFlags).where(eq(moderationFlags.userId, id)).orderBy(desc(moderationFlags.createdAt)),
      this.db.select().from(verifications).where(eq(verifications.userId, id)).orderBy(desc(verifications.createdAt)),
    ]);
    return { user: u, profile: p ?? null, card: await this.cards.card(id), trustScore: t?.score ?? null, devices: devs, subscriptions: subs, reports: rep, flags: fl, verifications: ver };
  }

  async ban(adminId: string, id: string, reason: string) {
    await this.bans.banUser(id, reason, adminId);
    await this.audit(adminId, 'user.ban', id, { reason });
    return { ok: true };
  }

  async unban(adminId: string, id: string) {
    await this.bans.unbanUser(id);
    await this.audit(adminId, 'user.unban', id);
    return { ok: true };
  }

  async unhide(adminId: string, id: string) {
    await this.db.update(users).set({ hiddenUntilReview: false, updatedAt: new Date() }).where(eq(users.id, id));
    await this.db.update(moderationFlags).set({ resolved: true }).where(eq(moderationFlags.userId, id));
    await clearAccessCache(this.redis, id);
    await this.trust.recompute(id);
    await this.audit(adminId, 'user.unhide', id);
    return { ok: true };
  }

  async sosEvents() {
    return this.db.select().from(sosEvents).orderBy(desc(sosEvents.createdAt)).limit(100);
  }

  /** Analytics: sign-ups, verification pass rate, matches, revenue and paywall results per trigger. */
  async analytics(range: RangeQuery) {
    const from = range.from ?? addDays(new Date(), -30);
    const to = range.to ?? new Date();
    const [[signups], [verified], [attempted], [newMatches], revenue, paywall] = await Promise.all([
      this.db.select({ n: count() }).from(users).where(and(gte(users.createdAt, from), lte(users.createdAt, to))),
      this.db.select({ n: count() }).from(verifications).where(and(eq(verifications.status, 'VERIFIED'), gte(verifications.createdAt, from), lte(verifications.createdAt, to))),
      this.db.select({ n: count() }).from(verifications).where(and(gte(verifications.createdAt, from), lte(verifications.createdAt, to), sql`${verifications.completedAt} IS NOT NULL`)),
      this.db.select({ n: count() }).from(matches).where(and(gte(matches.createdAt, from), lte(matches.createdAt, to))),
      this.db.select({ currency: plans.currency, total: sum(plans.amountMinor) }).from(subscriptions).innerJoin(plans, eq(plans.id, subscriptions.planId))
        .where(and(gte(subscriptions.createdAt, from), lte(subscriptions.createdAt, to), sql`${subscriptions.compedById} IS NULL`)).groupBy(plans.currency),
      this.db.select({ trigger: paywallEvents.trigger, views: count(), conversions: sql<number>`count(*) FILTER (WHERE ${paywallEvents.converted})::int` })
        .from(paywallEvents).where(and(gte(paywallEvents.createdAt, from), lte(paywallEvents.createdAt, to))).groupBy(paywallEvents.trigger),
    ]);
    return {
      from, to,
      signups: signups.n,
      verificationPassRate: attempted.n ? Math.round((verified.n / attempted.n) * 1000) / 10 : null,
      matches: newMatches.n,
      newSubscriptionRevenueMinor: revenue,
      paywall,
    };
  }
}

@Roles('ADMIN', 'MODERATOR')
@Controller('admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly verification: VerificationService,
    private readonly subs: SubscriptionsService,
    private readonly settings: SettingsService,
    @InjectDb() private readonly db: Database,
  ) {}

  @Get('verifications/queue') vq() { return this.admin.verificationQueue(); }

  @Post('verifications/:userId/approve')
  async approve(@CurrentUser() a: AuthUser, @Param('userId', ParseUUIDPipe) id: string) {
    await this.verification.adminApprove(id);
    await this.admin.audit(a.id, 'verification.approve', id);
    return { ok: true };
  }

  @Post('verifications/:userId/reject')
  async reject(@CurrentUser() a: AuthUser, @Param('userId', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) {
    await this.verification.adminReject(id, dto.reason);
    await this.admin.audit(a.id, 'verification.reject', id, { reason: dto.reason });
    return { ok: true };
  }

  @Get('reports') reports(@Query('status') status?: 'OPEN' | 'ACTIONED' | 'DISMISSED') { return this.admin.reportsQueue(status); }
  @Post('reports/:id/action') reportAction(@CurrentUser() a: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReportActionDto) { return this.admin.actionReport(a.id, id, dto); }

  @Get('flags') flags(@Query('type') type?: string) { return this.admin.flags(type); }
  @Post('flags/:id/resolve') resolve(@CurrentUser() a: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.admin.resolveFlag(a.id, id); }

  @Get('sos') sos() { return this.admin.sosEvents(); }

  @Get('users') users(@Query() q: SearchQuery) { return this.admin.searchUsers(q.q); }
  @Get('users/:id') user(@Param('id', ParseUUIDPipe) id: string) { return this.admin.userDetail(id); }
  @Post('users/:id/ban') ban(@CurrentUser() a: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) { return this.admin.ban(a.id, id, dto.reason); }
  @Post('users/:id/unban') unban(@CurrentUser() a: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.admin.unban(a.id, id); }
  @Post('users/:id/unhide') unhide(@CurrentUser() a: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.admin.unhide(a.id, id); }

  @Post('users/:id/force-reverify')
  async reverify(@CurrentUser() a: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.verification.forceReverify(id);
    await this.admin.audit(a.id, 'user.force_reverify', id);
    return { ok: true };
  }

  @Roles('ADMIN') @Post('subscriptions/comp')
  async comp(@CurrentUser() a: AuthUser, @Body() dto: CompDto) {
    await this.subs.comp(dto.userId, dto.planId, dto.days, a.id);
    await this.admin.audit(a.id, 'subscription.comp', dto.userId, { planId: dto.planId, days: dto.days });
    return { ok: true };
  }

  @Roles('ADMIN') @Post('subscriptions/:id/refund')
  async refund(@CurrentUser() a: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const res = await this.subs.refund(id);
    await this.admin.audit(a.id, 'subscription.refund', undefined, { subscriptionId: id });
    return res;
  }

  @Roles('ADMIN') @Get('plans') plans() { return this.db.select().from(plans); }

  @Roles('ADMIN') @Put('plans/:id')
  async updatePlan(@CurrentUser() a: AuthUser, @Param('id') id: string, @Body() dto: PlanUpdateDto) {
    const [p] = await this.db.update(plans).set(dto).where(eq(plans.id, id)).returning();
    if (!p) throw new NotFoundException();
    await this.admin.audit(a.id, 'plan.update', undefined, { planId: id, ...dto });
    return p;
  }

  /** Change limits (20 likes, 5 chats), prompts and Top Picks rules without new code. */
  @Roles('ADMIN') @Get('settings') allSettings() { return this.settings.all(); }

  @Roles('ADMIN') @Put('settings/:key')
  async setSetting(@CurrentUser() a: AuthUser, @Param('key') key: string, @Body() dto: SettingDto) {
    if (!(key in DEFAULT_SETTINGS)) throw new NotFoundException();
    await this.settings.set(key as SettingKey, dto.value);
    await this.admin.audit(a.id, 'setting.update', undefined, { key, value: dto.value as never });
    return { ok: true };
  }

  @Get('analytics') analytics(@Query() q: RangeQuery) { return this.admin.analytics(q); }
}

@Module({ imports: [VerificationModule, SubscriptionsModule], controllers: [AdminController], providers: [AdminService] })
export class AdminModule {}
