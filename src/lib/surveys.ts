/**
 * Post-job surveys (NPS / CSAT) — pure domain logic.
 *
 * No I/O in this file: types, validation, scoring math and trend bucketing so
 * everything here is unit-tested (see surveys.test.ts). Data access lives in
 * surveysApi.ts. Schema: supabase/migrations/20270410000000_post_job_surveys.sql
 */

export type SurveyType = 'nps' | 'csat';
export type SurveyChannel = 'sms' | 'email' | 'both';
export type InvitationStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'skipped' | 'responded';
export type CaseStatus = 'open' | 'contacted' | 'resolved' | 'dismissed';
export type CaseSeverity = 'high' | 'critical';

export interface SurveyTemplate {
  id: string;
  user_id: string;
  name: string;
  survey_type: SurveyType;
  question: string;
  follow_up_question: string | null;
  thank_you_message: string;
  channel: SurveyChannel;
  sms_body: string;
  email_subject: string;
  auto_send: boolean;
  auto_send_enabled_at: string | null;
  send_delay_minutes: number;
  cooldown_days: number;
  timezone: string;
  low_score_threshold: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/** The editable subset of a template (what the builder form produces). */
export type SurveyTemplateInput = Pick<
  SurveyTemplate,
  | 'name'
  | 'survey_type'
  | 'question'
  | 'follow_up_question'
  | 'thank_you_message'
  | 'channel'
  | 'sms_body'
  | 'email_subject'
  | 'auto_send'
  | 'send_delay_minutes'
  | 'cooldown_days'
  | 'timezone'
  | 'low_score_threshold'
  | 'is_active'
>;

export interface SurveyInvitation {
  id: string;
  user_id: string;
  template_id: string | null;
  job_id: string | null;
  technician_id: string | null;
  template_name: string;
  survey_type: SurveyType;
  channel: SurveyChannel;
  customer_name: string;
  customer_phone: string | null;
  customer_email: string | null;
  service_type: string | null;
  status: InvitationStatus;
  trigger_source: 'auto' | 'manual';
  sent_at: string | null;
  channel_used: string | null;
  delivery_error: string | null;
  score: number | null;
  comment: string | null;
  responded_at: string | null;
  low_score_threshold: number;
  created_at: string;
}

export interface RecoveryCase {
  id: string;
  user_id: string;
  invitation_id: string;
  job_id: string | null;
  survey_type: SurveyType;
  score: number;
  comment: string | null;
  customer_name: string;
  customer_phone: string | null;
  customer_email: string | null;
  severity: CaseSeverity;
  status: CaseStatus;
  resolution_note: string | null;
  contacted_at: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Labels / constants
// ---------------------------------------------------------------------------

export const SURVEY_TYPE_LABELS: Record<SurveyType, string> = { nps: 'NPS', csat: 'CSAT' };
export const SURVEY_TYPE_DESCRIPTIONS: Record<SurveyType, string> = {
  nps: 'Net Promoter Score — "How likely are you to recommend us?" (0–10)',
  csat: 'Customer Satisfaction — "How satisfied were you?" (1–5)',
};
export const CHANNEL_LABELS: Record<SurveyChannel, string> = { sms: 'SMS', email: 'Email', both: 'SMS + Email' };
export const CASE_STATUS_LABELS: Record<CaseStatus, string> = {
  open: 'Open',
  contacted: 'Contacted',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
};
export const INVITATION_STATUS_LABELS: Record<InvitationStatus, string> = {
  pending: 'Queued',
  sending: 'Sending',
  sent: 'Awaiting reply',
  failed: 'Failed',
  skipped: 'Skipped',
  responded: 'Responded',
};

export const SCORE_RANGE: Record<SurveyType, { min: number; max: number }> = {
  nps: { min: 0, max: 10 },
  csat: { min: 1, max: 5 },
};
/** Highest threshold the builder allows (matches the DB CHECK constraint). */
export const THRESHOLD_RANGE: Record<SurveyType, { min: number; max: number; default: number }> = {
  nps: { min: 0, max: 8, default: 6 },
  csat: { min: 1, max: 4, default: 2 },
};

export const MERGE_TAGS = ['{{customer_first_name}}', '{{business_name}}', '{{link}}'] as const;

export const TREND_RANGES = [
  { key: '7d', label: '7 days', days: 7 },
  { key: '30d', label: '30 days', days: 30 },
  { key: '90d', label: '90 days', days: 90 },
] as const;
export type TrendRangeKey = (typeof TREND_RANGES)[number]['key'];

// ---------------------------------------------------------------------------
// Template defaults + validation
// ---------------------------------------------------------------------------

export function defaultTemplateInput(type: SurveyType): SurveyTemplateInput {
  const isNps = type === 'nps';
  return {
    name: isNps ? 'Post-job NPS' : 'Post-job CSAT',
    survey_type: type,
    question: isNps
      ? 'How likely are you to recommend us to a friend or neighbor?'
      : 'How satisfied were you with the service you received today?',
    follow_up_question: isNps ? 'What is the main reason for your score?' : 'Anything we could have done better?',
    thank_you_message: 'Thank you — your feedback helps us serve you better.',
    channel: 'both',
    sms_body:
      'Hi {{customer_first_name}}, thanks for choosing {{business_name}}! How did we do? It takes 10 seconds: {{link}}',
    email_subject: 'How did we do, {{customer_first_name}}?',
    auto_send: false,
    send_delay_minutes: 120,
    cooldown_days: 30,
    timezone: defaultTimezone(),
    low_score_threshold: THRESHOLD_RANGE[type].default,
    is_active: true,
  };
}

export function defaultTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';
  } catch {
    return 'America/New_York';
  }
}

