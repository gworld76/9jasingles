import { Body, Controller, Delete, Global, Injectable, Module, Param, Post } from '@nestjs/common';
import { BullModule, InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { IsIn, IsString } from 'class-validator';
import { Database, InjectDb } from '../database/database.module';
import { pushTokens, users } from '../database/schema';
import { PushProvider } from '../providers/push.provider';
import { CurrentUser, AuthUser } from '../common/auth.decorators';
import { pushText, PushKey } from './push-texts';

export const NOTIFICATIONS_QUEUE = 'notifications';

interface PushJob {
  userId: string;
  key: PushKey;
  vars?: Record<string, string>;
  data?: Record<string, unknown>;
}

@Injectable()
export class NotificationsService {
  constructor(@InjectQueue(NOTIFICATIONS_QUEUE) private readonly queue: Queue<PushJob>) {}

  /** Push work always goes through the queue, never inside the request. */
  async push(userId: string, key: PushKey, vars?: Record<string, string>, data?: Record<string, unknown>) {
    await this.queue.add('push', { userId, key, vars, data }, { removeOnComplete: true, attempts: 3, backoff: { type: 'exponential', delay: 5000 } });
  }

  /** Delayed push, e.g. "Your 20 likes are back" exactly when the 24h lock ends. */
  async pushAt(userId: string, key: PushKey, at: Date, jobId: string) {
    await this.queue.remove(jobId).catch(() => undefined);
    await this.queue.add('push', { userId, key }, { jobId, delay: Math.max(0, at.getTime() - Date.now()), removeOnComplete: true });
  }
}

@Processor(NOTIFICATIONS_QUEUE)
export class NotificationsProcessor extends WorkerHost {
  constructor(@InjectDb() private readonly db: Database, private readonly push: PushProvider) {
    super();
  }

  async process(job: Job<PushJob>) {
    const { userId, key, vars, data } = job.data;
    const [u] = await this.db.select({ language: users.language }).from(users).where(eq(users.id, userId));
    if (!u) return;
    const tokens = await this.db.select().from(pushTokens).where(eq(pushTokens.userId, userId));
    const text = pushText(u.language, key, vars);
    await this.push.send({ to: tokens.map((t) => t.token), ...text, data: { type: key, ...data } });
  }
}

class RegisterPushTokenDto {
  @IsString() token!: string;
  @IsIn(['ios', 'android']) platform!: 'ios' | 'android';
}

@Controller('notifications')
export class NotificationsController {
  constructor(@InjectDb() private readonly db: Database) {}

  @Post('push-tokens')
  async register(@CurrentUser() user: AuthUser, @Body() dto: RegisterPushTokenDto) {
    await this.db
      .insert(pushTokens)
      .values({ token: dto.token, userId: user.id, platform: dto.platform })
      .onConflictDoUpdate({ target: pushTokens.token, set: { userId: user.id, platform: dto.platform } });
    return { ok: true };
  }

  @Delete('push-tokens/:token')
  async remove(@Param('token') token: string) {
    await this.db.delete(pushTokens).where(eq(pushTokens.token, token));
    return { ok: true };
  }
}

@Global()
@Module({
  imports: [BullModule.registerQueue({ name: NOTIFICATIONS_QUEUE })],
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationsProcessor],
  exports: [NotificationsService],
})
export class NotificationsModule {}
