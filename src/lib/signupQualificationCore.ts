export type QuestionId = 'trade' | 'team_size' | 'call_handling';
export type QualAnswers = Partial<Record<QuestionId, string>>;

export interface QualOption {
  readonly value: string;
  readonly label: string;
}
export interface QualQuestion {
  readonly id: QuestionId;
  readonly title: string;
  readonly columns: 2 | 3;
  readonly options: readonly QualOption[];
}

/** Values MUST match the CHECK constraints in 20290306000000_signup_qualification.sql
 *  and the option values used by src/pages/OnboardingPage.tsx. */
export const QUALIFICATION_QUESTIONS: readonly QualQuestion[] = [
  {
    id: 'trade',
    title: 'What kind of work do you do?',
    columns: 3,
    options: [
      { value: 'hvac', label: 'HVAC' },
      { value: 'plumbing', label: 'Plumbing' },
      { value: 'electrical', label: 'Electrical' },
      { value: 'roofing', label: 'Roofing' },
      { value: 'general_home_services', label: 'General home services' },
      { value: 'other', label: 'Other' },
    ],
  },
  {
    id: 'team_size',
    title: 'How big is your team?',
    columns: 2,
    options: [
      { value: 'solo', label: 'Just me' },
      { value: '2-5', label: '2–5 people' },
      { value: '6-15', label: '6–15 people' },
      { value: '16+', label: '16+ people' },
    ],
  },
  {
    id: 'call_handling',
    title: 'Who answers your calls today?',
    columns: 2,
    options: [
      { value: 'in_house', label: 'Our own staff' },
      { value: 'answering_service', label: 'An answering service' },
      { value: 'voicemail', label: 'Voicemail' },
      { value: 'another_ai_tool', label: 'Another AI tool' },
      { value: 'none', label: 'Nobody — we miss some' },
    ],
  },
];

export const QUALIFICATION_WINDOW_MS = 72 * 60 * 60 * 1000;
export const QUALIFICATION_ROUTE = '/welcome-setup';

/** Keeps only known question ids with known option values. */
export function sanitizeAnswers(raw: unknown): QualAnswers {
  const out: QualAnswers = {};
  if (!raw || typeof raw !== 'object') return out;
  const src = raw as Record<string, unknown>;
  for (const q of QUALIFICATION_QUESTIONS) {
    const v = src[q.id];
    if (typeof v === 'string' && q.options.some((o) => o.value === v)) out[q.id] = v;
  }
  return out;
}

export function hasAnyAnswer(a: QualAnswers): boolean {
  return Object.keys(sanitizeAnswers(a)).length > 0;
}

/** Only brand-new, un-onboarded account owners are ever prompted. */
export function shouldPromptQualification(i: {
  role?: string | null;
  createdAt?: string | null;
  onboardingCompleted?: boolean | null;
  now: number;
}): boolean {
  if (i.role !== 'owner') return false;
  if (i.onboardingCompleted === true) return false;
  if (!i.createdAt) return false;
  const created = Date.parse(i.createdAt);
  if (Number.isNaN(created)) return false;
  const age = i.now - created;
  return age >= -60_000 && age <= QUALIFICATION_WINDOW_MS;
}
