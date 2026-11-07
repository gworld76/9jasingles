import { Controller, Get, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { BullModule } from '@nestjs/bullmq';
import { Public } from './common/auth.decorators';
import { JwtAuthGuard, RolesGuard, VerifiedGuard } from './common/guards';
import { DatabaseModule } from './database/database.module';
import { RedisModule } from './redis/redis.module';
import { SettingsModule } from './settings/settings.service';
import { ProvidersModule } from './providers/providers.module';
import { NotificationsModule } from './notifications/notifications.module';
import { FlagsModule } from './moderation/flags.service';
import { EntitlementsModule } from './subscriptions/entitlements.service';
import { TrustModule } from './trust/trust.service';
import { BansModule } from './bans/bans.service';
import { DevicesModule } from './devices/devices.service';
import { IdentityModule } from './identity/identity.service';
import { RealtimeModule } from './realtime/realtime.service';
import { LimitsModule } from './limits/limits.module';
import { AuthModule } from './auth/auth.module';
import { VerificationModule } from './verification/verification.module';
import { UsersModule } from './users/users.module';
import { MediaModule } from './media/media.module';
import { DiscoveryModule } from './discovery/discovery.module';
import { SwipesModule } from './swipes/swipes.module';
import { MatchesModule } from './matches/matches.module';
import { ChatModule } from './chat/chat.module';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
import { LikesYouModule } from './likes-you/likes-you.module';
import { SafetyModule } from './safety/safety.module';
import { AdminModule } from './admin/admin.module';
import { JobsModule } from './jobs/jobs.module';

@Controller('health')
class HealthController {
  @Public() @Get()
  health() {
    return { ok: true, service: '9jasingles-api', version: '1.0.0' };
  }
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    JwtModule.register({
      global: true,
      secret: process.env.JWT_ACCESS_SECRET,
      signOptions: { expiresIn: (process.env.JWT_ACCESS_TTL ?? '15m') as any },
    }),
    BullModule.forRoot({ connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6379' } }),

    // Shared building blocks
    DatabaseModule, RedisModule, SettingsModule, ProvidersModule, NotificationsModule, FlagsModule, EntitlementsModule,
    TrustModule, BansModule, DevicesModule, IdentityModule, RealtimeModule, LimitsModule,

    // Features
    AuthModule, VerificationModule, UsersModule, MediaModule, DiscoveryModule, SwipesModule, MatchesModule, ChatModule,
    SubscriptionsModule, LikesYouModule, SafetyModule, AdminModule, JobsModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    VerifiedGuard,
  ],
})
export class AppModule {}
