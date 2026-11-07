import { randomUUID } from 'crypto';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { and, desc, eq } from 'drizzle-orm';
import { Database, InjectDb } from '../database/database.module';
import { photos, profiles, users, verifications } from '../database/schema';
import { RedisService } from '../redis/redis.module';
import { DojahProvider, KycResult, SmileIdProvider } from '../providers/kyc.provider';
import { IdentityService } from '../identity/identity.service';
import { BansService } from '../bans/bans.service';
import { FlagsService } from '../moderation/flags.service';
import { TrustService } from '../trust/trust.service';
import { NotificationsService } from '../notifications/notifications.module';
import { SettingsService } from '../settings/settings.service';
import { clearAccessCache } from '../common/guards';
import { MODERATION_QUEUE } from '../media/media.constants';
import { decideVerification } from './decision';
import { StartVerificationDto } from './verification.dto';

const SYSTEM_ADMIN_ID = '00000000-0000-0000-0000-000000000000';

@Injectable()
export class VerificationService {
  private readonly logger = new Logger(VerificationService.name);

  constructor(
    @InjectDb() private readonly db: Database,
    private readonly redis: RedisService,
    private readonly smile: SmileIdProvider,
    private readonly dojah: DojahProvider,
    private readonly identity: IdentityService,
    private readonly bans: BansService,
    private readonly flags: FlagsService,
    private readonly trust: TrustService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
    @InjectQueue(MODERATION_QUEUE) private readonly moderationQueue: Queue,
  ) {}

  async status(userId: string) {
    const [u] = await this.db.select().from(users).where(eq(users.id, userId));
    if (!u) throw new NotFoundException();
    const [last] = await this.db.select().from(verifications).where(eq(verifications.userId, userId)).orderBy(desc(verifications.createdAt)).limit(1);
    const maxAttempts = await this.settings.getNumber('verification.maxAttempts');
    const submitted = !!last && !last.completedAt; // waiting for the provider result -> "Under review" screen
    return {
      status: submitted && u.verificationStatus !== 'VERIFIED' ? 'IN_REVIEW' : u.verificationStatus,
      route: u.verificationRoute,
      mustReverify: u.mustReverify,
      reason: last?.reason ?? null,
      canRetry: u.verificationStatus === 'REJECTED' && u.verificationAttempts < maxAttempts,
      acceptedDocuments: u.verificationRoute === 'NIGERIAN_ID_SELFIE' ? ['NIN', 'NIGERIAN_PASSPORT'] : [],
    };
  }

  async start(userId: string, dto: StartVerificationDto) {
    const [u] = await this.db.select().from(users).where(eq(users.id, userId));
    if (!u) throw new NotFoundException();
    const [profile] = await this.db.select().from(profiles).where(eq(profiles.userId, userId));
    if (!profile) throw new BadRequestException({ code: 'BASIC_INFO_REQUIRED' });

    const isReverification = u.verificationStatus === 'VERIFIED' && u.mustReverify;
    if (u.verificationStatus === 'VERIFIED' && !u.mustReverify) throw new ConflictException({ code: 'ALREADY_VERIFIED' });
    if (u.verificationStatus === 'IN_REVIEW') throw new ConflictException({ code: 'UNDER_REVIEW' });

    const maxAttempts = await this.settings.getNumber('verification.maxAttempts');
    if (!isReverification && u.verificationAttempts >= maxAttempts) {
      await this.setStatus(userId, 'IN_REVIEW');
      return { status: 'IN_REVIEW', reason: 'MANUAL_REVIEW' };
    }

    let docHash: string | undefined;
    const needsId = u.verificationRoute === 'NIGERIAN_ID_SELFIE' && !isReverification;
    if (needsId) {
      if (!dto.documentType || !dto.documentNumber) throw new BadRequestException({ code: 'NIGERIAN_ID_REQUIRED', accepted: ['NIN', 'NIGERIAN_PASSPORT'] });
      docHash = this.identity.hash(dto.documentType, dto.documentNumber);
      if (await this.bans.isBanned({ identityHash: docHash })) throw new ForbiddenException({ code: 'BANNED' });
      const owner = await this.identity.ownerOf(docHash);
      if (owner && owner !== userId) {
        await this.flags.raise(userId, 'DUPLICATE_IDENTITY', { existingUserId: owner }, { hide: true });
        throw new ConflictException({ code: 'IDENTITY_ALREADY_USED' });
      }
    }

    const jobId = randomUUID();
    const route = isReverification ? 'SELFIE_ONLY' : u.verificationRoute;
    const request = {
      userId,
      jobId,
      route,
      isReverification,
      documentType: needsId ? dto.documentType : undefined,
      documentNumber: needsId ? dto.documentNumber : undefined,
      callbackUrl: `${process.env.PUBLIC_API_URL}/v1/verification/webhook/smileid`,
    } as const;

    // Raw document number is never stored; only its hash, until the job finishes.
    await this.redis.setJson(`kyc:job:${jobId}`, { docHash, docType: dto.documentType, isReverification }, 86_400);

    try {
      const session = await this.smile.createSession(request);
      await this.db.insert(verifications).values({ userId, route, documentType: request.documentType ?? null, provider: 'smileid', providerJobId: jobId });
      return session;
    } catch (e) {
      // Main provider down: switch to the backup provider.
      this.logger.warn(`Smile ID unavailable, falling back to Dojah for job ${jobId}`);
      await this.db.insert(verifications).values({ userId, route, documentType: request.documentType ?? null, provider: 'dojah', providerJobId: jobId });
      return { provider: 'dojah', jobId };
    }
  }

