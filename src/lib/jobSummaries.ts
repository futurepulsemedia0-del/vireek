// Post-job summaries — types, validation and display helpers (pure, unit-tested).
// Schema: supabase/migrations/20271020000000_job_summaries.sql
// Engine: supabase/functions/job-summary-engine · Public read: supabase/functions/job-summary-public
import {
  BLOCKING_WARNINGS,
  SUMMARY_LIMITS,
  WARNING_MESSAGES,
  buildWarnings,
  formatDateLong,
  hasBlockingWarning,
  isValidISODate,
  renderEmail,
  renderSms,
  unknownTemplateVariables,
  warrantyStatus,
  type SummaryPart,
  type SummaryPhoto,
  type SummaryWarranty,
  type WarningCode,
} from '../../supabase/functions/_shared/job-summary/compose';

export {
  BLOCKING_WARNINGS,
  SUMMARY_LIMITS,
  WARNING_MESSAGES,
  buildWarnings,
  formatDateLong,
  hasBlockingWarning,
  renderEmail,
  renderSms,
  unknownTemplateVariables,
  warrantyStatus,
};
export type { SummaryPart, SummaryPhoto, SummaryWarranty, WarningCode };

export type SummaryStatus = 'draft' | 'scheduled' | 'sending' | 'sent' | 'failed' | 'skipped';
export type SummaryChannel = 'sms' | 'email' | 'both';
export type ChannelState = 'pending' | 'sent' | 'failed' | 'skipped';

export interface JobSummary {
  id: string;
  user_id: string;
  job_id: string;
  customer_id: string | null;
  token: string;
  headline: string;
  intro: string;
  work_summary: string;
  work_items: string[];
  parts: SummaryPart[];
  warranty: SummaryWarranty[];
  photos: SummaryPhoto[];
  maintenance_tips: string[];
  next_service_date: string | null;
  next_service_note: string | null;
  technician_first_name: string | null;
  service_type: string | null;
  service_date: string | null;
  customer_name: string;
  warnings: WarningCode[];
  ai_polished: boolean;
  trigger_source: 'auto' | 'manual';
  status: SummaryStatus;
  channel: SummaryChannel;
  scheduled_send_at: string | null;
  sms_state: ChannelState;
  email_state: ChannelState;
  sent_at: string | null;
  channel_used: string | null;
  delivery_error: string | null;
  first_viewed_at: string | null;
  view_count: number;
  generated_at: string;
  last_edited_at: string | null;
  edited_after_send_at: string | null;
  created_at: string;
}

export interface JobSummarySettings {
  auto_generate: boolean;
  auto_send: boolean;
  review_window_minutes: number;
  channel: SummaryChannel;
  ai_polish: boolean;
  include_photos: boolean;
  include_parts: boolean;
  include_warranty: boolean;
  include_tips: boolean;
  max_photos: number;
  labor_warranty_days: number | null;
  parts_warranty_note: string | null;
  default_service_interval_months: number;
  custom_tips: string[];
  sms_body: string;
  email_subject: string;
  timezone: string;
}

export const DEFAULT_SETTINGS: JobSummarySettings = {
  auto_generate: false,
  auto_send: false,
  review_window_minutes: 60,
  channel: 'both',
  ai_polish: true,
  include_photos: true,
  include_parts: true,
  include_warranty: true,
  include_tips: true,
  max_photos: 6,
  labor_warranty_days: null,
  parts_warranty_note: null,
  default_service_interval_months: 12,
  custom_tips: [],
  sms_body: 'Hi {{customer_first_name}}, here is a summary of your recent visit from {{business_name}}: {{link}}',
  email_subject: 'Your service summary from {{business_name}}',
  timezone: 'America/New_York',
};

export const STATUS_LABELS: Record<SummaryStatus, string> = {
  draft: 'Needs review',
  scheduled: 'Scheduled',
  sending: 'Sending…',
  sent: 'Sent',
  failed: 'Failed',
  skipped: 'Not sent',
};

export const STATUS_TONE: Record<SummaryStatus, 'neutral' | 'info' | 'success' | 'danger' | 'warning'> = {
  draft: 'warning',
  scheduled: 'info',
  sending: 'info',
  sent: 'success',
  failed: 'danger',
  skipped: 'neutral',
};

