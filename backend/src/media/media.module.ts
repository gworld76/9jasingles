import {
  BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Injectable, Module, Param, ParseIntPipe, Post,
} from '@nestjs/common';
import { BullModule, InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { and, asc, count, eq } from 'drizzle-orm';
import { IsIn, IsInt, IsString, Max, Min } from 'class-validator';
import { Database, InjectDb } from '../database/database.module';
import { photos, users, voiceIntros } from '../database/schema';
import { StorageService } from '../providers/storage.service';
import { ModerationProvider } from '../providers/moderation.provider';
import { SettingsService } from '../settings/settings.service';
import { FlagsService } from '../moderation/flags.service';
import { TrustService } from '../trust/trust.service';
import { RedisService } from '../redis/redis.module';
import { CurrentUser, AuthUser } from '../common/auth.decorators';
import { clearAccessCache } from '../common/guards';
import { MODERATION_QUEUE } from './media.constants';

const PHOTO_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' } as const;
const VOICE_TYPES = { 'audio/m4a': 'm4a', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/mpeg': 'mp3' } as const;

class PhotoUploadUrlDto {
  @IsInt() @Min(0) @Max(8) position!: number;
  @IsIn(Object.keys(PHOTO_TYPES)) contentType!: keyof typeof PHOTO_TYPES;
}
class PhotoConfirmDto {
  @IsInt() @Min(0) @Max(8) position!: number;
  @IsString() key!: string;
}
class VoiceUploadUrlDto {
  @IsIn(Object.keys(VOICE_TYPES)) contentType!: keyof typeof VOICE_TYPES;
}
class VoiceConfirmDto {
  @IsString() key!: string;
  @IsInt() @Min(3) @Max(15) durationSeconds!: number;
}

@Injectable()
export class MediaService {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly storage: StorageService,
    private readonly settings: SettingsService,
    @InjectQueue(MODERATION_QUEUE) private readonly queue: Queue,
  ) {}

  async photoUploadUrl(userId: string, dto: PhotoUploadUrlDto) {
    const max = await this.settings.getNumber('photos.max');
    if (dto.position >= max) throw new BadRequestException({ code: 'TOO_MANY_PHOTOS', max });
    const key = this.storage.newKey(userId, 'photos', PHOTO_TYPES[dto.contentType]);
    return { key, uploadUrl: await this.storage.uploadUrl(key, dto.contentType) };
  }

  /** Every new photo is checked: clear face, matches the selfie, not stock/celebrity/AI, nudity auto-blurred. */
  async confirmPhoto(userId: string, dto: PhotoConfirmDto) {
    if (!this.storage.keyBelongsTo(dto.key, userId, 'photos')) throw new ForbiddenException();
    const [photo] = await this.db
      .insert(photos)
      .values({ userId, storageKey: dto.key, position: dto.position })
      .onConflictDoUpdate({
        target: [photos.userId, photos.position],
        set: { storageKey: dto.key, approved: false, blurred: false, faceMatched: false, createdAt: new Date() },
      })
      .returning();
    await this.queue.add('photo', { photoId: photo.id, isMainPhotoChange: dto.position === 0 }, { removeOnComplete: true, attempts: 3 });
    return { photoId: photo.id, status: 'CHECKING' };
  }

  async listPhotos(userId: string) {
    const rows = await this.db.select().from(photos).where(eq(photos.userId, userId)).orderBy(asc(photos.position));
    return rows.map((p) => ({ id: p.id, position: p.position, approved: p.approved, blurred: p.blurred, url: this.storage.cdnUrl(p.storageKey, { blur: p.blurred }) }));
  }

  async deletePhoto(userId: string, position: number) {
    const [u] = await this.db.select().from(users).where(eq(users.id, userId));
    const min = await this.settings.getNumber('photos.min');
    const [{ n }] = await this.db.select({ n: count() }).from(photos).where(and(eq(photos.userId, userId), eq(photos.approved, true)));
    if (u.onboardingComplete && n <= min) throw new BadRequestException({ code: 'MIN_PHOTOS', min });
    if (position === 0) throw new BadRequestException({ code: 'REPLACE_MAIN_PHOTO_INSTEAD' });
    await this.db.delete(photos).where(and(eq(photos.userId, userId), eq(photos.position, position)));
    return { ok: true };
  }

  async voiceUploadUrl(userId: string, dto: VoiceUploadUrlDto) {
    const key = this.storage.newKey(userId, 'voice', VOICE_TYPES[dto.contentType]);
    return { key, uploadUrl: await this.storage.uploadUrl(key, dto.contentType), maxSeconds: await this.settings.getNumber('voiceIntro.maxSeconds') };
  }

  async confirmVoice(userId: string, dto: VoiceConfirmDto) {
    if (!this.storage.keyBelongsTo(dto.key, userId, 'voice')) throw new ForbiddenException();
    const max = await this.settings.getNumber('voiceIntro.maxSeconds');
    if (dto.durationSeconds > max) throw new BadRequestException({ code: 'VOICE_TOO_LONG', max });
    await this.db
      .insert(voiceIntros)
      .values({ userId, storageKey: dto.key, durationSeconds: dto.durationSeconds })
      .onConflictDoUpdate({ target: voiceIntros.userId, set: { storageKey: dto.key, durationSeconds: dto.durationSeconds, createdAt: new Date() } });
    return { ok: true };
  }
}

@Processor(MODERATION_QUEUE)
export class PhotoModerationProcessor extends WorkerHost {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly storage: StorageService,
    private readonly moderation: ModerationProvider,
    private readonly flags: FlagsService,
    private readonly trust: TrustService,
    private readonly redis: RedisService,
  ) {
    super();
  }

  async process(job: Job<{ photoId: string; isMainPhotoChange?: boolean }>) {
    const [photo] = await this.db.select().from(photos).where(eq(photos.id, job.data.photoId));
    if (!photo) return;
    const [u] = await this.db.select().from(users).where(eq(users.id, photo.userId));
    const a = await this.moderation.analyzePhoto(await this.storage.privateUrl(photo.storageKey), u.faceTemplateId);

    const detail = { photoId: photo.id, position: photo.position };
    if (a.nudity) await this.flags.raise(u.id, 'NUDITY', detail);
    if (a.stockOrCelebrity) await this.flags.raise(u.id, 'STOCK_OR_CELEBRITY_PHOTO', detail, { hide: true });
    if (a.aiGenerated) await this.flags.raise(u.id, 'AI_GENERATED_PHOTO', detail, { hide: true });
    const faceOk = a.hasClearFace && a.faceMatchesUser !== false;
    if (!faceOk && a.faceMatchesUser === false) await this.flags.raise(u.id, 'PHOTO_FACE_MISMATCH', detail);

    const approved = faceOk && !a.stockOrCelebrity && !a.aiGenerated;
    await this.db.update(photos).set({ approved, blurred: a.nudity, faceMatched: a.faceMatchesUser === true }).where(eq(photos.id, photo.id));

    // New main photo of a verified user that doesn't match their face: fresh selfie check required.
    if (job.data.isMainPhotoChange && u.verificationStatus === 'VERIFIED' && a.faceMatchesUser === false) {
      await this.db.update(users).set({ mustReverify: true, updatedAt: new Date() }).where(eq(users.id, u.id));
      await clearAccessCache(this.redis, u.id);
    }
    await this.trust.recompute(u.id);
  }
}

