/** All keys and secrets live in .env (git-ignored). The API refuses to start if a required one is missing. */
const REQUIRED = [
  'DATABASE_URL', 'REDIS_URL', 'JWT_ACCESS_SECRET', 'IDENTITY_HASH_SALT', 'PUBLIC_API_URL',
  'TERMII_API_KEY', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER',
  'SMILEID_PARTNER_ID', 'SMILEID_API_KEY', 'DOJAH_APP_ID', 'DOJAH_SECRET_KEY',
  'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'CDN_BASE_URL',
  'MODERATION_API_URL', 'MODERATION_API_KEY', 'PAYSTACK_SECRET_KEY', 'PAYSTACK_CALLBACK_URL',
];

const ALWAYS = ['DATABASE_URL', 'REDIS_URL', 'JWT_ACCESS_SECRET', 'IDENTITY_HASH_SALT'];

export function assertEnv() {
  const needed = process.env.NODE_ENV === 'production' ? REQUIRED : ALWAYS;
  const missing = needed.filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`Missing required settings in .env: ${missing.join(', ')}`);
  if ((process.env.JWT_ACCESS_SECRET ?? '').length < 32) throw new Error('JWT_ACCESS_SECRET must be at least 32 characters');
  if ((process.env.IDENTITY_HASH_SALT ?? '').length < 32) throw new Error('IDENTITY_HASH_SALT must be at least 32 characters');
}
