import { HttpException, HttpStatus } from '@nestjs/common';

export type LimitType = 'like' | 'chat';

/** Returned when a free user hits the 20 likes / 5 new chats limit. The app opens the paywall with a countdown. */
export class LimitReachedException extends HttpException {
  constructor(type: LimitType, resetsAt: Date, paywallEventId: string) {
    super(
      { code: 'LIMIT_REACHED', type, resetsAt: resetsAt.toISOString(), paywallEventId },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
