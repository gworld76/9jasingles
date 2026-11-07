// Final agreed prices. Amounts are in minor units (kobo / cents).
export const PLAN_SEED = [
  { id: 'NG_WEEKLY', region: 'NG', interval: 'WEEKLY', currency: 'NGN', amountMinor: 1_000_00, label: null },
  { id: 'NG_MONTHLY', region: 'NG', interval: 'MONTHLY', currency: 'NGN', amountMinor: 3_000_00, label: 'Most popular' },
  { id: 'NG_YEARLY', region: 'NG', interval: 'YEARLY', currency: 'NGN', amountMinor: 28_800_00, label: 'Save 20%' },
  { id: 'INTL_WEEKLY', region: 'INTL', interval: 'WEEKLY', currency: 'USD', amountMinor: 299, label: null },
  { id: 'INTL_MONTHLY', region: 'INTL', interval: 'MONTHLY', currency: 'USD', amountMinor: 599, label: 'Most popular' },
  { id: 'INTL_YEARLY', region: 'INTL', interval: 'YEARLY', currency: 'USD', amountMinor: 5_749, label: 'Save 20%' },
] as const;

/** Price region comes from the verified country of residence, never phone settings. */
export function regionFor(residenceCountry: string): 'NG' | 'INTL' {
  return residenceCountry.toUpperCase() === 'NG' ? 'NG' : 'INTL';
}

export function periodEnd(interval: 'WEEKLY' | 'MONTHLY' | 'YEARLY', from: Date): Date {
  const d = new Date(from);
  if (interval === 'WEEKLY') d.setUTCDate(d.getUTCDate() + 7);
  else if (interval === 'MONTHLY') d.setUTCMonth(d.getUTCMonth() + 1);
  else d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d;
}

/** Paywall order: Yearly (selected, "Save 20%"), Monthly ("Most popular"), Weekly. */
export const PAYWALL_ORDER = ['YEARLY', 'MONTHLY', 'WEEKLY'] as const;
