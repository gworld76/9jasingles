// Tests for the business rules agreed in the 9jaSingles Version 1 plan.
import { computeBadges } from './badges/badges';
import { decideVerification, nameMatches, normalizeDob } from './verification/decision';
import { detectScam } from './chat/scam-detector';
import { icebreakers } from './chat/icebreakers';
import { PLAN_SEED, periodEnd, regionFor } from './subscriptions/pricing';
import { scoreTrust } from './trust/trust.service';
import { DEFAULT_SETTINGS } from './settings/settings.defaults';
import { KycResult } from './providers/kyc.provider';

describe('badges', () => {
  const base = { verificationStatus: 'VERIFIED', residenceCity: 'Lagos', residenceCountry: 'NG', locationDisplay: 'CITY' as const, isSubscriber: false };

  it('green badge with city for users in Nigeria', () => {
    expect(computeBadges(base)).toEqual({ badges: ['verified'], badgeLabel: 'Verified Nigerian · Lagos' });
  });
  it('green badge with city and country for users abroad', () => {
    expect(computeBadges({ ...base, residenceCity: 'London', residenceCountry: 'GB' }).badgeLabel).toBe('Verified Nigerian · London, UK');
  });
  it('country only when the user chooses it', () => {
    expect(computeBadges({ ...base, residenceCity: 'London', residenceCountry: 'GB', locationDisplay: 'COUNTRY_ONLY' }).badgeLabel)
      .toBe('Verified Nigerian · United Kingdom');
  });
  it('paid users get green + gold', () => {
    expect(computeBadges({ ...base, isSubscriber: true }).badges).toEqual(['verified', 'subscriber']);
  });
  it('gold always needs green: unverified paying user gets nothing', () => {
    expect(computeBadges({ ...base, verificationStatus: 'IN_REVIEW', isSubscriber: true })).toEqual({ badges: [], badgeLabel: null });
  });
});

describe('verification decision', () => {
  const result = (o: Partial<KycResult> = {}): KycResult => ({
    jobId: 'j', livenessPassed: true, faceMatchScore: 95, faceTemplateId: 'f1', duplicateFaceUserId: null,
    idFirstName: 'Adaeze', idLastName: 'Okafor', idDateOfBirth: '1998-04-12', idNationality: 'NG', rawResultCode: '0810', ...o,
  });
  const input = (o: Partial<Parameters<typeof decideVerification>[0]> = {}) => ({
    route: 'NIGERIAN_ID_SELFIE' as const, isReverification: false, userId: 'u1', profileFirstName: 'Adaeze',
    profileDob: '1998-04-12', phoneCountry: 'GB', residenceCountry: 'GB', faceBanned: false, result: result(), ...o,
  });

  it('passes a Nigerian abroad with matching ID, face and details', () => {
    expect(decideVerification(input()).outcome).toBe('VERIFIED');
  });
  it('+234 users need the liveness selfie only', () => {
    expect(decideVerification(input({ route: 'SELFIE_ONLY', phoneCountry: 'NG', residenceCountry: 'NG', result: result({ faceMatchScore: null, idFirstName: null }) })).outcome).toBe('VERIFIED');
  });
  it('fails liveness', () => {
    expect(decideVerification(input({ result: result({ livenessPassed: false }) })).reason).toBe('LIVENESS_FAILED');
  });
  it('fails when the selfie does not match the ID photo', () => {
    expect(decideVerification(input({ result: result({ faceMatchScore: 40 }) })).reason).toBe('FACE_DOES_NOT_MATCH_ID');
  });
  it('fails when name or date of birth differ from the profile', () => {
    const d = decideVerification(input({ profileDob: '1999-01-01' }));
    expect(d.reason).toBe('ID_DETAILS_MISMATCH');
    expect(d.flags).toContain('ID_DETAILS_MISMATCH');
  });
  it('one face, one account', () => {
    expect(decideVerification(input({ result: result({ duplicateFaceUserId: 'someone-else' }) })).reason).toBe('DUPLICATE_FACE');
  });
  it('banned face is banned again', () => {
    expect(decideVerification(input({ faceBanned: true })).outcome).toBe('BAN');
  });
  it('+44 number living in Toronto goes to admin review', () => {
    const d = decideVerification(input({ phoneCountry: 'GB', residenceCountry: 'CA' }));
    expect(d.outcome).toBe('REVIEW');
    expect(d.flags).toContain('LOCATION_MISMATCH');
  });
  it('fresh selfie re-check must match the account face', () => {
    expect(decideVerification(input({ isReverification: true, result: result({ faceMatchScore: 50 }) })).reason).toBe('FACE_DOES_NOT_MATCH_ACCOUNT');
  });
  it('name and dob helpers', () => {
    expect(nameMatches('adaeze', 'ADAEZE CHIOMA', 'OKAFOR')).toBe(true);
    expect(nameMatches('Tunde', 'Adaeze', 'Okafor')).toBe(false);
    expect(normalizeDob('12/04/1998')).toBe('1998-04-12');
  });
});

