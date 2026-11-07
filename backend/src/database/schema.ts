// 9jaSingles - Version 1 database schema (Drizzle ORM, PostgreSQL + PostGIS)
import {
  pgTable, pgEnum, uuid, text, varchar, integer, boolean, timestamp, doublePrecision,
  jsonb, primaryKey, uniqueIndex, index, real,
} from 'drizzle-orm/pg-core';

export const roleEnum = pgEnum('role', ['USER', 'MODERATOR', 'ADMIN']);
export const languageEnum = pgEnum('language', ['EN', 'PCM', 'YO', 'IG', 'HA']); // English, Pidgin, Yoruba, Igbo, Hausa
export const genderEnum = pgEnum('gender', ['MALE', 'FEMALE']);
export const verificationStatusEnum = pgEnum('verification_status', ['PENDING', 'IN_REVIEW', 'VERIFIED', 'REJECTED']);
export const verificationRouteEnum = pgEnum('verification_route', ['SELFIE_ONLY', 'NIGERIAN_ID_SELFIE']);
export const idDocumentTypeEnum = pgEnum('id_document_type', ['NIN', 'NIGERIAN_PASSPORT']);
export const relationshipGoalEnum = pgEnum('relationship_goal', ['MARRIAGE', 'SERIOUS_RELATIONSHIP', 'FRIENDSHIP_FIRST']);
export const locationDisplayEnum = pgEnum('location_display', ['CITY', 'COUNTRY_ONLY']);
export const swipeActionEnum = pgEnum('swipe_action', ['LIKE', 'PASS']);
export const messageTypeEnum = pgEnum('message_type', ['TEXT', 'PHOTO', 'VOICE']);
export const planIntervalEnum = pgEnum('plan_interval', ['WEEKLY', 'MONTHLY', 'YEARLY']);
export const pricingRegionEnum = pgEnum('pricing_region', ['NG', 'INTL']);
export const subscriptionStatusEnum = pgEnum('subscription_status', ['ACTIVE', 'GRACE', 'CANCELLED', 'EXPIRED']);
export const paywallTriggerEnum = pgEnum('paywall_trigger', ['LIKE_LIMIT', 'CHAT_LIMIT', 'LIKES_YOU_TAP', 'ONBOARDING_OFFER']);
export const reportReasonEnum = pgEnum('report_reason', ['FAKE_PROFILE', 'SCAM_OR_MONEY_REQUEST', 'HARASSMENT', 'NUDITY', 'UNDERAGE', 'OTHER']);
export const reportStatusEnum = pgEnum('report_status', ['OPEN', 'ACTIONED', 'DISMISSED']);
export const moderationFlagTypeEnum = pgEnum('moderation_flag_type', [
  'NUDITY', 'STOCK_OR_CELEBRITY_PHOTO', 'AI_GENERATED_PHOTO', 'PHOTO_FACE_MISMATCH', 'SCAM_MESSAGE',
  'LIKES_EVERYONE', 'DUPLICATE_MESSAGES', 'REPORT_SPIKE', 'LOCATION_MISMATCH', 'DUPLICATE_IDENTITY',
  'DUPLICATE_FACE', 'ID_DETAILS_MISMATCH',
]);

const ts = (name: string) => timestamp(name, { withTimezone: true });

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  phone: varchar('phone', { length: 20 }).notNull().unique(), // E.164
  phoneCountry: varchar('phone_country', { length: 2 }).notNull(), // ISO-2 from phone number
  role: roleEnum('role').notNull().default('USER'),
  language: languageEnum('language').notNull().default('EN'),
  verificationStatus: verificationStatusEnum('verification_status').notNull().default('PENDING'),
  verificationRoute: verificationRouteEnum('verification_route').notNull(),
  verificationAttempts: integer('verification_attempts').notNull().default(0),
  verifiedAt: ts('verified_at'),
  faceTemplateId: text('face_template_id'), // provider face id from the liveness selfie
  hiddenUntilReview: boolean('hidden_until_review').notNull().default(false),
  mustReverify: boolean('must_reverify').notNull().default(false),
  isBanned: boolean('is_banned').notNull().default(false),
  onboardingComplete: boolean('onboarding_complete').notNull().default(false),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  lastActiveAt: ts('last_active_at').notNull().defaultNow(),
  deletedAt: ts('deleted_at'),
}, (t) => [index('users_verification_idx').on(t.verificationStatus)]);

