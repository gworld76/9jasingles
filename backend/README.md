# 9jaSingles API — Version 1

Backend for 9jaSingles: a dating app for verified Nigerians at home and abroad.
NestJS (TypeScript) · PostgreSQL + PostGIS · Redis · Socket.IO · BullMQ · Drizzle ORM.

## Run locally

```bash
cp .env.example .env            # fill in secrets
docker compose up -d postgres redis
npm install
npm run db:migrate              # creates all tables (+ PostGIS)
npm run db:seed                 # 6 plans, default settings, first admin (ADMIN_PHONE)
npm run start:dev               # http://localhost:3000/v1/health
npm test                        # business-rule tests
```

Production: `docker build .` · run `drizzle/sql/partition_swipes.sql` once before launch to partition swipes by month (a monthly job then creates each new partition).

## What's built (Version 1 plan)

| Area | Rule in code |
|---|---|
| Sign-up | Phone OTP (Termii for +234, Twilio abroad). VoIP/virtual numbers blocked. Device fingerprint, max accounts per device, banned devices refused. |
| Verification | +234 → liveness selfie only. Foreign number → **NIN or Nigerian passport** + liveness selfie. Smile ID main, Dojah backup. Name + DOB must match the ID. Face dedupe. One retry, then manual review. Phone country ≠ residence → admin review. |
| One identity, one account | Only an HMAC hash of the NIN/passport number is stored. A second account with the same ID is refused and flagged. |
| Badges | Computed, never stored. 🟢 `Verified Nigerian · Lagos` / `Verified Nigerian · London, UK` (or country only). 🟢🟡 with any active paid plan. Gold always needs green. |
| Access | `VerifiedGuard`: no green badge, banned, pending re-check or unfinished onboarding = no Discover, swipes, matches, chat or Likes You. |
| Profile | 4–9 photos (each checked: clear face, matches selfie, not stock/celebrity/AI; nudity auto-blurred), 15s voice intro, relationship goal, religion, 3 Naija prompts, interests. Main-photo change re-checks the face. Name/DOB locked after verification. |
| Discover | Filters: age, distance (PostGIS), city, relationship goal, religion, "Nigerians in my city". Decks pre-built in Redis. Low trust shown less. Low-data photo variants. Daily Top Picks (5). |
| Limits | Free: **20 likes** and **5 new chats**, each locked for **24h from the moment the limit is hit**. Replies never count. Push when they're back. Paid: unlimited. Limits editable in admin. |
| Paywall | `LIMIT_REACHED` on the 21st like and 6th new chat, Likes You tap, end-of-onboarding offer. Every view logged with its trigger; conversions tracked. |
| Plans | NG: ₦1,000 weekly · ₦3,000 monthly · ₦28,800 yearly (Save 20%). Abroad: $2.99 · $5.99 · $57.49 (Save 20%). Region from verified residence. Paystack with signed webhooks, 2-day grace on failed payment. |
| Likes You | Free: count + blurred photos only. Paid: full profiles. |
| Chat | Socket.IO + Redis adapter. Text, photo, voice notes, read receipts, typing. 3 icebreakers. Scam detection (money, gift cards, crypto, early WhatsApp, links) with warning. Duplicate-message detection. |
| Safety | Block, report (any report → fresh selfie check; 3 reporters in 7 days → hidden until review), Share my date (SMS to a friend), SOS, safety centre. |
| Trust | Hidden 0–100 score from verification, account age, photos, voice intro, reports and flags. Recomputed on events and nightly. |
| Full ban | Phone + device + identity + face. |
| Admin | Verification queue, reports with chat evidence, flags, SOS, user search/detail, ban/unban/unhide/force re-verify, comp/refund, plan prices, settings, analytics. |

## Modules

```
src/
  auth/ devices/ verification/ identity/ users/ media/ moderation/ discovery/ swipes/ matches/
  chat/ limits/ subscriptions/ badges/ trust/ safety/ notifications/ admin/ jobs/
  bans/ realtime/ settings/ providers/ database/ common/
```

## API (prefix `/v1`)

- **Auth:** `POST auth/otp/request` · `POST auth/otp/verify` · `POST auth/refresh` · `POST auth/logout`
- **Verification:** `GET verification/status` · `POST verification/start` · `POST verification/dojah` · `POST verification/webhook/smileid`
- **Users:** `GET users/me` · `PUT users/me/basic-info` · `PATCH users/me/profile` · `GET users/me/onboarding` · `POST users/me/complete-onboarding` · `DELETE users/me` · `GET users/prompts` · `GET users/:id`
- **Media:** `GET media/photos` · `POST media/photos/upload-url` · `POST media/photos/confirm` · `DELETE media/photos/:position` · `POST media/voice/upload-url` · `POST media/voice/confirm`
- **Discover:** `GET discover` · `GET discover/top-picks`
- **Swipes:** `POST swipes` · `GET swipes/limits`
- **Matches:** `GET matches` · `DELETE matches/:id`
- **Chat:** `GET/POST chat/:matchId/messages` · `POST chat/:matchId/read` · `GET chat/:matchId/icebreakers` · `POST chat/media-url` · socket namespace `/chat` (auth token in handshake)
- **Likes You:** `GET likes-you` · `POST likes-you/tap`
- **Subscriptions:** `GET subscriptions/plans` · `GET subscriptions/me` · `POST subscriptions/checkout` · `GET subscriptions/verify/:reference` · `POST subscriptions/webhook/paystack`
- **Safety:** `GET safety/centre` · `POST safety/block` · `POST safety/report` · `POST safety/share-date` · `POST safety/sos`
- **Notifications:** `POST notifications/push-tokens` · `DELETE notifications/push-tokens/:token`
- **Admin:** `admin/verifications/*` · `admin/reports*` · `admin/flags*` · `admin/sos` · `admin/users*` · `admin/subscriptions/*` · `admin/plans*` · `admin/settings*` · `admin/analytics`

Error for limits: `429 { code: "LIMIT_REACHED", type: "like" | "chat", resetsAt, paywallEventId }`.

## Not in Version 1
Voice/video calls (Version 1.5). GPS location checks and travel mode (Version 2).