describe('scam detection', () => {
  it.each([
    'Please send me money for transport',
    'can you buy me an itunes gift card',
    'invest in bitcoin with me, double your money',
    'text me on whatsapp',
    'abeg recharge airtime for me',
  ])('flags: %s', (msg) => expect(detectScam(msg).flagged).toBe(true));

  it('does not flag a normal message', () => {
    expect(detectScam('How was your Sunday? I went to church then owambe').flagged).toBe(false);
  });
  it('moving to WhatsApp is only flagged early in the chat', () => {
    expect(detectScam('add me on whatsapp', 50).flagged).toBe(false);
  });
});

describe('icebreakers', () => {
  it('returns exactly 3 suggestions from the profile', () => {
    const s = icebreakers({ firstName: 'Tunde', residenceCity: 'London', relationshipGoal: 'MARRIAGE', interests: ['football'],
      prompts: [{ promptId: 'jollof', answer: '10/10 Nigerian' }, { promptId: 'sunday', answer: 'Owambe' }, { promptId: 'music', answer: 'Essence' }] });
    expect(s).toHaveLength(3);
    expect(s[0]).toContain('10/10 Nigerian');
  });
});

describe('pricing (final)', () => {
  const price = (id: string) => PLAN_SEED.find((p) => p.id === id)!;
  it('Nigeria: ₦1,000 / ₦3,000 / ₦28,800', () => {
    expect(price('NG_WEEKLY').amountMinor).toBe(100_000);
    expect(price('NG_MONTHLY').amountMinor).toBe(300_000);
    expect(price('NG_YEARLY').amountMinor).toBe(2_880_000);
  });
  it('Abroad: $2.99 / $5.99 / $57.49', () => {
    expect(price('INTL_WEEKLY').amountMinor).toBe(299);
    expect(price('INTL_MONTHLY').amountMinor).toBe(599);
    expect(price('INTL_YEARLY').amountMinor).toBe(5749);
  });
  it('"Save 20%" labels are true', () => {
    expect(price('NG_YEARLY').amountMinor / (price('NG_MONTHLY').amountMinor * 12)).toBeCloseTo(0.8, 3);
    expect(1 - price('INTL_YEARLY').amountMinor / (price('INTL_MONTHLY').amountMinor * 12)).toBeGreaterThanOrEqual(0.2);
  });
  it('region comes from residence country', () => {
    expect(regionFor('NG')).toBe('NG');
    expect(regionFor('GB')).toBe('INTL');
  });
  it('period lengths', () => {
    const from = new Date('2026-01-31T00:00:00Z');
    expect(periodEnd('WEEKLY', from).toISOString().slice(0, 10)).toBe('2026-02-07');
    expect(periodEnd('YEARLY', from).toISOString().slice(0, 10)).toBe('2027-01-31');
  });
});

describe('agreed limits and rules', () => {
  it('20 likes, 5 new chats, 24h lock, at least 4 photos, 15s voice intro, 5 top picks, 2 day grace', () => {
    expect(DEFAULT_SETTINGS['limits.likes']).toBe(20);
    expect(DEFAULT_SETTINGS['limits.newChats']).toBe(5);
    expect(DEFAULT_SETTINGS['limits.lockHours']).toBe(24);
    expect(DEFAULT_SETTINGS['photos.min']).toBe(4);
    expect(DEFAULT_SETTINGS['voiceIntro.maxSeconds']).toBe(15);
    expect(DEFAULT_SETTINGS['topPicks.count']).toBe(5);
    expect(DEFAULT_SETTINGS['subscription.graceDays']).toBe(2);
  });
});

describe('trust score', () => {
  it('verified, complete profiles score higher than reported, flagged ones', () => {
    const good = scoreTrust({ verified: true, idVerified: true, accountAgeDays: 70, approvedPhotos: 6, hasVoiceIntro: true, reportsLast30Days: 0, openFlags: 0 });
    const bad = scoreTrust({ verified: true, idVerified: false, accountAgeDays: 1, approvedPhotos: 4, hasVoiceIntro: false, reportsLast30Days: 3, openFlags: 2 });
    expect(good).toBeGreaterThanOrEqual(80);
    expect(bad).toBeLessThan(20);
  });
});