export const CHANNEL_LABELS: Record<SummaryChannel, string> = { sms: 'Text message', email: 'Email', both: 'Text + email' };

export const summaryLink = (token: string, origin: string) => `${origin.replace(/\/$/, '')}/summary/${token}`;

export function describeWarnings(codes: readonly string[]): string[] {
  return codes.map((c) => WARNING_MESSAGES[c as WarningCode]).filter((m): m is string => !!m);
}

/** "Sends in 42 min" / "Sends in 3 h" / "Due now" for a scheduled summary. */
export function scheduledCountdown(iso: string | null, now: number = Date.now()): string {
  if (!iso) return '';
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms)) return '';
  if (ms <= 60_000) return 'Due now';
  const min = Math.round(ms / 60_000);
  if (min < 90) return `Sends in ${min} min`;
  const h = Math.round(min / 60);
  return h < 36 ? `Sends in ${h} h` : `Sends in ${Math.round(h / 24)} days`;
}

export function canEditContent(s: Pick<JobSummary, 'status'>): boolean {
  return s.status !== 'sending';
}

// ---------------------------------------------------------------------------
// Draft (the editable part) + validation
// ---------------------------------------------------------------------------

export interface SummaryDraft {
  headline: string;
  intro: string;
  work_summary: string;
  work_items: string[];
  parts: SummaryPart[];
  warranty: SummaryWarranty[];
  photos: SummaryPhoto[];
  maintenance_tips: string[];
  next_service_date: string | null;
  next_service_note: string | null;
  channel: SummaryChannel;
}

export function toDraft(s: JobSummary): SummaryDraft {
  return {
    headline: s.headline,
    intro: s.intro,
    work_summary: s.work_summary,
    work_items: [...s.work_items],
    parts: s.parts.map((p) => ({ ...p })),
    warranty: s.warranty.map((w) => ({ ...w })),
    photos: s.photos.map((p) => ({ ...p })),
    maintenance_tips: [...s.maintenance_tips],
    next_service_date: s.next_service_date,
    next_service_note: s.next_service_note,
    channel: s.channel,
  };
}

const clean = (v: string) => v.replace(/\s+/g, ' ').trim();

/** Trims, drops blank rows, caps lengths — what actually gets saved. */
export function normalizeDraft(d: SummaryDraft): SummaryDraft {
  const list = (a: string[], max: number, len: number) => a.map(clean).filter(Boolean).slice(0, max).map((x) => x.slice(0, len));
  return {
    headline: clean(d.headline).slice(0, SUMMARY_LIMITS.headline),
    intro: clean(d.intro).slice(0, SUMMARY_LIMITS.intro),
    work_summary: d.work_summary.trim().slice(0, 3000),
    work_items: list(d.work_items, SUMMARY_LIMITS.workItems, SUMMARY_LIMITS.workItem),
    parts: d.parts
      .map((p) => ({ name: clean(p.name).slice(0, SUMMARY_LIMITS.partName), quantity: Math.max(1, Math.round(Number(p.quantity) || 1)) }))
      .filter((p) => p.name)
      .slice(0, SUMMARY_LIMITS.parts),
    warranty: d.warranty
      .map((w) => ({
        label: clean(w.label).slice(0, SUMMARY_LIMITS.warrantyLabel),
        expires_on: w.expires_on && isValidISODate(w.expires_on) ? w.expires_on.slice(0, 10) : null,
        note: w.note ? clean(w.note).slice(0, SUMMARY_LIMITS.warrantyNote) || null : null,
      }))
      .filter((w) => w.label)
      .slice(0, SUMMARY_LIMITS.warranty),
    photos: d.photos.slice(0, SUMMARY_LIMITS.photos),
    maintenance_tips: list(d.maintenance_tips, SUMMARY_LIMITS.tips, SUMMARY_LIMITS.tip),
    next_service_date: d.next_service_date && isValidISODate(d.next_service_date) ? d.next_service_date.slice(0, 10) : null,
    next_service_note: d.next_service_note ? clean(d.next_service_note).slice(0, SUMMARY_LIMITS.nextServiceNote) || null : null,
    channel: d.channel,
  };
}

