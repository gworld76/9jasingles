// Admin-editable settings. These are the launch values agreed in the plan.
export const DEFAULT_SETTINGS = {
  'limits.likes': 20,               // free likes before the 24h lock
  'limits.newChats': 5,             // free new chats before the 24h lock
  'limits.lockHours': 24,           // lock starts when the limit is hit
  'photos.min': 4,
  'photos.max': 9,
  'voiceIntro.maxSeconds': 15,
  'topPicks.count': 5,
  'subscription.graceDays': 2,
  'reports.autoHideThreshold': 3,   // distinct reporters in 7 days -> hidden until review
  'verification.maxAttempts': 2,    // first try + one retry, then manual review
  'behaviour.likesEveryone.minSwipes': 200,
  'behaviour.likesEveryone.maxPassRatio': 0.03,
  'behaviour.duplicateMessages.threshold': 5,
  'prompts': [
    { id: 'jollof', text: 'My jollof rating…' },
    { id: 'sunday', text: 'Sunday plans: church, mosque or owambe?' },
    { id: 'naija_food', text: 'The Naija food I can never say no to…' },
    { id: 'green_flag', text: 'A green flag I look for…' },
    { id: 'weekend', text: 'My perfect weekend in my city…' },
    { id: 'family', text: 'What family means to me…' },
    { id: 'music', text: 'The song that always gets me dancing…' },
    { id: 'first_date', text: 'My ideal first date…' },
  ],
  'safety.tips': [
    'Never send money, gift cards or crypto to someone you have not met.',
    'Meet in a public place for the first date.',
    'Tell a friend where you are going — use "Share my date".',
    'Arrange your own transport to and from the date.',
    'Keep chats inside 9jaSingles until you trust the person.',
  ],
} as const;

export type SettingKey = keyof typeof DEFAULT_SETTINGS;
