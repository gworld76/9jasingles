import { Controller, Delete, ForbiddenException, Get, Injectable, Module, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { Database, InjectDb } from '../database/database.module';
import { matches, messages, profiles } from '../database/schema';
import { ProfileCardService } from '../users/profile-card.service';
import { CurrentUser, AuthUser } from '../common/auth.decorators';
import { VerifiedGuard } from '../common/guards';

@Injectable()
export class MatchesService {
  constructor(@InjectDb() private readonly db: Database, private readonly cards: ProfileCardService) {}

  async assertMember(userId: string, matchId: string) {
    const [m] = await this.db.select().from(matches).where(and(eq(matches.id, matchId), isNull(matches.unmatchedAt)));
    if (!m || (m.userAId !== userId && m.userBId !== userId)) throw new ForbiddenException();
    return { match: m, otherId: m.userAId === userId ? m.userBId : m.userAId };
  }

  async list(userId: string) {
    const rows = await this.db
      .select()
      .from(matches)
      .where(and(isNull(matches.unmatchedAt), or(eq(matches.userAId, userId), eq(matches.userBId, userId)),
        sql`NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = ${matches.userAId} AND b.blocked_id = ${matches.userBId}) OR (b.blocker_id = ${matches.userBId} AND b.blocked_id = ${matches.userAId}))`))
      .orderBy(desc(matches.createdAt));
    const otherIds = rows.map((m) => (m.userAId === userId ? m.userBId : m.userAId));
    const [me] = await this.db.select({ lowData: profiles.lowDataMode }).from(profiles).where(eq(profiles.userId, userId));
    const cards = await this.cards.cards(otherIds, { lowData: me?.lowData });

    const out = [];
    for (const m of rows) {
      const otherId = m.userAId === userId ? m.userBId : m.userAId;
      const [last] = await this.db.select().from(messages).where(eq(messages.matchId, m.id)).orderBy(desc(messages.createdAt)).limit(1);
      const [{ unread }] = await this.db
        .select({ unread: sql<number>`count(*)::int` })
        .from(messages)
        .where(and(eq(messages.matchId, m.id), eq(messages.senderId, otherId), isNull(messages.readAt)));
      out.push({
        matchId: m.id,
        createdAt: m.createdAt,
        user: cards.find((c) => c.id === otherId) ?? null,
        lastMessage: last ? { type: last.type, body: last.body, senderId: last.senderId, createdAt: last.createdAt } : null,
        unread,
      });
    }
    return out;
  }

  async unmatch(userId: string, matchId: string) {
    await this.assertMember(userId, matchId);
    await this.db.update(matches).set({ unmatchedAt: new Date() }).where(eq(matches.id, matchId));
    return { ok: true };
  }
}

@UseGuards(VerifiedGuard)
@Controller('matches')
export class MatchesController {
  constructor(private readonly matches: MatchesService) {}

  @Get() list(@CurrentUser() u: AuthUser) { return this.matches.list(u.id); }
  @Delete(':id') unmatch(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.matches.unmatch(u.id, id); }
}

@Module({ controllers: [MatchesController], providers: [MatchesService], exports: [MatchesService] })
export class MatchesModule {}
