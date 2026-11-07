// Badges are never stored - they are worked out from verification, residence and subscription so they can't be faked.

const SHORT_COUNTRY: Record<string, string> = { GB: 'UK', US: 'USA', AE: 'UAE' };
const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });

export function countryName(iso2: string, short = true): string {
  const code = iso2.toUpperCase();
  if (short && SHORT_COUNTRY[code]) return SHORT_COUNTRY[code];
  return regionNames.of(code) ?? code;
}

export interface BadgeInput {
  verificationStatus: string;
  residenceCity: string;
  residenceCountry: string;
  locationDisplay: 'CITY' | 'COUNTRY_ONLY';
  isSubscriber: boolean;
}

export interface BadgeOutput {
  badges: ('verified' | 'subscriber')[];
  badgeLabel: string | null;
}

export function computeBadges(i: BadgeInput): BadgeOutput {
  // Gold always needs green: no verification, no badges at all.
  if (i.verificationStatus !== 'VERIFIED') return { badges: [], badgeLabel: null };

  const badges: BadgeOutput['badges'] = ['verified'];
  if (i.isSubscriber) badges.push('subscriber');

  const inNigeria = i.residenceCountry.toUpperCase() === 'NG';
  let place: string;
  if (i.locationDisplay === 'COUNTRY_ONLY') place = countryName(i.residenceCountry, false);
  else if (inNigeria) place = i.residenceCity;                                        // "Lagos"
  else place = `${i.residenceCity}, ${countryName(i.residenceCountry)}`;              // "London, UK"

  return { badges, badgeLabel: `Verified Nigerian · ${place}` };
}
