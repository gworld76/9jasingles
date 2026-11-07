/* Seeds plans (final prices), default settings and the first admin. Run: npm run db:seed */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import * as schema from './schema';
import { PLAN_SEED } from '../subscriptions/pricing';
import { DEFAULT_SETTINGS } from '../settings/settings.defaults';

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool, { schema });

  for (const p of PLAN_SEED) {
    await db.insert(schema.plans).values({ ...p, label: p.label ?? null })
      .onConflictDoUpdate({ target: schema.plans.id, set: { amountMinor: p.amountMinor, currency: p.currency, label: p.label ?? null } });
  }

  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await db.insert(schema.settings).values({ key, value: value as unknown }).onConflictDoNothing();
  }

  const adminPhone = process.env.ADMIN_PHONE;
  if (adminPhone) {
    const country = parsePhoneNumberFromString(adminPhone)?.country ?? 'NG';
    await db.insert(schema.users)
      .values({ phone: adminPhone, phoneCountry: country, role: 'ADMIN', verificationRoute: country === 'NG' ? 'SELFIE_ONLY' : 'NIGERIAN_ID_SELFIE' })
      .onConflictDoUpdate({ target: schema.users.phone, set: { role: 'ADMIN' } });
  }

  await pool.end();
  console.log('Seed complete: 6 plans, default settings', adminPhone ? `, admin ${adminPhone}` : '');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
