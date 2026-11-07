import { createHash } from 'crypto';
import {
  BadRequestException, Body, Controller, ForbiddenException, Get, Injectable, Logger, Module, Param, ParseUUIDPipe, Post, Query, UseGuards,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayInit, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { and, count, desc, eq, isNull, lt, ne, or } from 'drizzle-orm';
import { Database, InjectDb } from '../database/database.module';
import { blocks, messages, profiles } from '../database/schema';
import { RedisService } from '../redis/redis.module';
import { LimitsService } from '../limits/limits.module';
import { SettingsService } from '../settings/settings.service';
import { FlagsService } from '../moderation/flags.service';
import { NotificationsService } from '../notifications/notifications.module';
import { RealtimeService } from '../realtime/realtime.service';
import { StorageService } from '../providers/storage.service';
import { MatchesModule, MatchesService } from '../matches/matches.module';
import { CurrentUser, AuthUser } from '../common/auth.decorators';
import { VerifiedGuard } from '../common/guards';
import { detectScam, SCAM_WARNING } from './scam-detector';
import { icebreakers } from './icebreakers';

class SendMessageDto {
  @IsIn(['TEXT', 'PHOTO', 'VOICE']) type!: 'TEXT' | 'PHOTO' | 'VOICE';
  @IsOptional() @IsString() @MaxLength(2000) body?: string;
  @IsOptional() @IsString() mediaKey?: string;
}
class ChatMediaUrlDto {
  @IsIn(['image/jpeg', 'image/png', 'image/webp', 'audio/m4a', 'audio/aac', 'audio/mp4']) contentType!: string;
}
class HistoryQuery {
  @IsOptional() @IsUUID() before?: string;
}

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    @InjectDb() private readonly db: Database,
    private readonly redis: RedisService,
    private readonly limits: LimitsService,
    private readonly settings: SettingsService,
    private readonly flags: FlagsService,
    private readonly notifications: NotificationsService,
    private readonly realtime: RealtimeService,
    private readonly storage: StorageService,
    private readonly matches: MatchesService,
  ) {}

  private async assertNotBlocked(a: string, b: string) {
    const [row] = await this.db.select().from(blocks).where(or(
      and(eq(blocks.blockerId, a), eq(blocks.blockedId, b)),
      and(eq(blocks.blockerId, b), eq(blocks.blockedId, a)),
    ));
    if (row) throw new ForbiddenException({ code: 'BLOCKED' });
  }

  async send(userId: string, matchId: string, dto: SendMessageDto) {
    const { otherId } = await this.matches.assertMember(userId, matchId);
    await this.assertNotBlocked(userId, otherId);
    if (dto.type === 'TEXT' && !dto.body?.trim()) throw new BadRequestException({ code: 'EMPTY_MESSAGE' });
    if (dto.type !== 'TEXT' && (!dto.mediaKey || !this.storage.keyBelongsTo(dto.mediaKey, userId, 'chat'))) throw new BadRequestException({ code: 'MEDIA_REQUIRED' });

    const [{ n: existing }] = await this.db.select({ n: count() }).from(messages).where(eq(messages.matchId, matchId));
    // A "new chat" = the first message in a conversation. Replies to someone who messaged first never count.
    if (existing === 0) await this.limits.consume(userId, 'chat'); // 6th new chat -> paywall for free users

    const scam = detectScam(dto.body, existing);
    const [msg] = await this.db
      .insert(messages)
      .values({ matchId, senderId: userId, type: dto.type, body: dto.body ?? null, mediaKey: dto.mediaKey ?? null, scamFlag: scam.flagged })
      .returning();

    if (scam.flagged) await this.flags.raise(userId, 'SCAM_MESSAGE', { messageId: msg.id, reasons: scam.reasons });
    if (dto.type === 'TEXT' && dto.body) await this.trackDuplicate(userId, matchId, dto.body);

    const payload = this.serialize(msg, scam.flagged);
    this.realtime.emitToUser(otherId, 'message:new', payload);
    const [me] = await this.db.select({ name: profiles.firstName }).from(profiles).where(eq(profiles.userId, userId));
    await this.notifications.push(otherId, 'newMessage', { name: me?.name ?? '' }, { matchId });
    return payload;
  }

  /** Same message sent to many people in 24h -> account hidden until review. */
  private async trackDuplicate(userId: string, matchId: string, body: string) {
    const h = createHash('sha1').update(body.trim().toLowerCase()).digest('hex').slice(0, 16);
    const key = `beh:dup:${userId}:${h}`;
    await this.redis.client.sadd(key, matchId);
    await this.redis.client.expire(key, 86_400);
    const n = await this.redis.client.scard(key);
    const threshold = await this.settings.getNumber('behaviour.duplicateMessages.threshold');
    if (n >= threshold && (await this.redis.client.set(`beh:flagged:dup:${userId}`, '1', 'EX', 86_400, 'NX'))) {
      await this.flags.raise(userId, 'DUPLICATE_MESSAGES', { conversations: n }, { hide: true });
    }
  }

  async history(userId: string, matchId: string, before?: string) {
    await this.matches.assertMember(userId, matchId);
    let cursor: Date | undefined;
    if (before) {
      const [b] = await this.db.select({ createdAt: messages.createdAt }).from(messages).where(eq(messages.id, before));
      cursor = b?.createdAt;
    }
    const rows = await this.db
      .select()
      .from(messages)
      .where(cursor ? and(eq(messages.matchId, matchId), lt(messages.createdAt, cursor)) : eq(messages.matchId, matchId))
      .orderBy(desc(messages.createdAt))
      .limit(50);
    return rows.map((m) => this.serialize(m, m.scamFlag));
  }

  async markRead(userId: string, matchId: string) {
    const { otherId } = await this.matches.assertMember(userId, matchId);
    await this.db.update(messages).set({ readAt: new Date() })
      .where(and(eq(messages.matchId, matchId), ne(messages.senderId, userId), isNull(messages.readAt)));
    this.realtime.emitToUser(otherId, 'message:read', { matchId });
    return { ok: true };
  }

  async icebreakers(userId: string, matchId: string) {
    const { otherId } = await this.matches.assertMember(userId, matchId);
    const [p] = await this.db.select().from(profiles).where(eq(profiles.userId, otherId));
    return { suggestions: p ? icebreakers(p) : [] };
  }

  async mediaUrl(userId: string, contentType: string) {
    const ext = contentType.split('/')[1].replace('jpeg', 'jpg');
    const key = this.storage.newKey(userId, 'chat', ext);
    return { key, uploadUrl: await this.storage.uploadUrl(key, contentType) };
  }

  async typing(userId: string, matchId: string) {
    const { otherId } = await this.matches.assertMember(userId, matchId);
    this.realtime.emitToUser(otherId, 'typing', { matchId, userId });
  }

  private serialize(m: typeof messages.$inferSelect, scamFlag: boolean) {
    return {
      id: m.id, matchId: m.matchId, senderId: m.senderId, type: m.type, body: m.body,
      mediaUrl: m.mediaKey ? this.storage.cdnUrl(m.mediaKey) : null,
      createdAt: m.createdAt, readAt: m.readAt,
      warning: scamFlag ? SCAM_WARNING : null,
    };
  }
}