export type TemplateErrors = Partial<Record<keyof SurveyTemplateInput, string>>;

export function validateTemplate(t: SurveyTemplateInput): TemplateErrors {
  const e: TemplateErrors = {};
  const name = t.name.trim();
  if (!name) e.name = 'Give the survey a name.';
  else if (name.length > 120) e.name = 'Keep the name under 120 characters.';

  const q = t.question.trim();
  if (q.length < 5) e.question = 'The question must be at least 5 characters.';
  else if (q.length > 300) e.question = 'Keep the question under 300 characters.';

  if (t.follow_up_question && t.follow_up_question.length > 300) {
    e.follow_up_question = 'Keep the follow-up under 300 characters.';
  }
  if (!t.thank_you_message.trim()) e.thank_you_message = 'Add a thank-you message.';
  else if (t.thank_you_message.length > 500) e.thank_you_message = 'Keep it under 500 characters.';

  if (t.channel !== 'email') {
    if (!t.sms_body.includes('{{link}}')) e.sms_body = 'The SMS must include {{link}} so customers can respond.';
    else if (t.sms_body.length < 10) e.sms_body = 'The SMS is too short.';
    else if (t.sms_body.length > 320) e.sms_body = 'SMS is limited to 320 characters.';
  }
  if (t.channel !== 'sms') {
    if (!t.email_subject.trim()) e.email_subject = 'Add an email subject.';
    else if (t.email_subject.length > 150) e.email_subject = 'Keep the subject under 150 characters.';
  }

  const { min, max } = THRESHOLD_RANGE[t.survey_type];
  if (!Number.isInteger(t.low_score_threshold) || t.low_score_threshold < min || t.low_score_threshold > max) {
    e.low_score_threshold = `Choose a threshold between ${min} and ${max}.`;
  }
  if (!Number.isInteger(t.send_delay_minutes) || t.send_delay_minutes < 0 || t.send_delay_minutes > 10080) {
    e.send_delay_minutes = 'Delay must be between 0 minutes and 7 days.';
  }
  if (!Number.isInteger(t.cooldown_days) || t.cooldown_days < 0 || t.cooldown_days > 365) {
    e.cooldown_days = 'Cooldown must be between 0 and 365 days.';
  }
  return e;
}

/** Fills {{customer_first_name}} / {{business_name}} / {{link}}. Unknown tags are left untouched. */
export function renderMergeTags(
  template: string,
  vars: { customer_first_name: string; business_name: string; link: string },
): string {
  return template.replace(/\{\{\s*(customer_first_name|business_name|link)\s*\}\}/g, (_m, key: keyof typeof vars) => vars[key]);
}