export const profiles = pgTable('profiles', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  firstName: varchar('first_name', { length: 60 }).notNull(),
  dateOfBirth: timestamp('date_of_birth', { mode: 'date' }).notNull(),
  gender: genderEnum('gender').notNull(),
  interestedIn: genderEnum('interested_in').notNull(),
  residenceCity: varchar('residence_city', { length: 100 }).notNull(),
  residenceCountry: varchar('residence_country', { length: 2 }).notNull(),
  stateOfOrigin: varchar('state_of_origin', { length: 40 }).notNull(),
  latitude: doublePrecision('latitude'), // city centre only - never exact location
  longitude: doublePrecision('longitude'),
  locationDisplay: locationDisplayEnum('location_display').notNull().default('CITY'),
  relationshipGoal: relationshipGoalEnum('relationship_goal'),
  religion: varchar('religion', { length: 40 }),
  bio: varchar('bio', { length: 500 }),
  interests: text('interests').array().notNull().default([]),
  prompts: jsonb('prompts').$type<{ promptId: string; answer: string }[]>().notNull().default([]),
  minAgePref: integer('min_age_pref').notNull().default(18),
  maxAgePref: integer('max_age_pref').notNull().default(60),
  maxDistanceKm: integer('max_distance_km').notNull().default(100),
  lowDataMode: boolean('low_data_mode').notNull().default(false),
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, (t) => [
  index('profiles_residence_idx').on(t.residenceCountry, t.residenceCity),
  index('profiles_gender_idx').on(t.gender),
]);

export const photos = pgTable('photos', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  storageKey: text('storage_key').notNull(),
  position: integer('position').notNull(), // 0 = main photo
  approved: boolean('approved').notNull().default(false),
  blurred: boolean('blurred').notNull().default(false),
  faceMatched: boolean('face_matched').notNull().default(false),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => [uniqueIndex('photos_user_position_uq').on(t.userId, t.position)]);

export const voiceIntros = pgTable('voice_intros', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  storageKey: text('storage_key').notNull(),
  durationSeconds: integer('duration_seconds').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const verifications = pgTable('verifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  route: verificationRouteEnum('route').notNull(),
  documentType: idDocumentTypeEnum('document_type'),
  provider: varchar('provider', { length: 20 }).notNull(), // smileid | dojah
  providerJobId: text('provider_job_id').notNull().unique(),
  status: verificationStatusEnum('status').notNull().default('IN_REVIEW'),
  reason: text('reason'),
  livenessPassed: boolean('liveness_passed'),
  faceMatchScore: real('face_match_score'),
  nameMatched: boolean('name_matched'),
  dobMatched: boolean('dob_matched'),
  reviewedById: uuid('reviewed_by_id'),
  createdAt: ts('created_at').notNull().defaultNow(),
  completedAt: ts('completed_at'),
}, (t) => [index('verifications_status_idx').on(t.status)]);

