import { Global, Injectable, Module } from '@nestjs/common';
import { and, count, eq, gt } from 'drizzle-orm';
import { Database, InjectDb } from '../database/database.module';
import { moderationFlags, photos, reports, trustScores, users, voiceIntros } from '../database/schema';
import { addDays } from '../common/time';

export interface TrustInput {
  verified: boolean;
  idVerified: boolean;      // passed a Nigerian ID check (users abroad)
  accountAgeDays: number;
  approvedPhotos: number;
  hasVoiceIntro: boolean;
  reportsLast30Days: number;
  openFlags: number;
}

/** Hidden 0-100 score. Low scores are shown less in Discover. */
export function scoreTrust(i: TrustInput): number {
  let s = 30;
  if (i.verified) s += 25;
  if (i.idVerified) s += 5;
  s += Math.min(10, Math.floor(i.accountAgeDays / 7));
  if (i.approvedPhotos >= 4) s += 5;
  if (i.hasVoiceIntro) s += 5;
  s -= i.reportsLast30Days * 10;
  s -= i.openFlags * 15;
  return Math.max(0, Math.min(100, s));
}

@Injectable()
export class TrustService {
  constructor(@InjectDb() private readonly db: Database) {}

  async recompute(userId: string): Promise<number> {
    const [u] = await this.db.select().from(users).where(eq(users.id, userId));
    if (!u) return 0;
    const since = addDays(new Date(), -30);
    const [[p], [v], [r], [f]] = await Promise.all([
      this.db.select({ n: count() }).from(photos).where(and(eq(photos.userId, userId), eq(photos.approved, true))),
      this.db.select({ n: count() }).from(voiceIntros).where(eq(voiceIntros.userId, userId)),
      this.db.select({ n: count() }).from(reports).where(and(eq(reports.reportedId, userId), gt(reports.createdAt, since))),
      this.db.select({ n: count() }).from(moderationFlags).where(and(eq(moderationFlags.userId, userId), eq(moderationFlags.resolved, false))),
    ]);
    const score = scoreTrust({
      verified: u.verificationStatus === 'VERIFIED',
      idVerified: u.verificationStatus === 'VERIFIED' && u.verificationRoute === 'NIGERIAN_ID_SELFIE',
      accountAgeDays: Math.floor((Date.now() - u.createdAt.getTime()) / 86_400_000),
      approvedPhotos: p.n,
      hasVoiceIntro: v.n > 0,
      reportsLast30Days: r.n,
      openFlags: f.n,
    });
    await this.db
      .insert(trustScores)
      .values({ userId, score })
      .onConflictDoUpdate({ target: trustScores.userId, set: { score, updatedAt: new Date() } });
    return score;
  }
}

@Global()
@Module({ providers: [TrustService], exports: [TrustService] })
export class TrustModule {}
