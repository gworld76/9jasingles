import { Injectable } from '@nestjs/common';
import { callJson } from './http';

const twilioAuth = () =>
  'Basic ' + Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');

@Injectable()
export class SmsProvider {
  /** Termii for +234 numbers, Twilio for international numbers. */
  async send(phone: string, message: string, isNigerian: boolean) {
    if (isNigerian) {
      await callJson('https://api.ng.termii.com/api/sms/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: process.env.TERMII_API_KEY,
          to: phone.replace('+', ''),
          from: process.env.TERMII_SENDER_ID,
          sms: message,
          type: 'plain',
          channel: 'dnd',
        }),
      });
      return;
    }
    const sid = process.env.TWILIO_ACCOUNT_SID;
    await callJson(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: twilioAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: phone, From: process.env.TWILIO_FROM_NUMBER ?? '', Body: message }),
    });
  }

  /** Blocks VoIP and virtual numbers using Twilio Lookup line type intelligence. */
  async isVirtualOrVoip(phone: string): Promise<boolean> {
    const res = await callJson<{ line_type_intelligence?: { type?: string } }>(
      `https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(phone)}?Fields=line_type_intelligence`,
      { headers: { Authorization: twilioAuth() } },
    );
    const type = res.line_type_intelligence?.type ?? '';
    return ['nonFixedVoip', 'fixedVoip', 'voip', 'tollFree', 'sharedCost', 'personal'].includes(type);
  }
}