// One identity, one account: only a salted hash of the NIN / passport number is stored.
export const identityHashes = pgTable('identity_hashes', {
  hash: text('hash').primaryKey(),
  userId: uuid('user_id').notNull().unique().references(() => users.id, { onDelete: 'cascade' }),
  docType: idDocumentTypeEnum('doc_type').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const devices = pgTable('devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  fingerprint: text('fingerprint').notNull().unique(),
  platform: varchar('platform', { length: 10 }).notNull(),
  isBanned: boolean('is_banned').notNull().default(false),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const userDevices = pgTable('user_devices', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  deviceId: uuid('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.userId, t.deviceId] })]);

export const refreshTokens = pgTable('refresh_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: ts('expires_at').notNull(),
  revokedAt: ts('revoked_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const pushTokens = pgTable('push_tokens', {
  token: text('token').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  platform: varchar('platform', { length: 10 }).notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

// Partitioned by month in production - see drizzle/sql/partition_swipes.sql
export const swipes = pgTable('swipes', {
  swiperId: uuid('swiper_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  targetId: uuid('target_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  action: swipeActionEnum('action').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.swiperId, t.targetId] }),
  index('swipes_target_action_idx').on(t.targetId, t.action),
]);

export const matches = pgTable('matches', {
  id: uuid('id').primaryKey().defaultRandom(),
  userAId: uuid('user_a_id').notNull().references(() => users.id, { onDelete: 'cascade' }), // smaller id
  userBId: uuid('user_b_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: ts('created_at').notNull().defaultNow(),
  unmatchedAt: ts('unmatched_at'),
}, (t) => [uniqueIndex('matches_pair_uq').on(t.userAId, t.userBId)]);

export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  matchId: uuid('match_id').notNull().references(() => matches.id, { onDelete: 'cascade' }),
  senderId: uuid('sender_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  type: messageTypeEnum('type').notNull().default('TEXT'),
  body: varchar('body', { length: 2000 }),
  mediaKey: text('media_key'),
  scamFlag: boolean('scam_flag').notNull().default(false),
  createdAt: ts('created_at').notNull().defaultNow(),
  readAt: ts('read_at'),
}, (t) => [
  index('messages_match_created_idx').on(t.matchId, t.createdAt),
  index('messages_sender_created_idx').on(t.senderId, t.createdAt),
]);

export const plans = pgTable('plans', {
  id: varchar('id', { length: 30 }).primaryKey(), // e.g. NG_WEEKLY
  region: pricingRegionEnum('region').notNull(),
  interval: planIntervalEnum('interval').notNull(),
  currency: varchar('currency', { length: 3 }).notNull(), // NGN | USD
  amountMinor: integer('amount_minor').notNull(), // kobo / cents
  label: varchar('label', { length: 30 }),
  paystackPlanCode: text('paystack_plan_code'),
  active: boolean('active').notNull().default(true),
}, (t) => [uniqueIndex('plans_region_interval_uq').on(t.region, t.interval)]);

export const subscriptions = pgTable('subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  planId: varchar('plan_id', { length: 30 }).notNull().references(() => plans.id),
  status: subscriptionStatusEnum('status').notNull(),
  activeUntil: ts('active_until').notNull(),
  graceUntil: ts('grace_until'),
  paystackCustomerCode: text('paystack_customer_code'),
  paystackSubscriptionCode: text('paystack_subscription_code').unique(),
  lastReference: text('last_reference'),
  compedById: uuid('comped_by_id'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, (t) => [index('subscriptions_user_status_idx').on(t.userId, t.status)]);

export const paymentEvents = pgTable('payment_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  provider: varchar('provider', { length: 20 }).notNull().default('paystack'),
  event: text('event').notNull(),
  reference: text('reference'),
  payload: jsonb('payload').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => [index('payment_events_reference_idx').on(t.reference)]);

export const paywallEvents = pgTable('paywall_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  trigger: paywallTriggerEnum('trigger').notNull(),
  converted: boolean('converted').notNull().default(false),
  planId: varchar('plan_id', { length: 30 }),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => [index('paywall_events_trigger_idx').on(t.trigger, t.createdAt)]);

export const reports = pgTable('reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  reporterId: uuid('reporter_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  reportedId: uuid('reported_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  reason: reportReasonEnum('reason').notNull(),
  note: varchar('note', { length: 1000 }),
  matchId: uuid('match_id'),
  status: reportStatusEnum('status').notNull().default('OPEN'),
  handledById: uuid('handled_by_id'),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => [
  index('reports_reported_idx').on(t.reportedId, t.createdAt),
  index('reports_status_idx').on(t.status),
]);

export const blocks = pgTable('blocks', {
  blockerId: uuid('blocker_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  blockedId: uuid('blocked_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.blockerId, t.blockedId] })]);

// Full ban: phone + device + identity + face
export const bans = pgTable('bans', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id'),
  phone: varchar('phone', { length: 20 }),
  identityHash: text('identity_hash'),
  faceTemplateId: text('face_template_id'),
  reason: text('reason').notNull(),
  createdById: uuid('created_by_id').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  liftedAt: ts('lifted_at'),
}, (t) => [index('bans_phone_idx').on(t.phone), index('bans_identity_idx').on(t.identityHash)]);

export const trustScores = pgTable('trust_scores', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  score: integer('score').notNull().default(50), // 0-100, hidden from users
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const moderationFlags = pgTable('moderation_flags', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  type: moderationFlagTypeEnum('type').notNull(),
  detail: jsonb('detail'),
  resolved: boolean('resolved').notNull().default(false),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => [index('moderation_flags_open_idx').on(t.resolved, t.type)]);

export const topPicks = pgTable('top_picks', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: uuid('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  pickId: uuid('pick_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  forDate: varchar('for_date', { length: 10 }).notNull(), // YYYY-MM-DD Lagos time
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => [uniqueIndex('top_picks_uq').on(t.ownerId, t.pickId, t.forDate)]);

export const dateShares = pgTable('date_shares', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  matchId: uuid('match_id').notNull(),
  friendPhone: varchar('friend_phone', { length: 20 }).notNull(),
  venue: text('venue').notNull(),
  dateTime: ts('date_time').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const sosEvents = pgTable('sos_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  latitude: doublePrecision('latitude'),
  longitude: doublePrecision('longitude'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

// Admin-editable settings (limits, prompts, top picks) - no code change needed
export const settings = pgTable('settings', {
  key: varchar('key', { length: 60 }).primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const adminAuditLogs = pgTable('admin_audit_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  adminId: uuid('admin_id').notNull(),
  action: text('action').notNull(),
  targetId: uuid('target_id'),
  detail: jsonb('detail'),
  createdAt: ts('created_at').notNull().defaultNow(),
});
