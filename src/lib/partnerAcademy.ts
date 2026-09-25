// Static content for the Partner Certification course. Lesson completion is
// tracked per-user in partner_academy_progress (same shape as
// src/lib/academy.ts / academy_progress). The quiz is graded client-side for
// instant feedback; record_partner_certification() re-enforces the 80% bar
// server-side so a client can't insert a fake passing score directly.

export interface PartnerLesson {
  id: string;
  title: string;
  minutes: number;
  body: string;
}

export const PARTNER_LESSONS: PartnerLesson[] = [
  {
    id: 'who-vireek-is-for',
    title: 'Who Vireek is for',
    minutes: 4,
    body: 'Vireek is an AI phone agent + dispatch platform for home-service businesses (HVAC, plumbing, electrical, roofing, restoration and similar trades) that miss calls during jobs. The best-fit prospect is an owner-operator or small team, usually 1-20 trucks, who already gets steady inbound call volume and is losing bookings to voicemail — not a business that needs more leads generated for it.',
  },
  {
    id: 'core-pitch',
    title: 'The core pitch in 30 seconds',
    minutes: 5,
    body: 'Sarah (Vireek\u2019s AI agent) answers every call the business can\u2019t get to, in the business\u2019s own voice, qualifies the caller, quotes from their real price book when possible, and books the job straight onto the dispatch board. The value is measured in recovered jobs and after-hours/emergency calls, not "AI features" — lead with the missed-call cost, not the technology.',
  },
  {
    id: 'plans-and-pricing',
    title: 'Plans, pricing and what to promise',
    minutes: 4,
    body: 'Current public tiers are Starter, Professional and Business (Enterprise is custom) — check /pricing for live numbers before quoting anyone, since this course does not hard-code prices. Never promise a discount, custom contract term, or SLA beyond what /pricing and /sla state; if a prospect needs something outside that, route them to the Vireek team instead of promising it yourself.',
  },
  {
    id: 'referral-mechanics',
    title: 'How your referral link actually works',
    minutes: 3,
    body: 'Your link is yours alone — every click is logged, and if that visitor signs up within 30 days it is permanently credited to you, even if they don\u2019t sign up the same day. Commission is calculated automatically once the referred account becomes an active paying subscriber, and shows up on your Referrals page — you never need to self-report a sale.',
  },
  {
    id: 'good-referral-etiquette',
    title: 'What makes a referral stick',
    minutes: 4,
    body: 'The referrals that convert and stay converted are ones where the prospect understood what they were signing up for before they clicked — set accurate expectations about setup time (same-day for most businesses) and what Sarah can and can\u2019t do, rather than overselling. Never imply a guarantee about revenue, call volume, or ranking — Vireek does not make those claims and neither should you.',
  },
];

export function getAllPartnerLessonIds(): string[] {
  return PARTNER_LESSONS.map((l) => l.id);
}

export interface PartnerQuizQuestion {
  id: string;
  prompt: string;
  options: { id: string; text: string }[];
  correctOptionId: string;
}

export const PARTNER_QUIZ: PartnerQuizQuestion[] = [
  {
    id: 'q1',
    prompt: 'Who is the best-fit prospect for Vireek?',
    options: [
      { id: 'a', text: 'A home-service business already getting calls but missing some of them' },
      { id: 'b', text: 'A brand-new business with no call volume yet' },
      { id: 'c', text: 'A large call center evaluating enterprise software' },
    ],
    correctOptionId: 'a',
  },
  {
    id: 'q2',
    prompt: 'What should you lead with when pitching Vireek?',
    options: [
      { id: 'a', text: 'The underlying AI model and technology stack' },
      { id: 'b', text: 'The cost of missed calls and recovered jobs' },
      { id: 'c', text: 'A comparison of every competitor feature-by-feature' },
    ],
    correctOptionId: 'b',
  },
  {
    id: 'q3',
    prompt: 'Where should you check pricing before quoting a prospect?',
    options: [
      { id: 'a', text: 'From memory, since it rarely changes' },
      { id: 'b', text: 'The live /pricing page' },
      { id: 'c', text: 'Whatever the last prospect told you they paid' },
    ],
    correctOptionId: 'b',
  },
  {
    id: 'q4',
    prompt: 'How long does your referral link stay attributed to you after someone clicks it?',
    options: [
      { id: 'a', text: 'It expires immediately if they don\u2019t sign up same-day' },
      { id: 'b', text: '30 days' },
      { id: 'c', text: 'It never expires, regardless of activity' },
    ],
    correctOptionId: 'b',
  },
  {
    id: 'q5',
    prompt: 'When is a referral\u2019s commission calculated?',
    options: [
      { id: 'a', text: 'As soon as the link is clicked' },
      { id: 'b', text: 'Only if you manually report the sale' },
      { id: 'c', text: 'Automatically once the referred account becomes an active paying subscriber' },
    ],
    correctOptionId: 'c',
  },
  {
    id: 'q6',
    prompt: 'Which of these is acceptable to tell a prospect?',
    options: [
      { id: 'a', text: 'A guarantee that Vireek will increase their revenue by a specific amount' },
      { id: 'b', text: 'An accurate description of setup time and what Sarah can and can\u2019t do' },
      { id: 'c', text: 'A custom discount you invent on the spot' },
    ],
    correctOptionId: 'b',
  },
];

export const PARTNER_QUIZ_PASS_PERCENT = 80;
