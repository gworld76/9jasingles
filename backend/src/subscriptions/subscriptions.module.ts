import {
  BadRequestException, Body, Controller, ForbiddenException, Get, Headers, HttpCode, Injectable, Logger, Module, NotFoundException, Param, Post, Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { IsOptional, IsString, IsUUID } from 'class-validator';
import { and, desc, eq, gt, inArray, lt } from 'drizzle-orm';
import { Database, InjectDb } from '../database/database.module';
import { paymentEvents, paywallEvents, plans, profiles, subscriptions } from '../database/schema';
import { PaystackClient, PaystackTransaction } from '../providers/paystack.client';
import { EntitlementsService } from './entitlements.service';
import { SettingsService } from '../settings/settings.service';
import { NotificationsService } from '../notifications/notifications.module';
import { TrustService } from '../trust/trust.service';
import { CurrentUser, AuthUser, Public } from '../common/auth.decorators';
import { addDays } from '../common/time';
import { PAYWALL_ORDER, periodEnd, regionFor } from './pricing';

class CheckoutDto {
  @IsString() planId!: string;
  @IsOptional() @IsUUID() paywallEventId?: string;
}

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  constructor(
    @InjectDb() private readonly db: Database,
    private readonly paystack: PaystackClient,
    private readonly entitlements: EntitlementsService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
    private readonly trust: TrustService,
  ) {}

  private async regionOf(userId: string) {
    const [p] = await this.db.select({ country: profiles.residenceCountry }).from(profiles).where(eq(profiles.userId, userId));
    if (!p) throw new BadRequestException({ code: 'BASIC_INFO_REQUIRED' });
    return regionFor(p.country);
  }

  async plansFor(userId: string) {
    const region = await this.regionOf(userId);
    const rows = await this.db.select().from(plans).where(and(eq(plans.region, region), eq(plans.active, true)));
    const sorted = PAYWALL_ORDER.map((i) => rows.find((r) => r.interval === i)).filter((r): r is NonNullable<typeof r> => !!r);
    return {
      region,
      selectedPlanId: sorted[0]?.id ?? null, // Yearly selected by default
      plans: sorted.map((p) => ({ id: p.id, interval: p.interval, currency: p.currency, amountMinor: p.amountMinor, label: p.label })),
      perks: ['Unlimited likes', 'Unlimited chats', 'See who likes you', 'Gold subscriber badge'],
      footer: 'Cancel anytime',
    };
  }

  async checkout(userId: string, dto: CheckoutDto) {
    const region = await this.regionOf(userId);
    const [plan] = await this.db.select().from(plans).where(eq(plans.id, dto.planId));
    if (!plan || !plan.active) throw new NotFoundException();
    if (plan.region !== region) throw new ForbiddenException({ code: 'PLAN_NOT_AVAILABLE_IN_REGION' });
    return this.paystack.initialize({
      email: `${userId}@users.9jasingles.app`, // Paystack needs an email; users sign up by phone
      amountMinor: plan.amountMinor,
      currency: plan.currency,
      planCode: plan.paystackPlanCode,
      metadata: { userId, planId: plan.id, paywallEventId: dto.paywallEventId },
    });
  }

  /** Called by the app after returning from Paystack. Access is only given after Paystack confirms. */
  async verify(userId: string, reference: string) {
    const tx = await this.paystack.verify(reference);
    if (tx.metadata?.userId !== userId) throw new ForbiddenException();
    if (tx.status !== 'success') return { active: false, status: tx.status };
    await this.activate(tx);
    return { active: true, ...(await this.entitlements.get(userId)) };
  }

  async handleWebhook(rawBody: Buffer | undefined, signature: string | undefined, body: { event: string; data: any }) {
    if (!rawBody || !this.paystack.isValidSignature(rawBody, signature)) throw new ForbiddenException();
    const reference: string | null = body.data?.reference ?? body.data?.subscription_code ?? null;
    await this.db.insert(paymentEvents).values({ event: body.event, reference, payload: body });

    switch (body.event) {
      case 'charge.success': {
        const tx = await this.paystack.verify(body.data.reference); // always confirm with Paystack
        if (tx.status === 'success') await this.activate(tx);
        break;
      }
      case 'subscription.create':
        await this.linkSubscriptionCode(body.data);
        break;
      case 'subscription.not_renew':
      case 'subscription.disable':
        await this.markCancelled(body.data.subscription_code);
        break;
      case 'invoice.payment_failed':
        await this.startGrace(body.data.subscription?.subscription_code ?? body.data.subscription_code);
        break;
    }
    return { received: true };
  }

  private async activate(tx: PaystackTransaction) {
    const userId = tx.metadata?.userId;
    const planId = tx.metadata?.planId ?? (await this.planIdFromCode(tx.plan));
    if (!userId || !planId) {
      this.logger.warn(`Unmatched Paystack charge ${tx.reference}`);
      return;
    }
    const [already] = await this.db.select().from(subscriptions).where(eq(subscriptions.lastReference, tx.reference));
    if (already) return; // idempotent

    const [plan] = await this.db.select().from(plans).where(eq(plans.id, planId));
    if (!plan || tx.amount < plan.amountMinor || tx.currency !== plan.currency) {
      this.logger.warn(`Amount/currency mismatch for ${tx.reference}`);
      return;
    }
    const [current] = await this.db.select().from(subscriptions)
      .where(and(eq(subscriptions.userId, userId), inArray(subscriptions.status, ['ACTIVE', 'GRACE', 'CANCELLED']), gt(subscriptions.activeUntil, new Date())))
      .orderBy(desc(subscriptions.activeUntil)).limit(1);
    const from = current && current.planId === planId ? current.activeUntil : new Date(); // renewal extends
    const activeUntil = periodEnd(plan.interval, from);

    if (current && current.planId === planId) {
      await this.db.update(subscriptions).set({
        status: 'ACTIVE', activeUntil, graceUntil: null, lastReference: tx.reference, updatedAt: new Date(),
      }).where(eq(subscriptions.id, current.id));
    } else {
      if (current) await this.db.update(subscriptions).set({ status: 'EXPIRED', updatedAt: new Date() }).where(eq(subscriptions.id, current.id));
      await this.db.insert(subscriptions).values({
        userId, planId, status: 'ACTIVE', activeUntil, lastReference: tx.reference, paystackCustomerCode: tx.customer?.customer_code ?? null,
      });
      await this.notifications.push(userId, 'subscriptionActive');
    }

    // Mark which paywall trigger converted.
    const paywallEventId = tx.metadata?.paywallEventId;
    const [ev] = paywallEventId
      ? await this.db.select().from(paywallEvents).where(and(eq(paywallEvents.id, paywallEventId), eq(paywallEvents.userId, userId)))
      : await this.db.select().from(paywallEvents).where(and(eq(paywallEvents.userId, userId), gt(paywallEvents.createdAt, addDays(new Date(), -1)))).orderBy(desc(paywallEvents.createdAt)).limit(1);
    if (ev) await this.db.update(paywallEvents).set({ converted: true, planId }).where(eq(paywallEvents.id, ev.id));

    await this.entitlements.invalidate(userId);
    await this.trust.recompute(userId);
  }

  private async planIdFromCode(plan: PaystackTransaction['plan']) {
    const code = typeof plan === 'string' ? plan : plan?.plan_code;
    if (!code) return null;
    const [p] = await this.db.select().from(plans).where(eq(plans.paystackPlanCode, code));
    return p?.id ?? null;
  }

  private async linkSubscriptionCode(data: { subscription_code: string; customer?: { customer_code?: string }; plan?: { plan_code?: string } }) {
    const planId = await this.planIdFromCode(data.plan ?? null);
    const customer = data.customer?.customer_code;
    if (!planId || !customer) return;
    const [sub] = await this.db.select().from(subscriptions)
      .where(and(eq(subscriptions.paystackCustomerCode, customer), eq(subscriptions.planId, planId)))
      .orderBy(desc(subscriptions.createdAt)).limit(1);
    if (sub) await this.db.update(subscriptions).set({ paystackSubscriptionCode: data.subscription_code }).where(eq(subscriptions.id, sub.id));
  }

  private async bySubCode(code?: string) {
    if (!code) return null;
    const [sub] = await this.db.select().from(subscriptions).where(eq(subscriptions.paystackSubscriptionCode, code));
    return sub ?? null;
  }

  /** Cancelled plans stay active until the end of the paid period. */
  private async markCancelled(code?: string) {
    const sub = await this.bySubCode(code);
    if (!sub) return;
    await this.db.update(subscriptions).set({ status: 'CANCELLED', updatedAt: new Date() }).where(eq(subscriptions.id, sub.id));
    await this.entitlements.invalidate(sub.userId);
  }

  /** Failed payment: 2-day grace period, then back to Free. */
  private async startGrace(code?: string) {
    const sub = await this.bySubCode(code);
    if (!sub) return;
    const days = await this.settings.getNumber('subscription.graceDays');
    await this.db.update(subscriptions).set({ status: 'GRACE', graceUntil: addDays(new Date(), days), updatedAt: new Date() }).where(eq(subscriptions.id, sub.id));
    await this.entitlements.invalidate(sub.userId);
    await this.notifications.push(sub.userId, 'paymentFailed');
  }

  /** Hourly job: expired plans drop to Free and the gold badge disappears. */
  async expireDue() {
    const now = new Date();
    const expired = await this.db.update(subscriptions).set({ status: 'EXPIRED', updatedAt: now })
      .where(and(inArray(subscriptions.status, ['ACTIVE', 'CANCELLED']), lt(subscriptions.activeUntil, now))).returning({ userId: subscriptions.userId });
    const graceOver = await this.db.update(subscriptions).set({ status: 'EXPIRED', updatedAt: now })
      .where(and(eq(subscriptions.status, 'GRACE'), lt(subscriptions.graceUntil, now))).returning({ userId: subscriptions.userId });
    for (const r of [...expired, ...graceOver]) await this.entitlements.invalidate(r.userId);
    return expired.length + graceOver.length;
  }

  /** Admin: give a free plan. */
  async comp(userId: string, planId: string, days: number, adminId: string) {
    await this.db.insert(subscriptions).values({ userId, planId, status: 'ACTIVE', activeUntil: addDays(new Date(), days), compedById: adminId });
    await this.entitlements.invalidate(userId);
  }

  /** Admin: refund the latest payment and end the plan. */
  async refund(subscriptionId: string) {
    const [sub] = await this.db.select().from(subscriptions).where(eq(subscriptions.id, subscriptionId));
    if (!sub?.lastReference) throw new NotFoundException();
    await this.paystack.refund(sub.lastReference);
    await this.db.update(subscriptions).set({ status: 'EXPIRED', activeUntil: new Date(), updatedAt: new Date() }).where(eq(subscriptions.id, sub.id));
    await this.entitlements.invalidate(sub.userId);
    return { refunded: true };
  }
}

@Controller('subscriptions')
export class SubscriptionsController {
  constructor(private readonly subs: SubscriptionsService, private readonly entitlements: EntitlementsService) {}

  @Get('plans') plans(@CurrentUser() u: AuthUser) { return this.subs.plansFor(u.id); }
  @Get('me') me(@CurrentUser() u: AuthUser) { return this.entitlements.get(u.id); }
  @Post('checkout') checkout(@CurrentUser() u: AuthUser, @Body() dto: CheckoutDto) { return this.subs.checkout(u.id, dto); }
  @Get('verify/:reference') verify(@CurrentUser() u: AuthUser, @Param('reference') ref: string) { return this.subs.verify(u.id, ref); }

  @Public() @Post('webhook/paystack') @HttpCode(200)
  webhook(@Req() req: RawBodyRequest<Request>, @Headers('x-paystack-signature') sig: string, @Body() body: { event: string; data: any }) {
    return this.subs.handleWebhook(req.rawBody, sig, body);
  }
}

@Module({ controllers: [SubscriptionsController], providers: [SubscriptionsService], exports: [SubscriptionsService] })
export class SubscriptionsModule {}