  /** Backup provider: app sends the liveness selfie here directly. */
  async submitDojah(userId: string, jobId: string, selfieImageBase64: string, documentNumber?: string, surname?: string) {
    const [v] = await this.db.select().from(verifications).where(and(eq(verifications.providerJobId, jobId), eq(verifications.userId, userId)));
    if (!v || v.provider !== 'dojah' || v.completedAt) throw new NotFoundException();
    const job = await this.redis.getJson<{ docHash?: string }>(`kyc:job:${jobId}`);
    if (v.documentType && documentNumber && job?.docHash !== this.identity.hash(v.documentType, documentNumber)) {
      throw new BadRequestException({ code: 'DOCUMENT_CHANGED' });
    }
    const result = await this.dojah.verify({
      userId, jobId, route: v.route, documentType: v.documentType ?? undefined, documentNumber,
      callbackUrl: '', selfieImageBase64, lastName: surname,
    });
    return this.applyResult(result);
  }

  async handleSmileCallback(body: Record<string, any>) {
    if (!this.smile.verifyCallbackSignature(body.timestamp, body.signature)) throw new ForbiddenException();
    return this.applyResult(this.smile.parseCallback(body));
  }

  async applyResult(result: KycResult) {
    const [v] = await this.db.select().from(verifications).where(eq(verifications.providerJobId, result.jobId));
    if (!v || v.completedAt) return { ignored: true };
    const [u] = await this.db.select().from(users).where(eq(users.id, v.userId));
    const [profile] = await this.db.select().from(profiles).where(eq(profiles.userId, v.userId));
    const job = (await this.redis.getJson<{ docHash?: string; docType?: 'NIN' | 'NIGERIAN_PASSPORT'; isReverification?: boolean }>(`kyc:job:${v.providerJobId}`)) ?? {};
    const isReverification = !!job.isReverification;

    const decision = decideVerification({
      route: v.route,
      isReverification,
      userId: u.id,
      profileFirstName: profile.firstName,
      profileDob: profile.dateOfBirth.toISOString().slice(0, 10),
      phoneCountry: u.phoneCountry,
      residenceCountry: profile.residenceCountry,
      faceBanned: !!result.faceTemplateId && (await this.bans.isBanned({ faceTemplateId: result.faceTemplateId })),
      result,
    });

    const status = decision.outcome === 'VERIFIED' ? 'VERIFIED' : decision.outcome === 'FAILED' ? 'REJECTED' : 'IN_REVIEW';
    await this.db.update(verifications).set({
      status, reason: decision.reason, livenessPassed: result.livenessPassed, faceMatchScore: result.faceMatchScore,
      nameMatched: decision.nameMatched, dobMatched: decision.dobMatched, completedAt: new Date(),
    }).where(eq(verifications.id, v.id));

    for (const f of decision.flags) await this.flags.raise(u.id, f, { verificationId: v.id }, { hide: f === 'DUPLICATE_FACE' });

    if (decision.outcome === 'BAN') {
      await this.bans.banUser(u.id, 'Matched a banned face', SYSTEM_ADMIN_ID);
      return { status: 'BANNED' };
    }

    if (decision.outcome === 'VERIFIED') {
      await this.markVerified(u.id, result.faceTemplateId ?? u.faceTemplateId, job.docHash, job.docType);
      return { status: 'VERIFIED' };
    }

    if (decision.outcome === 'REVIEW') {
      await this.setStatus(u.id, 'IN_REVIEW');
      if (job.docHash && job.docType) await this.redis.setJson(`kyc:pending-identity:${u.id}`, { docHash: job.docHash, docType: job.docType, faceTemplateId: result.faceTemplateId }, 30 * 86_400);
      return { status: 'IN_REVIEW', reason: decision.reason };
    }

    // FAILED: one retry, then manual review.
    const attempts = isReverification ? u.verificationAttempts : u.verificationAttempts + 1;
    const maxAttempts = await this.settings.getNumber('verification.maxAttempts');
    const next = isReverification ? 'VERIFIED' : attempts >= maxAttempts ? 'IN_REVIEW' : 'REJECTED';
    await this.db.update(users).set({ verificationStatus: next, verificationAttempts: attempts, updatedAt: new Date() }).where(eq(users.id, u.id));
    await clearAccessCache(this.redis, u.id);
    await this.notifications.push(u.id, isReverification ? 'reverify' : 'rejected');
    return { status: next, reason: decision.reason };
  }

