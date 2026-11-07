import { Global, Module } from '@nestjs/common';
import { SmsProvider } from './sms.provider';
import { DojahProvider, SmileIdProvider } from './kyc.provider';
import { ModerationProvider } from './moderation.provider';
import { StorageService } from './storage.service';
import { PushProvider } from './push.provider';
import { PaystackClient } from './paystack.client';

const providers = [SmsProvider, SmileIdProvider, DojahProvider, ModerationProvider, StorageService, PushProvider, PaystackClient];

@Global()
@Module({ providers, exports: providers })
export class ProvidersModule {}
