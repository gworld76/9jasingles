import { ForbiddenException, Global, Injectable, Module } from '@nestjs/common';
import { and, count, eq } from 'drizzle-orm';
import { Database, InjectDb } from '../database/database.module';
import { devices, userDevices } from '../database/schema';

/** Device fingerprinting: banned devices are refused and accounts per device are limited. */
@Injectable()
export class DevicesService {
  constructor(@InjectDb() private readonly db: Database) {}

  private get maxAccounts() {
    return Number(process.env.MAX_ACCOUNTS_PER_DEVICE ?? 2);
  }

  async assertAllowed(fingerprint: string, userId?: string) {
    const [device] = await this.db.select().from(devices).where(eq(devices.fingerprint, fingerprint));
    if (!device) return;
    if (device.isBanned) throw new ForbiddenException({ code: 'DEVICE_BANNED' });
    if (userId) {
      const [link] = await this.db.select().from(userDevices).where(and(eq(userDevices.deviceId, device.id), eq(userDevices.userId, userId)));
      if (link) return; // already a known account on this device
    }
    const [{ n }] = await this.db.select({ n: count() }).from(userDevices).where(eq(userDevices.deviceId, device.id));
    if (n >= this.maxAccounts) throw new ForbiddenException({ code: 'DEVICE_ACCOUNT_LIMIT' });
  }

  async link(userId: string, fingerprint: string, platform: string) {
    const [device] = await this.db
      .insert(devices)
      .values({ fingerprint, platform })
      .onConflictDoUpdate({ target: devices.fingerprint, set: { platform } })
      .returning();
    await this.db
      .insert(userDevices)
      .values({ userId, deviceId: device.id })
      .onConflictDoUpdate({ target: [userDevices.userId, userDevices.deviceId], set: { lastSeenAt: new Date() } });
  }
}

@Global()
@Module({ providers: [DevicesService], exports: [DevicesService] })
export class DevicesModule {}
