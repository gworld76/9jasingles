// Push notification texts in the five app languages. EN is the fallback for any missing string.
type Lang = 'EN' | 'PCM' | 'YO' | 'IG' | 'HA';
type Key =
  | 'verified' | 'rejected' | 'newMatch' | 'newMessage' | 'likesBack' | 'chatsBack'
  | 'reverify' | 'subscriptionActive' | 'paymentFailed';

const EN: Record<Key, { title: string; body: string }> = {
  verified: { title: 'You are verified 💚', body: 'Your green badge is live. Start meeting verified Nigerians.' },
  rejected: { title: 'Verification needs another try', body: 'Open 9jaSingles to see why and try again.' },
  newMatch: { title: "It's a match! 🎉", body: 'You and {name} like each other. Say hello.' },
  newMessage: { title: '{name}', body: 'Sent you a new message' },
  likesBack: { title: 'Your 20 likes are back 💚', body: 'Start swiping again.' },
  chatsBack: { title: 'You can start new chats again 💬', body: 'Your 5 new chats are back.' },
  reverify: { title: 'Quick selfie check needed', body: 'Take a fresh selfie to keep using 9jaSingles.' },
  subscriptionActive: { title: 'Welcome to 9jaSingles Pro 👑', body: 'Unlimited likes, unlimited chats and your gold badge are live.' },
  paymentFailed: { title: 'Payment failed', body: 'Update your card within 2 days to keep your plan.' },
};

const PCM: Partial<Record<Key, { title: string; body: string }>> = {
  verified: { title: 'Dem don verify you 💚', body: 'Your green badge don land. Start to meet verified Naija people.' },
  newMatch: { title: 'Una don match! 🎉', body: 'You and {name} like each other. Talk to am.' },
  newMessage: { title: '{name}', body: 'Don send you new message' },
  likesBack: { title: 'Your 20 likes don come back 💚', body: 'Start to swipe again.' },
  chatsBack: { title: 'You fit start new chat again 💬', body: 'Your 5 new chats don come back.' },
};

// Yoruba, Igbo and Hausa strings are filled in by the content team; English is used until then.
const TRANSLATIONS: Record<Lang, Partial<Record<Key, { title: string; body: string }>>> = { EN, PCM, YO: {}, IG: {}, HA: {} };

export function pushText(lang: Lang, key: Key, vars: Record<string, string> = {}) {
  const t = TRANSLATIONS[lang]?.[key] ?? EN[key];
  const fill = (s: string) => s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
  return { title: fill(t.title), body: fill(t.body) };
}

export type PushKey = Key;
