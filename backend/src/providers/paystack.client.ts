import { createHmac, timingSafeEqual } from 'crypto';
import { Injectable } from '@nestjs/common';
import { callJson } from './http';

const BASE = 'https://api.paystack.co';

export interface PaystackTransaction {
  status: string; // success | failed | abandoned
  reference: string;
  amount: number;
  currency: string;
  metadata?: { userId?: string; planId?: string; paywallEventId?: string } | null;
  customer?: { customer_code?: string };
  plan?: string | { plan_code?: string } | null;
}

@Injectable()
export class PaystackClient {
  private headers() {
    return { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' };
  }

  async initialize(input: { email: string; amountMinor: number; currency: string; planCode?: string | null; metadata: Record<string, unknown> }) {
    const res = await callJson<{ data: { authorization_url: string; reference: string } }>(`${BASE}/transaction/initialize`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        email: input.email,
        amount: input.amountMinor,
        currency: input.currency,
        plan: input.planCode ?? undefined,
        callback_url: process.env.PAYSTACK_CALLBACK_URL,
        metadata: input.metadata,
      }),
    });
    return res.data;
  }

  /** Always confirm with Paystack before giving access. */
  async verify(reference: string) {
    const res = await callJson<{ data: PaystackTransaction }>(`${BASE}/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: this.headers(),
    });
    return res.data;
  }

  async refund(reference: string) {
    return callJson(`${BASE}/refund`, { method: 'POST', headers: this.headers(), body: JSON.stringify({ transaction: reference }) });
  }

  isValidSignature(rawBody: Buffer, signature: string | undefined): boolean {
    if (!signature) return false;
    const expected = createHmac('sha512', process.env.PAYSTACK_SECRET_KEY ?? '').update(rawBody).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