@Controller('media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Get('photos') list(@CurrentUser() u: AuthUser) { return this.media.listPhotos(u.id); }
  @Post('photos/upload-url') photoUrl(@CurrentUser() u: AuthUser, @Body() dto: PhotoUploadUrlDto) { return this.media.photoUploadUrl(u.id, dto); }
  @Post('photos/confirm') confirmPhoto(@CurrentUser() u: AuthUser, @Body() dto: PhotoConfirmDto) { return this.media.confirmPhoto(u.id, dto); }
  @Delete('photos/:position') deletePhoto(@CurrentUser() u: AuthUser, @Param('position', ParseIntPipe) p: number) { return this.media.deletePhoto(u.id, p); }
  @Post('voice/upload-url') voiceUrl(@CurrentUser() u: AuthUser, @Body() dto: VoiceUploadUrlDto) { return this.media.voiceUploadUrl(u.id, dto); }
  @Post('voice/confirm') confirmVoice(@CurrentUser() u: AuthUser, @Body() dto: VoiceConfirmDto) { return this.media.confirmVoice(u.id, dto); }
}

@Module({
  imports: [BullModule.registerQueue({ name: MODERATION_QUEUE })],
  controllers: [MediaController],
  providers: [MediaService, PhotoModerationProcessor],
})
export class MediaModule {}