  /** Admin approval from the review queue. */
  async adminApprove(userId: string) {
    const pending = await this.redis.getJson<{ docHash: string; docType: 'NIN' | 'NIGERIAN_PASSPORT'; faceTemplateId: string | null }>(`kyc:pending-identity:${userId}`);
    const [u] = await this.db.select().from(users).where(eq(users.id, userId));
    await this.markVerified(userId, pending?.faceTemplateId ?? u?.faceTemplateId ?? null, pending?.docHash, pending?.docType);
  }

  async adminReject(userId: string, reason: string) {
    await this.db.update(users).set({ verificationStatus: 'REJECTED', updatedAt: new Date() }).where(eq(users.id, userId));
    const [last] = await this.db.select().from(verifications).where(eq(verifications.userId, userId)).orderBy(desc(verifications.createdAt)).limit(1);
    if (last) await this.db.update(verifications).set({ status: 'REJECTED', reason }).where(eq(verifications.id, last.id));
    await clearAccessCache(this.redis, userId);
    await this.notifications.push(userId, 'rejected');
  }

  async forceReverify(userId: string) {
    await this.db.update(users).set({ mustReverify: true, updatedAt: new Date() }).where(eq(users.id, userId));
    await clearAccessCache(this.redis, userId);
    await this.notifications.push(userId, 'reverify');
  }

  private async markVerified(userId: string, faceTemplateId: string | null, docHash?: string, docType?: 'NIN' | 'NIGERIAN_PASSPORT') {
    if (docHash && docType) await this.identity.claim(docHash, userId, docType);
    await this.db.update(users).set({
      verificationStatus: 'VERIFIED', verifiedAt: new Date(), faceTemplateId, mustReverify: false, updatedAt: new Date(),
    }).where(eq(users.id, userId));
    await clearAccessCache(this.redis, userId);
    await this.redis.client.del(`kyc:pending-identity:${userId}`);
    // Re-check every profile photo against the verified face.
    const userPhotos = await this.db.select({ id: photos.id }).from(photos).where(eq(photos.userId, userId));
    for (const p of userPhotos) await this.moderationQueue.add('photo', { photoId: p.id }, { removeOnComplete: true, attempts: 3 });
    await this.trust.recompute(userId);
    await this.notifications.push(userId, 'verified');
  }

  private async setStatus(userId: string, status: 'IN_REVIEW' | 'VERIFIED') {
    await this.db.update(users).set({ verificationStatus: status, updatedAt: new Date() }).where(eq(users.id, userId));
    await clearAccessCache(this.redis, userId);
  }
}
