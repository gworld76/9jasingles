import { KycResult } from '../providers/kyc.provider';

export const FACE_MATCH_MIN_SCORE = 80;

const normName = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, ' ').trim();

/** Profile first name must match a name on the ID. */
export function nameMatches(profileFirstName: string, idFirst: string | null, idLast: string | null): boolean {
  const tokens = `${normName(idFirst ?? '')} ${normName(idLast ?? '')}`.split(/\s+/).filter(Boolean);
  return tokens.includes(normName(profileFirstName).split(/\s+/)[0]);
}

/** Accepts YYYY-MM-DD, DD-MM-YYYY, DD/MM/YYYY. */
export function normalizeDob(s: string | null): string | null {
  if (!s) return null;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = s.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  return null;
}

export interface DecisionInput {
  route: 'SELFIE_ONLY' | 'NIGERIAN_ID_SELFIE';
  isReverification: boolean;
  userId: string;
  profileFirstName: string;
  profileDob: string; // YYYY-MM-DD
  phoneCountry: string;
  residenceCountry: string;
  faceBanned: boolean;
  result: KycResult;
}

export type FlagCode = 'DUPLICATE_FACE' | 'ID_DETAILS_MISMATCH' | 'LOCATION_MISMATCH';

export interface Decision {
  outcome: 'VERIFIED' | 'FAILED' | 'REVIEW' | 'BAN';
  reason: string | null;
  nameMatched: boolean | null;
  dobMatched: boolean | null;
  flags: FlagCode[];
}

export function decideVerification(i: DecisionInput): Decision {
  const r = i.result;
  const base = { nameMatched: null as boolean | null, dobMatched: null as boolean | null, flags: [] as FlagCode[] };

  if (i.faceBanned) return { ...base, outcome: 'BAN', reason: 'BANNED_FACE' };
  if (!r.livenessPassed) return { ...base, outcome: 'FAILED', reason: 'LIVENESS_FAILED' };
  if (r.duplicateFaceUserId && r.duplicateFaceUserId !== i.userId) {
    return { ...base, outcome: 'FAILED', reason: 'DUPLICATE_FACE', flags: ['DUPLICATE_FACE'] };
  }

  // Fresh selfie re-check: must match the face from the first verification.
  if (i.isReverification && (r.faceMatchScore == null || r.faceMatchScore < FACE_MATCH_MIN_SCORE)) {
    return { ...base, outcome: 'FAILED', reason: 'FACE_DOES_NOT_MATCH_ACCOUNT' };
  }

  if (i.route === 'NIGERIAN_ID_SELFIE' && !i.isReverification) {
    if (r.idNationality && r.idNationality.toUpperCase() !== 'NG' && r.idNationality.toUpperCase() !== 'NIGERIA') {
      return { ...base, outcome: 'FAILED', reason: 'NOT_NIGERIAN_ID' };
    }
    if (r.faceMatchScore == null || r.faceMatchScore < FACE_MATCH_MIN_SCORE) {
      return { ...base, outcome: 'FAILED', reason: 'FACE_DOES_NOT_MATCH_ID' };
    }
    base.nameMatched = nameMatches(i.profileFirstName, r.idFirstName, r.idLastName);
    base.dobMatched = normalizeDob(r.idDateOfBirth) === i.profileDob;
    if (!base.nameMatched || !base.dobMatched) {
      return { ...base, outcome: 'FAILED', reason: 'ID_DETAILS_MISMATCH', flags: ['ID_DETAILS_MISMATCH'] };
    }
  }

  // Phone country must agree with country of residence (a +44 number living in Toronto goes to admin review).
  if (!i.isReverification && i.phoneCountry.toUpperCase() !== i.residenceCountry.toUpperCase()) {
    return { ...base, outcome: 'REVIEW', reason: 'LOCATION_REVIEW', flags: ['LOCATION_MISMATCH'] };
  }

  return { ...base, outcome: 'VERIFIED', reason: null };
}