@WebSocketGateway({ namespace: '/chat', cors: { origin: '*' } })
export class ChatGateway implements OnGatewayInit, OnGatewayConnection {
  constructor(private readonly jwt: JwtService, private readonly realtime: RealtimeService, private readonly chat: ChatService) {}

  afterInit(server: Server) {
    this.realtime.attach(server);
  }

  handleConnection(client: Socket) {
    try {
      const token = (client.handshake.auth?.token as string) ?? '';
      const payload = this.jwt.verify<{ sub: string }>(token);
      client.data.userId = payload.sub;
      client.join(`user:${payload.sub}`);
    } catch {
      client.disconnect(true);
    }
  }

  @SubscribeMessage('typing')
  async onTyping(@ConnectedSocket() client: Socket, @MessageBody() body: { matchId: string }) {
    if (client.data.userId && body?.matchId) await this.chat.typing(client.data.userId, body.matchId).catch(() => undefined);
  }
}

@UseGuards(VerifiedGuard)
@Controller('chat')
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Get(':matchId/messages')
  history(@CurrentUser() u: AuthUser, @Param('matchId', ParseUUIDPipe) matchId: string, @Query() q: HistoryQuery) {
    return this.chat.history(u.id, matchId, q.before);
  }

  @Post(':matchId/messages')
  send(@CurrentUser() u: AuthUser, @Param('matchId', ParseUUIDPipe) matchId: string, @Body() dto: SendMessageDto) {
    return this.chat.send(u.id, matchId, dto);
  }

  @Post(':matchId/read')
  read(@CurrentUser() u: AuthUser, @Param('matchId', ParseUUIDPipe) matchId: string) {
    return this.chat.markRead(u.id, matchId);
  }

  @Get(':matchId/icebreakers')
  ice(@CurrentUser() u: AuthUser, @Param('matchId', ParseUUIDPipe) matchId: string) {
    return this.chat.icebreakers(u.id, matchId);
  }

  @Post('media-url')
  mediaUrl(@CurrentUser() u: AuthUser, @Body() dto: ChatMediaUrlDto) {
    return this.chat.mediaUrl(u.id, dto.contentType);
  }
}

@Module({ imports: [MatchesModule], controllers: [ChatController], providers: [ChatService, ChatGateway] })
export class ChatModule {}