export type DraftErrors = Partial<Record<'headline' | 'intro' | 'work_summary' | 'work_items' | 'next_service_date' | 'content', string>>;

export function validateDraft(d: SummaryDraft): DraftErrors {
  const e: DraftErrors = {};
  if (!clean(d.headline)) e.headline = 'Add a headline.';
  else if (clean(d.headline).length > SUMMARY_LIMITS.headline) e.headline = `Keep it under ${SUMMARY_LIMITS.headline} characters.`;
  if (d.intro.length > SUMMARY_LIMITS.intro) e.intro = `Keep it under ${SUMMARY_LIMITS.intro} characters.`;
  if (d.work_summary.length > 3000) e.work_summary = 'That is too long (3,000 characters max).';
  if (d.work_items.some((i) => clean(i).length > SUMMARY_LIMITS.workItem)) e.work_items = `Each item must be under ${SUMMARY_LIMITS.workItem} characters.`;
  if (d.next_service_date && !isValidISODate(d.next_service_date)) e.next_service_date = 'Enter a valid date.';
  const n = normalizeDraft(d);
  if (!n.work_summary && n.work_items.length === 0) e.content = 'Describe what was done before sending.';
  return e;
}

export function draftChanged(a: SummaryDraft, b: SummaryDraft): boolean {
  return JSON.stringify(normalizeDraft(a)) !== JSON.stringify(normalizeDraft(b));
}

/** Warnings for the CURRENT draft (not the generation-time snapshot). */
export function draftWarnings(d: SummaryDraft, base: readonly string[]): WarningCode[] {
  const n = normalizeDraft(d);
  const computed = buildWarnings(n, {
    qualityFailed: base.includes('QUALITY_FAILED'),
    disputed: base.includes('DISPUTED'),
    includePhotos: true,
    includeWarranty: true,
    hasContact: !base.includes('NO_CONTACT'),
  });
  return computed;
}

// ---------------------------------------------------------------------------
// Settings validation
// ---------------------------------------------------------------------------

export type SettingsErrors = Partial<Record<'sms_body' | 'email_subject' | 'review_window_minutes' | 'labor_warranty_days' | 'custom_tips', string>>;

export function validateSettings(s: JobSummarySettings): SettingsErrors {
  const e: SettingsErrors = {};
  if (s.sms_body.length < 10 || s.sms_body.length > 320) e.sms_body = 'Text must be 10–320 characters.';
  else if (!s.sms_body.includes('{{link}}')) e.sms_body = 'The text must include {{link}} so customers can open the summary.';
  else if (unknownTemplateVariables(s.sms_body).length) e.sms_body = `Unknown variable: ${unknownTemplateVariables(s.sms_body)[0]}`;
  if (!s.email_subject.trim() || s.email_subject.length > 150) e.email_subject = 'Subject must be 1–150 characters.';
  else if (unknownTemplateVariables(s.email_subject).length) e.email_subject = `Unknown variable: ${unknownTemplateVariables(s.email_subject)[0]}`;
  if (!Number.isInteger(s.review_window_minutes) || s.review_window_minutes < 0 || s.review_window_minutes > 2880) e.review_window_minutes = 'Use 0–2,880 minutes.';
  if (s.labor_warranty_days !== null && (!Number.isInteger(s.labor_warranty_days) || s.labor_warranty_days < 1 || s.labor_warranty_days > 3650)) e.labor_warranty_days = 'Use 1–3,650 days, or leave empty.';
  if (s.custom_tips.length > 6 || s.custom_tips.some((t) => t.length > 300)) e.custom_tips = 'Up to 6 tips, 300 characters each.';
  return e;
}

export function describeSummaryError(e: unknown): string {
  const err = e as { code?: string; message?: string } | null;
  if (err?.code === '42501') return 'You do not have permission to do that.';
  if (err?.code === '22023' || /JOB_SUMMARY_INVALID_PHOTO/.test(err?.message ?? '')) return 'One of the photos does not belong to this job.';
  return err?.message || 'Something went wrong. Please try again.';
}
