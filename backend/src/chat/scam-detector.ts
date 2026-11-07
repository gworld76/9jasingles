// Flags messages that ask for money, gift cards or crypto, push to move off-app quickly, or share links.

const PATTERNS: { reason: string; re: RegExp }[] = [
  { reason: 'MONEY_REQUEST', re: /\b(send|lend|borrow|transfer|wire|need)\b.{0,30}\b(money|cash|funds?|naira|dollars?|pounds?|£|\$|₦|\d+k)\b/i },
  { reason: 'MONEY_REQUEST', re: /\b(account (number|details)|acct no|bank details|my (opay|palmpay|moniepoint|kuda))\b/i },
  { reason: 'MONEY_REQUEST', re: /\b(abeg|pls|please)\b.{0,20}\b(recharge|airtime|data|transport fare|t-?fare)\b/i },
  { reason: 'GIFT_CARD', re: /\b(gift ?cards?|itunes|steam card|amazon card|google play card)\b/i },
  { reason: 'CRYPTO', re: /\b(bitcoin|btc|usdt|crypto|binance|forex|investment platform|double your money)\b/i },
  { reason: 'OFF_PLATFORM', re: /\b(whatsapp|telegram|watsapp|wa\.me|snap(chat)?|text me on)\b/i },
  { reason: 'LINK', re: /(https?:\/\/|www\.)\S+/i },
];

export interface ScamCheck {
  flagged: boolean;
  reasons: string[];
}

/**
 * `messagesSoFar` = number of messages already in the conversation. Moving to WhatsApp is only
 * flagged when it's pushed early (first 20 messages).
 */
export function detectScam(text: string | null | undefined, messagesSoFar = 0): ScamCheck {
  if (!text) return { flagged: false, reasons: [] };
  const reasons = new Set<string>();
  for (const p of PATTERNS) {
    if (p.reason === 'OFF_PLATFORM' && messagesSoFar >= 20) continue;
    if (p.re.test(text)) reasons.add(p.reason);
  }
  return { flagged: reasons.size > 0, reasons: [...reasons] };
}

export const SCAM_WARNING = "Never send money to someone you haven't met.";
