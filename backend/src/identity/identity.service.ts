import { createHmac } from 'crypto';
import { Global, Injectable, Module } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { Database, InjectDb } from '../database/database.module';
import { identityHashes } from '../database/schema';

type DocType = 'NIN' | 'NIGERIAN_PASSPORT';

/** One identity, one account. Raw NIN / passport numbers are never stored - only a salted HMAC. */
@Injectable()
export class IdentityService {
  constructor(@InjectDb() private readonly db: Database) {}

  hash(docType: DocType, documentNumber: string): string {
    const normalized = documentNumber.replace(/[\s-]/g, '').toUpperCase();
    return createHmac('sha256', process.env.IDENTITY_HASH_SALT ?? '').update(`${docType}:${normalized}`).digest('hex');
  }

  /** Returns the user id that already owns this identity, if any. */
  async ownerOf(hash: string): Promise<string | null> {
    const [row] = await this.db.select().from(identityHashes).where(eq(identityHashes.hash, hash));
    return row?.userId ?? null;
  }

  async claim(hash: string, userId: string, docType: DocType) {
    await this.db.insert(identityHashes).values({ hash, userId, docType }).onConflictDoNothing();
  }
}

@Global()
@Module({ providers: [IdentityService], exports: [IdentityService] })
export class IdentityModule {}
