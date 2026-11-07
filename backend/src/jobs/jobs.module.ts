import { Injectable, Logger, Module, OnApplicationBootstrap } from '@nestjs/common';
import { BullModule, InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { gt, sql } from 'drizzle-orm';
import { Database, InjectDb } from '../database/database.module';
import { users } from '../database/schema';
import { TrustService } from '../trust/trust.service';
import { SubscriptionsModule, SubscriptionsService } from '../subscriptions/subscriptions.module';
import { DiscoveryModule, DiscoveryService } from '../discovery/discovery.module';
import { addDays } from '../common/time';

export const MAINTENANCE_QUEUE = 'maintenance';

type JobName = 'expire-subscriptions' | 'recompute-trust' | 'prebuild-decks' | 'swipe-partitions';

@Injectable()
export class JobScheduler implements OnApplicationBootstrap {
  constructor(@InjectQueue(MAINTENANCE_QUEUE) private readonly queue: Queue) {}

  async onApplicationBootstrap() {
    const every = (name: JobName, pattern: string) =>
      this.queue.upsertJobScheduler(name, { pattern, tz: 'Africa/Lagos' }, { name, opts: { removeOnComplete: true } });
    await every('expire-subscriptions', '5 * * * *');  // hourly
    await every('prebuild-decks', '0 */2 * * *');      // every 2 hours
    await every('recompute-trust', '30 3 * * *');      // nightly
    await every('swipe-partitions', '0 4 25 * *');     // monthly, before the month starts
  }
}

@Processor(MAINTENANCE_QUEUE)
export class MaintenanceProcessor extends WorkerHost {
  private readonly logger = new Logger(MaintenanceProcessor.name);

  constructor(
    @InjectDb() private readonly db: Database,
    private readonly trust: TrustService,
    private readonly subs: SubscriptionsService,
    private readonly discovery: DiscoveryService,
  ) {
    super();
  }

  async process(job: Job) {
    switch (job.name as JobName) {
      case 'expire-subscriptions':
        this.logger.log(`Expired ${await this.subs.expireDue()} subscriptions`);
        break;
      case 'recompute-trust':
        for (const u of await this.activeUsers(30)) await this.trust.recompute(u.id);
        break;
      case 'prebuild-decks':
        for (const u of await this.activeUsers(1)) await this.discovery.buildDeck(u.id).catch(() => undefined);
        break;
      case 'swipe-partitions':
        await this.createNextSwipePartition();
        break;
    }
  }

  private activeUsers(days: number) {
    return this.db.select({ id: users.id }).from(users)
      .where(sql`${users.onboardingComplete} AND ${users.verificationStatus} = 'VERIFIED' AND ${gt(users.lastActiveAt, addDays(new Date(), -days))}`);
  }

  /** Only runs once swipes has been converted to a partitioned table (drizzle/sql/partition_swipes.sql). */
  private async createNextSwipePartition() {
    const res = await this.db.execute<{ partitioned: boolean }>(sql`SELECT EXISTS (SELECT 1 FROM pg_partitioned_table pt JOIN pg_class c ON c.oid = pt.partrelid WHERE c.relname = 'swipes') AS partitioned`);
    if (!res.rows[0]?.partitioned) return;
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    const name = `swipes_${start.getUTCFullYear()}_${String(start.getUTCMonth() + 1).padStart(2, '0')}`;
    await this.db.execute(sql.raw(
      `CREATE TABLE IF NOT EXISTS ${name} PARTITION OF swipes FOR VALUES FROM ('${start.toISOString().slice(0, 10)}') TO ('${end.toISOString().slice(0, 10)}')`,
    ));
  }
}

@Module({
  imports: [BullModule.registerQueue({ name: MAINTENANCE_QUEUE }), SubscriptionsModule, DiscoveryModule],
  providers: [JobScheduler, MaintenanceProcessor],
})
export class JobsModule {}