export function firstName(fullName: string | null | undefined): string {
  const n = (fullName ?? '').trim().split(/\s+/)[0];
  return n || 'there';
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export type NpsBucket = 'promoter' | 'passive' | 'detractor';

export function npsBucket(score: number): NpsBucket {
  if (score >= 9) return 'promoter';
  if (score >= 7) return 'passive';
  return 'detractor';
}

export function isValidScore(type: SurveyType, score: number): boolean {
  const { min, max } = SCORE_RANGE[type];
  return Number.isInteger(score) && score >= min && score <= max;
}

export function isLowScore(type: SurveyType, score: number, threshold: number): boolean {
  return isValidScore(type, score) && score <= threshold;
}

/** Mirrors the DB rule in submit_survey_response(). */
export function recoverySeverity(type: SurveyType, score: number): CaseSeverity {
  if (type === 'nps') return score <= 3 ? 'critical' : 'high';
  return score === 1 ? 'critical' : 'high';
}

export interface NpsStats {
  responses: number;
  promoters: number;
  passives: number;
  detractors: number;
  /** -100..100, null when there are no responses. */
  nps: number | null;
}

export function computeNps(scores: number[]): NpsStats {
  const valid = scores.filter((s) => isValidScore('nps', s));
  let promoters = 0;
  let passives = 0;
  let detractors = 0;
  for (const s of valid) {
    const b = npsBucket(s);
    if (b === 'promoter') promoters++;
    else if (b === 'passive') passives++;
    else detractors++;
  }
  const n = valid.length;
  return {
    responses: n,
    promoters,
    passives,
    detractors,
    nps: n === 0 ? null : Math.round(((promoters - detractors) / n) * 100),
  };
}

export interface CsatStats {
  responses: number;
  satisfied: number;
  /** % of 4–5 ratings (the industry-standard CSAT), null when no responses. */
  csat: number | null;
  /** Mean rating 1..5 to one decimal, null when no responses. */
  average: number | null;
}

export function computeCsat(scores: number[]): CsatStats {
  const valid = scores.filter((s) => isValidScore('csat', s));
  const n = valid.length;
  if (n === 0) return { responses: 0, satisfied: 0, csat: null, average: null };
  const satisfied = valid.filter((s) => s >= 4).length;
  const sum = valid.reduce((a, b) => a + b, 0);
  return {
    responses: n,
    satisfied,
    csat: Math.round((satisfied / n) * 100),
    average: Math.round((sum / n) * 10) / 10,
  };
}

// ---------------------------------------------------------------------------
// Analytics over invitations
// ---------------------------------------------------------------------------

export interface SurveySummary {
  nps: NpsStats;
  csat: CsatStats;
  sent: number;
  responded: number;
  /** % of delivered surveys answered, null when nothing delivered. */
  responseRate: number | null;
}

/** Surveys that actually reached a customer (sent or since answered). */
export function isDelivered(i: Pick<SurveyInvitation, 'status'>): boolean {
  return i.status === 'sent' || i.status === 'responded';
}

export function summarize(invitations: SurveyInvitation[]): SurveySummary {
  const responded = invitations.filter((i) => i.status === 'responded' && i.score !== null);
  const sent = invitations.filter(isDelivered).length;
  return {
    nps: computeNps(responded.filter((i) => i.survey_type === 'nps').map((i) => i.score as number)),
    csat: computeCsat(responded.filter((i) => i.survey_type === 'csat').map((i) => i.score as number)),
    sent,
    responded: responded.length,
    responseRate: sent === 0 ? null : Math.round((responded.length / sent) * 100),
  };
}

export interface TrendPoint {
  /** Bucket start, YYYY-MM-DD (UTC). */
  date: string;
  responses: number;
  /** NPS (-100..100) or CSAT (0..100) for the bucket, null when empty. */
  value: number | null;
}

const DAY_MS = 86_400_000;

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Daily trend for one survey type over the last `days` days (inclusive of today).
 * Days with no responses are kept (value null) so the chart shows real gaps instead of lying by interpolation.
 */
export function buildTrend(
  invitations: SurveyInvitation[],
  type: SurveyType,
  days: number,
  now: Date = new Date(),
): TrendPoint[] {
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const buckets = new Map<string, number[]>();
  for (let d = days - 1; d >= 0; d--) buckets.set(utcDay(todayStart - d * DAY_MS), []);

  for (const i of invitations) {
    if (i.survey_type !== type || i.status !== 'responded' || i.score === null || !i.responded_at) continue;
    const ts = Date.parse(i.responded_at);
    if (Number.isNaN(ts)) continue;
    buckets.get(utcDay(ts))?.push(i.score);
  }

  return [...buckets.entries()].map(([date, scores]) => ({
    date,
    responses: scores.length,
    value: scores.length === 0 ? null : type === 'nps' ? computeNps(scores).nps : computeCsat(scores).csat,
  }));
}

export interface GroupScore {
  key: string;
  label: string;
  responses: number;
  value: number | null;
}

/** Score per technician for one survey type; unassigned jobs are grouped as "Unassigned". */
export function scoreByTechnician(
  invitations: SurveyInvitation[],
  type: SurveyType,
  technicianNames: Record<string, string>,
): GroupScore[] {
  const groups = new Map<string, number[]>();
  for (const i of invitations) {
    if (i.survey_type !== type || i.status !== 'responded' || i.score === null) continue;
    const key = i.technician_id ?? 'unassigned';
    const list = groups.get(key) ?? [];
    list.push(i.score);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .map(([key, scores]) => ({
      key,
      label: key === 'unassigned' ? 'Unassigned' : (technicianNames[key] ?? 'Former team member'),
      responses: scores.length,
      value: type === 'nps' ? computeNps(scores).nps : computeCsat(scores).csat,
    }))
    .sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity) || b.responses - a.responses);
}

/** Human label + tone for an NPS value. */
export function npsTone(nps: number | null): 'good' | 'ok' | 'bad' | 'none' {
  if (nps === null) return 'none';
  if (nps >= 50) return 'good';
  if (nps >= 0) return 'ok';
  return 'bad';
}

export function csatTone(csat: number | null): 'good' | 'ok' | 'bad' | 'none' {
  if (csat === null) return 'none';
  if (csat >= 85) return 'good';
  if (csat >= 70) return 'ok';
  return 'bad';
}

export function describeSurveyError(e: unknown): string {
  const err = e as { code?: string; message?: string } | null;
  if (err?.code === '23505') {
    return 'You already have an active auto-send survey of this type. Turn it off first, or edit that one.';
  }
  if (err?.code === '42501') return 'You do not have permission to do that.';
  return err?.message || 'Something went wrong. Please try again.';
}
