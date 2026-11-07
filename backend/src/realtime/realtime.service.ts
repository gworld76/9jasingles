import { Global, Injectable, Module } from '@nestjs/common';
import type { Server } from 'socket.io';

/** Lets any module push realtime events to a user's sockets (works across servers via the Redis adapter). */
@Injectable()
export class RealtimeService {
  private server: Server | null = null;

  attach(server: Server) {
    this.server = server;
  }

  emitToUser(userId: string, event: string, data: unknown) {
    this.server?.to(`user:${userId}`).emit(event, data);
  }
}

@Global()
@Module({ providers: [RealtimeService], exports: [RealtimeService] })
export class RealtimeModule {}
