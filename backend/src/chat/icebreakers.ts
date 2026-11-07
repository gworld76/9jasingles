// 3 suggested opening lines built from the other person's profile.

export interface IcebreakerProfile {
  firstName: string;
  residenceCity: string;
  relationshipGoal: string | null;
  interests: string[];
  prompts: { promptId: string; answer: string }[];
}

const PROMPT_OPENERS: Record<string, (answer: string, name: string) => string> = {
  jollof: (a) => `Your jollof rating says "${a}" — I need to hear the full story 😄`,
  sunday: (a) => `"${a}" for Sunday? Tell me more about how your Sundays go.`,
  naija_food: (a) => `${a}? Good choice. Where do you get the best one?`,
  green_flag: (a) => `I like that your green flag is "${a}". What made that important to you?`,
  weekend: (a) => `Your perfect weekend sounds good — "${a}". What's the best spot for it?`,
  family: () => `I loved what you said about family. Are you close with yours?`,
  music: (a) => `"${a}" always gets you dancing? Okay, what's your second favourite?`,
  first_date: (a) => `"${a}" as a first date sounds lovely. Have you done it before?`,
};

export function icebreakers(p: IcebreakerProfile): string[] {
  const out: string[] = [];
  for (const pr of p.prompts) {
    const fn = PROMPT_OPENERS[pr.promptId];
    if (fn && pr.answer) out.push(fn(pr.answer.slice(0, 80), p.firstName));
    if (out.length === 2) break;
  }
  if (p.interests.length) out.push(`I see you're into ${p.interests[0]} — how did you get into it?`);
  if (out.length < 3) out.push(`Hi ${p.firstName}! How's life in ${p.residenceCity} treating you?`);
  if (out.length < 3 && p.relationshipGoal === 'MARRIAGE') out.push(`I like that you know what you want. What does your ideal partner look like?`);
  if (out.length < 3) out.push(`Hi ${p.firstName}, what's the best thing that happened to you this week?`);
  return out.slice(0, 3);
}
