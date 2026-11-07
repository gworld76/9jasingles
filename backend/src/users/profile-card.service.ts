import { Injectable } from '@nestjs/common';
import { asc, eq, inArray } from 'drizzle-orm';
import { Database, InjectDb } from '../database/database.module';
import { photos, profiles, users, voiceIntros } from '../database/schema';
import { StorageService } from '../providers/storage.service';
import { EntitlementsService } from '../subscriptions/entitlements.service';
import { computeBadges } from '../badges/badges';
import { ageFrom } from '../common/time';

export interface ProfileCard {
  id: string;
  firstName: string;
  age: number;
  badges: ('verified' | 'subscriber')[];
  badgeLabel: string | null;
  relationshipGoal: string | null;
  religion: string | null;
  bio: string | null;
  interests: string[];
  prompts: { promptId: string; answer: string }[];
  photos: { url: string; position: number }[];
  voiceIntroUrl: string | null;
}

/** Builds the public profile card used by Discover, Top Picks, Likes You, matches and chat headers. */
@Injectable()
export class ProfileCardService {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly storage: StorageService,
    private readonly entitlements: EntitlementsService,
  ) {}

  async cards(userIds: string[], opts: { lowData?: boolean } = {}): Promise<ProfileCard[]> {
    if (!userIds.length) return [];
    const rows = await this.db
      .select({ u: users, p: profiles })
      .from(users)
      .innerJoin(profiles, eq(profiles.userId, users.id))
      .where(inArray(users.id, userIds));
    const pics = await this.db.select().from(photos).where(inArray(photos.userId, userIds)).orderBy(asc(photos.position));
    const voices = await this.db.select().from(voiceIntros).where(inArray(voiceIntros.userId, userIds));

    const byId = new Map<string, ProfileCard>();
    for (const { u, p } of rows) {
      const ent = await this.entitlements.get(u.id);
      const { badges, badgeLabel } = computeBadges({
        verificationStatus: u.verificationStatus,
        residenceCity: p.residenceCity,
        residenceCountry: p.residenceCountry,
        locationDisplay: p.locationDisplay,
        isSubscriber: ent.subscriber,
      });
      const voice = voices.find((v) => v.userId === u.id);
      byId.set(u.id, {
        id: u.id,
        firstName: p.firstName,
        age: ageFrom(p.dateOfBirth),
        badges,
        badgeLabel,
        relationshipGoal: p.relationshipGoal,
        religion: p.religion,
        bio: p.bio,
        interests: p.interests,
        prompts: p.prompts,
        photos: pics
          .filter((ph) => ph.userId === u.id && ph.approved)
          .map((ph) => ({ url: this.storage.cdnUrl(ph.storageKey, { lowData: opts.lowData, blur: ph.blurred }), position: ph.position })),
        voiceIntroUrl: voice ? this.storage.cdnUrl(voice.storageKey) : null,
      });
    }
    return userIds.map((id) => byId.get(id)).filter((c): c is ProfileCard => !!c); // keep deck order
  }

  async card(userId: string, opts: { lowData?: boolean } = {}) {
    return (await this.cards([userId], opts))[0] ?? null;
  }
}
