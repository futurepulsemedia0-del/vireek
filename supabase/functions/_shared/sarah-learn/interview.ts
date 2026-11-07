// supabase/functions/_shared/sarah-learn/interview.ts
//
// Deterministic interview planner. Sarah only asks about GAPS and
// LOW-CONFIDENCE items, in a fixed priority order, capped so the interview
// stays within ~3-5 minutes. No model call is needed to choose or word the
// questions, so the flow is predictable, testable and cheap; owner answers are
// converted to fields by `ownerAnswerField` (schema.ts) with no model either.

import { FIELD_BY_KEY } from './schema.ts';

export type Locale = 'en' | 'es';

export interface InterviewQuestion {
  id: string;
  /** Field this answer fills. */
  key: string;
  text: Record<Locale, string>;
  /** Optional quick-pick answers (still free-text answerable). */
  choices?: { value: string; label: Record<Locale, string> }[];
}

/** Priority order = order of this array. `{name}` is replaced with the business name. */
export const QUESTION_BANK: readonly InterviewQuestion[] = [
  {
    id: 'emergency',
    key: 'emergency_policy',
    text: {
      en: 'If someone calls after hours with a real emergency, what should I do, and do you charge extra?',
      es: 'Si alguien llama fuera de horario con una emergencia real, ¿qué debo hacer y cobran un cargo adicional?',
    },
    choices: [
      { value: 'We take emergency calls any time and charge a premium rate.', label: { en: 'Yes, premium rate', es: 'Sí, tarifa especial' } },
      { value: 'We take emergency calls any time at the same rate.', label: { en: 'Yes, same rate', es: 'Sí, misma tarifa' } },
      { value: 'No, we do not do emergency calls outside business hours.', label: { en: 'Business hours only', es: 'Solo en horario' } },
    ],
  },
  {
    id: 'never_book',
    key: 'never_book',
    text: {
      en: 'Is there any job I should never book? For example a service you do not offer or a kind of customer you turn down.',
      es: '¿Hay algún trabajo que nunca debo agendar? Por ejemplo, un servicio que no ofrecen.',
    },
  },
  {
    id: 'area_edge',
    key: 'service_area_notes',
    text: {
      en: 'What about customers right at the edge of your service area? Do you travel farther, charge more, or say no?',
      es: '¿Qué hago con clientes en el límite de su zona de servicio? ¿Viajan más lejos, cobran más o dicen que no?',
    },
  },
  {
    id: 'trip_fee',
    key: 'diagnostic_fee',
    text: {
      en: 'How should I describe your trip or diagnostic fee when someone asks?',
      es: '¿Cómo debo describir su tarifa de visita o diagnóstico cuando alguien pregunta?',
    },
  },
  {
    id: 'escalation',
    key: 'escalation_contact',
    text: {
      en: 'Who should I call or text when something needs a human, and when?',
      es: '¿A quién debo llamar o escribir cuando algo necesita a una persona, y cuándo?',
    },
  },
  {
    id: 'pronounce',
    key: 'brand_pronunciation',
    text: {
      en: 'How do you say the business name out loud? Anything I should avoid mispronouncing?',
      es: '¿Cómo se pronuncia el nombre del negocio? ¿Algo que deba evitar pronunciar mal?',
    },
  },
  {
    id: 'style',
    key: 'tone_preference',
    text: {
      en: 'How should I sound on the phone: warm and chatty, polished, or brisk?',
      es: '¿Cómo debo sonar por teléfono: cálida y conversadora, profesional o directa?',
    },
    choices: [
      { value: 'Warm and conversational', label: { en: 'Warm', es: 'Cálida' } },
      { value: 'Polished and professional', label: { en: 'Polished', es: 'Profesional' } },
      { value: 'Brisk and to the point', label: { en: 'Brisk', es: 'Directa' } },
    ],
  },
] as const;

export const MAX_INTERVIEW_QUESTIONS = 7;
export const SKIP_TOKENS = /^(skip|pass|not sure|i don'?t know|n\/a|omitir|saltar|no s[eé]|pasar)$/i;

export interface KnownField {
  key: string;
  confidence: 'high' | 'medium' | 'low';
  assumed: boolean;
  status: 'pending' | 'approved' | 'edited' | 'rejected';
  hasValue: boolean;
}

export interface InterviewState {
  asked: string[]; // question ids already asked (answered or skipped)
}

/**
 * A key is a "gap" when it has no value, when the value is a low-confidence
 * assumption, or when it is a sensitive item that no source ever confirmed.
 */
export function isGap(k: KnownField | undefined, key: string): boolean {
  if (!k || !k.hasValue || k.status === 'rejected') return true;
  if (k.status === 'edited') return false; // owner already spoke to it
  if (k.assumed || k.confidence === 'low') return true;
  const sensitive = FIELD_BY_KEY.get(key)?.sensitive ?? false;
  return sensitive && k.confidence !== 'high' && k.status !== 'approved';
}

export function planInterview(known: readonly KnownField[], state: InterviewState): InterviewQuestion[] {
  const byKey = new Map(known.map((k) => [k.key, k]));
  const asked = new Set(state.asked);
  return QUESTION_BANK.filter((q) => !asked.has(q.id) && isGap(byKey.get(q.key), q.key)).slice(0, MAX_INTERVIEW_QUESTIONS);
}

export function nextQuestion(known: readonly KnownField[], state: InterviewState): InterviewQuestion | null {
  const remaining = planInterview(known, state);
  const answeredCount = state.asked.length;
  if (answeredCount >= MAX_INTERVIEW_QUESTIONS) return null;
  return remaining[0] ?? null;
}

export function questionText(q: InterviewQuestion, locale: Locale, businessName?: string): string {
  const base = q.text[locale] ?? q.text.en;
  return businessName && q.id === 'pronounce' ? base.replace(/business name/i, businessName) : base;
}

/** Rough remaining time in seconds (about 25s per question). */
export function estimateRemainingSeconds(remaining: number): number {
  return Math.max(0, remaining) * 25;
}

export function getQuestionById(id: string): InterviewQuestion | undefined {
  return QUESTION_BANK.find((q) => q.id === id);
}
