import { Injectable } from '@nestjs/common';
import { callJson } from './http';

export interface PushMessage {
  to: string[];
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

/** Expo push service - delivers to FCM (Android) and APNs (iOS) for the React Native (Expo) app. */
@Injectable()
export class PushProvider {
  async send(msg: PushMessage) {
    if (!msg.to.length) return;
    await callJson('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` } : {}),
      },
      body: JSON.stringify(msg.to.map((to) => ({ to, title: msg.title, body: msg.body, data: msg.data, sound: 'default' }))),
    });
  }
}
