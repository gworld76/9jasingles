import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { and, count, eq, or } from 'drizzle-orm';
import { Database, InjectDb } from '../database/database.module';
import { blocks, paywallEvents, photos, profiles, refreshTokens, users, voiceIntros } from '../database/schema';
import { RedisService } from '../redis/redis.module';
import { SettingsService } from '../settings/settings.service';
import { FlagsService } from '../moderation/flags.service';
import { TrustService } from '../trust/trust.service';
import { EntitlementsService } from '../subscriptions/entitlements.service';
import { clearAccessCache } from '../common/guards';
import { ageFrom } from '../common/time';
import { computeBadges } from '../badges/badges';
import { ProfileCardService } from './profile-card.service';
import { BasicInfoDto, UpdateProfileDto } from './users.dto';

@Injectable()
export class UsersService {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly redis: RedisService,
    private readonly settings: SettingsService,
    private readonly flags: FlagsService,
    private readonly trust: TrustService,
    private readonly entitlements: EntitlementsService,
    private readonly cards: ProfileCardService,
  ) {}

  async me(userId: string) {
    const [u] = await this.db.select().from(users).where(eq(users.id, userId));
    if (!u) throw new NotFoundException();
    const [p] = await this.db.select().from(profiles).where(eq(profiles.userId, userId));
    const ent = await this.entitlements.get(userId);
    const badge = p
      ? computeBadges({ verificationStatus: u.verificationStatus, residenceCity: p.residenceCity, residenceCountry: p.residenceCountry, locationDisplay: p.locationDisplay, isSubscriber: ent.subscriber })
      : { badges: [], badgeLabel: null };
    return {
      id: u.id,
      phone: u.phone,
      language: u.language,
      verificationStatus: u.verificationStatus,
      verificationRoute: u.verificationRoute,
      mustReverify: u.mustReverify,
      onboardingComplete: u.onboardingComplete,
      subscription: ent,
      ...badge,
      profile: p ?? null,
      card: p ? await this.cards.card(userId) : null,
    };
  }

  /** Name and date of birth are locked once verified. City/country changes go through the location check again. */
  async saveBasicInfo(userId: string, dto: BasicInfoDto) {
    const dob = new Date(dto.dateOfBirth);
    if (ageFrom(dob) < 18) throw new BadRequestException({ code: 'MUST_BE_18_PLUS' });
    const [u] = await this.db.select().from(users).where(eq(users.id, userId));
    const [existing] = await this.db.select().from(profiles).where(eq(profiles.userId, userId));

    if (existing && u.verificationStatus === 'VERIFIED') {
      if (existing.firstName !== dto.firstName || existing.dateOfBirth.toISOString().slice(0, 10) !== dob.toISOString().slice(0, 10)) {
        throw new ForbiddenException({ code: 'NAME_AND_DOB_LOCKED' });
      }
    }

    const values = {
      firstName: dto.firstName, dateOfBirth: dob, gender: dto.gender, interestedIn: dto.interestedIn,
      residenceCity: dto.residenceCity, residenceCountry: dto.residenceCountry, stateOfOrigin: dto.stateOfOrigin,
      latitude: dto.latitude ?? null, longitude: dto.longitude ?? null, updatedAt: new Date(),
    };
    await this.db.insert(profiles).values({ userId, ...values }).onConflictDoUpdate({ target: profiles.userId, set: values });

    const moved = existing && (existing.residenceCity !== dto.residenceCity || existing.residenceCountry !== dto.residenceCountry);
    if (moved && u.verificationStatus === 'VERIFIED' && dto.residenceCountry !== u.phoneCountry) {
      // Label can't be edited freely: a country that doesn't match the phone goes to admin review.
      await this.flags.raise(userId, 'LOCATION_MISMATCH', { from: existing.residenceCity, to: dto.residenceCity }, { hide: true });
    }
    await this.redis.client.del(`deck:${userId}`);
    return this.me(userId);
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const [existing] = await this.db.select().from(profiles).where(eq(profiles.userId, userId));
    if (!existing) throw new BadRequestException({ code: 'BASIC_INFO_REQUIRED' });
    if (dto.prompts) {
      const allowed = new Set<string>((await this.settings.get('prompts')).map((p) => p.id));
      if (dto.prompts.some((p) => !allowed.has(p.promptId))) throw new BadRequestException({ code: 'UNKNOWN_PROMPT' });
    }
    const { language, ...profileFields } = dto;
    if (Object.keys(profileFields).length) {
      await this.db.update(profiles).set({ ...profileFields, updatedAt: new Date() }).where(eq(profiles.userId, userId));
    }
    if (language) await this.db.update(users).set({ language }).where(eq(users.id, userId));
    await this.redis.client.del(`deck:${userId}`);
    return this.me(userId);
  }

  /** Checklist for the sign-up progress bar. */
  async onboardingProgress(userId: string) {
    const [u] = await this.db.select().from(users).where(eq(users.id, userId));
    const [p] = await this.db.select().from(profiles).where(eq(profiles.userId, userId));
    const [{ n: approvedPhotos }] = await this.db.select({ n: count() }).from(photos).where(and(eq(photos.userId, userId), eq(photos.approved, true)));
    const [{ n: voice }] = await this.db.select({ n: count() }).from(voiceIntros).where(eq(voiceIntros.userId, userId));
    const minPhotos = await this.settings.getNumber('photos.min');
    const steps = {
      basicInfo: !!p,
      verified: u.verificationStatus === 'VERIFIED',
      photos: approvedPhotos >= minPhotos,
      voiceIntro: voice > 0,
      profileDetails: !!p?.relationshipGoal && (p?.prompts?.length ?? 0) === 3,
    };
    const done = Object.values(steps).filter(Boolean).length;
    return { steps, approvedPhotos, minPhotos, percent: Math.round((done / Object.keys(steps).length) * 100) };
  }

  /** Finishing sign-up unlocks the app and shows the first-week offer (paywall trigger 4). */
  async completeOnboarding(userId: string) {
    const progress = await this.onboardingProgress(userId);
    const missing = Object.entries(progress.steps).filter(([, ok]) => !ok).map(([k]) => k);
    if (missing.length) throw new BadRequestException({ code: 'ONBOARDING_INCOMPLETE', missing });
    await this.db.update(users).set({ onboardingComplete: true, updatedAt: new Date() }).where(eq(users.id, userId));
    await clearAccessCache(this.redis, userId);
    await this.trust.recompute(userId);
    const [event] = await this.db.insert(paywallEvents).values({ userId, trigger: 'ONBOARDING_OFFER' }).returning();
    return { onboardingComplete: true, paywall: { trigger: 'ONBOARDING_OFFER', paywallEventId: event.id } };
  }

  async publicProfile(viewerId: string, userId: string) {
    const [blocked] = await this.db.select().from(blocks).where(or(
      and(eq(blocks.blockerId, viewerId), eq(blocks.blockedId, userId)),
      and(eq(blocks.blockerId, userId), eq(blocks.blockedId, viewerId)),
    ));
    const [u] = await this.db.select().from(users).where(eq(users.id, userId));
    if (blocked || !u || u.isBanned || u.deletedAt || u.verificationStatus !== 'VERIFIED') throw new NotFoundException();
    const [viewer] = await this.db.select({ lowData: profiles.lowDataMode }).from(profiles).where(eq(profiles.userId, viewerId));
    return this.cards.card(userId, { lowData: viewer?.lowData });
  }

  async prompts() {
    return this.settings.get('prompts');
  }

  /** Account deletion (required by Apple and Google). */
  async deleteAccount(userId: string) {
    await this.db.update(users).set({ deletedAt: new Date(), onboardingComplete: false, updatedAt: new Date() }).where(eq(users.id, userId));
    await this.db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.userId, userId));
    await this.db.delete(photos).where(eq(photos.userId, userId));
    await this.db.delete(voiceIntros).where(eq(voiceIntros.userId, userId));
    await this.db.delete(profiles).where(eq(profiles.userId, userId));
    await clearAccessCache(this.redis, userId);
    return { deleted: true };
  }
}
