import { Global, Injectable, Module } from '@nestjs/common';
import { and, eq, inArray, isNull, or, SQL } from 'drizzle-orm';
import { Database, InjectDb } from '../database/database.module';
import { bans, devices, identityHashes, refreshTokens, userDevices, users } from '../database/schema';
import { RedisService } from '../redis/redis.module';
import { clearAccessCache } from '../common/guards';

/** Full ban = phone + device + identity + face. Checked at sign-up, verification and login. */
@Injectable()
export class BansService {
  constructor(@InjectDb() private readonly db: Database, private readonly redis: RedisService) {}

  async isBanned(q: { phone?: string; identityHash?: string; faceTemplateId?: string }): Promise<boolean> {
    const conds: SQL[] = [];
    if (q.phone) conds.push(eq(bans.phone, q.phone));
    if (q.identityHash) conds.push(eq(bans.identityHash, q.identityHash));
    if (q.faceTemplateId) conds.push(eq(bans.faceTemplateId, q.faceTemplateId));
    if (!conds.length) return false;
    const rows = await this.db.select({ id: bans.id }).from(bans).where(and(isNull(bans.liftedAt), or(...conds))).limit(1);
    return rows.length > 0;
  }

  async banUser(userId: string, reason: string, adminId: string) {
    const [u] = await this.db.select().from(users).where(eq(users.id, userId));
    if (!u) return;
    const [idh] = await this.db.select().from(identityHashes).where(eq(identityHashes.userId, userId));
    await this.db.transaction(async (tx) => {
      await tx.insert(bans).values({
        userId, phone: u.phone, identityHash: idh?.hash ?? null, faceTemplateId: u.faceTemplateId, reason, createdById: adminId,
      });
      await tx.update(users).set({ isBanned: true, updatedAt: new Date() }).where(eq(users.id, userId));
      const devs = await tx.select({ id: userDevices.deviceId }).from(userDevices).where(eq(userDevices.userId, userId));
      if (devs.length) await tx.update(devices).set({ isBanned: true }).where(inArray(devices.id, devs.map((d) => d.id)));
      await tx.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.userId, userId));
    });
    await clearAccessCache(this.redis, userId);
  }

  async unbanUser(userId: string) {
    await this.db.transaction(async (tx) => {
      await tx.update(bans).set({ liftedAt: new Date() }).where(and(eq(bans.userId, userId), isNull(bans.liftedAt)));
      await tx.update(users).set({ isBanned: false, updatedAt: new Date() }).where(eq(users.id, userId));
      const devs = await tx.select({ id: userDevices.deviceId }).from(userDevices).where(eq(userDevices.userId, userId));
      if (devs.length) await tx.update(devices).set({ isBanned: false }).where(inArray(devices.id, devs.map((d) => d.id)));
    });
    await clearAccessCache(this.redis, userId);
  }
}

@Global()
@Module({ providers: [BansService], exports: [BansService] })
export class BansModule {}
