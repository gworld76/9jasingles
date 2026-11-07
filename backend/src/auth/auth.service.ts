import { createHash, randomBytes, randomInt, timingSafeEqual } from 'crypto';
import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { Database, InjectDb } from '../database/database.module';
import { refreshTokens, users } from '../database/schema';
import { RedisService } from '../redis/redis.module';
import { SmsProvider } from '../providers/sms.provider';
import { BansService } from '../bans/bans.service';
import { DevicesService } from '../devices/devices.service';
import { addDays } from '../common/time';
import { RequestOtpDto, VerifyOtpDto } from './auth.dto';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const OTP_REQUESTS_PER_HOUR = 5;
const OTP_MAX_ATTEMPTS = 5;

@Injectable()
export class AuthService {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly redis: RedisService,
    private readonly jwt: JwtService,
    private readonly sms: SmsProvider,
    private readonly bans: BansService,
    private readonly devices: DevicesService,
  ) {}

  /** Returns ISO-2 country of the phone number, e.g. "NG" for +234. */
  phoneCountry(phone: string): string {
    const parsed = parsePhoneNumberFromString(phone);
    if (!parsed?.isValid() || !parsed.country) throw new BadRequestException({ code: 'INVALID_PHONE' });
    return parsed.country;
  }

  async requestOtp(dto: RequestOtpDto) {
    const country = this.phoneCountry(dto.phone);
    await this.devices.assertAllowed(dto.deviceFingerprint);
    if (await this.bans.isBanned({ phone: dto.phone })) throw new ForbiddenException({ code: 'BANNED' });

    const rateKey = `otp:rate:${dto.phone}`;
    const n = await this.redis.client.incr(rateKey);
    if (n === 1) await this.redis.client.expire(rateKey, 3600);
    if (n > OTP_REQUESTS_PER_HOUR) throw new HttpException({ code: 'TOO_MANY_OTP_REQUESTS' }, HttpStatus.TOO_MANY_REQUESTS);

    if (await this.sms.isVirtualOrVoip(dto.phone)) throw new ForbiddenException({ code: 'VIRTUAL_NUMBER_NOT_ALLOWED' });

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const ttl = Number(process.env.OTP_TTL_SECONDS ?? 300);
    await this.redis.client.set(`otp:${dto.phone}`, sha256(code), 'EX', ttl);
    await this.redis.client.del(`otp:attempts:${dto.phone}`);
    await this.sms.send(dto.phone, `Your 9jaSingles code is ${code}. It expires in ${Math.round(ttl / 60)} minutes.`, country === 'NG');
    return { sent: true, expiresInSeconds: ttl };
  }

  async verifyOtp(dto: VerifyOtpDto) {
    const country = this.phoneCountry(dto.phone);
    const attemptsKey = `otp:attempts:${dto.phone}`;
    const attempts = await this.redis.client.incr(attemptsKey);
    if (attempts === 1) await this.redis.client.expire(attemptsKey, 900);
    if (attempts > OTP_MAX_ATTEMPTS) throw new HttpException({ code: 'TOO_MANY_ATTEMPTS' }, HttpStatus.TOO_MANY_REQUESTS);

    const stored = await this.redis.client.get(`otp:${dto.phone}`);
    const given = sha256(dto.code);
    if (!stored || !timingSafeEqual(Buffer.from(stored), Buffer.from(given))) throw new UnauthorizedException({ code: 'INVALID_CODE' });
    await this.redis.client.del(`otp:${dto.phone}`, attemptsKey);

    let [user] = await this.db.select().from(users).where(eq(users.phone, dto.phone));
    if (user?.isBanned) throw new ForbiddenException({ code: 'BANNED' });
    await this.devices.assertAllowed(dto.deviceFingerprint, user?.id);

    const isNew = !user;
    if (!user) {
      // +234 numbers: selfie only. Foreign numbers: Nigerian ID (NIN or passport) + selfie.
      [user] = await this.db
        .insert(users)
        .values({ phone: dto.phone, phoneCountry: country, verificationRoute: country === 'NG' ? 'SELFIE_ONLY' : 'NIGERIAN_ID_SELFIE' })
        .returning();
    }
    await this.devices.link(user.id, dto.deviceFingerprint, dto.platform);
    await this.db.update(users).set({ lastActiveAt: new Date() }).where(eq(users.id, user.id));

    return {
      ...(await this.issueTokens(user.id, user.role)),
      isNew,
      user: {
        id: user.id,
        verificationRoute: user.verificationRoute,
        verificationStatus: user.verificationStatus,
        onboardingComplete: user.onboardingComplete,
      },
    };
  }

  async refresh(refreshToken: string) {
    const hash = sha256(refreshToken);
    const [row] = await this.db
      .select()
      .from(refreshTokens)
      .where(and(eq(refreshTokens.tokenHash, hash), isNull(refreshTokens.revokedAt), gt(refreshTokens.expiresAt, new Date())));
    if (!row) throw new UnauthorizedException();
    const [user] = await this.db.select().from(users).where(eq(users.id, row.userId));
    if (!user || user.isBanned || user.deletedAt) throw new UnauthorizedException();
    await this.db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.id, row.id)); // rotate
    return this.issueTokens(user.id, user.role);
  }

  async logout(refreshToken: string) {
    await this.db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.tokenHash, sha256(refreshToken)));
    return { ok: true };
  }

  private async issueTokens(userId: string, role: 'USER' | 'MODERATOR' | 'ADMIN') {
    const accessToken = this.jwt.sign({ sub: userId, role });
    const refreshToken = randomBytes(48).toString('base64url');
    await this.db.insert(refreshTokens).values({
      userId,
      tokenHash: sha256(refreshToken),
      expiresAt: addDays(new Date(), Number(process.env.JWT_REFRESH_TTL_DAYS ?? 30)),
    });
    return { accessToken, refreshToken };
  }
}
