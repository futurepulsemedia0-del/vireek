import { supabase } from '@/lib/supabase';
import {
  extractLinks,
  firstNameOf,
  renderEmail,
  singleLine,
} from '../../supabase/functions/_shared/email-campaigns/render';
import { isValidEmail, type ExclusionReason } from '../../supabase/functions/_shared/email-campaigns/audience';

// The preview in the dashboard uses the SAME renderer the edge function sends
// with, so what you preview is exactly what recipients receive.
export { extractLinks, firstNameOf, renderEmail, singleLine, isValidEmail };
export type { ExclusionReason };

export type CampaignStatus = 'draft' | 'scheduled' | 'sending' | 'sent' | 'paused' | 'cancelled' | 'failed';
export type AudienceKind = 'all_opted_in' | 'segment';

export interface EmailCampaign {
  id: string;
  user_id: string;
  name: string;
  subject: string;
  preheader: string | null;
  body: string;
  from_name: string | null;
  reply_to: string | null;
  sender_address: string | null;
  audience: AudienceKind;
  segment_id: string | null;
  status: CampaignStatus;
  scheduled_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  recipient_count: number;
  sent_count: number;
  failed_count: number;
  delivered_count: number;
  bounce_count: number;
  unique_opens: number;
  unique_clicks: number;
  unsubscribe_count: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface EmailTemplate {
  id: string;
  user_id: string;
  name: string;
  subject: string;
  preheader: string | null;
  body: string;
  created_at: string;
  updated_at: string;
}

export interface EmailCampaignLink {
  id: string;
  url: string;
  click_count: number;
}

export interface EmailSuppression {
  id: string;
  email: string;
  reason: 'unsubscribe' | 'bounce' | 'complaint';
  created_at: string;
}

export interface AudiencePreview {
  total: number;
  eligible: number;
  excluded: Record<ExclusionReason, number>;
}

export const STATUS_META: Record<CampaignStatus, { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  scheduled: { label: 'Scheduled', tone: 'info' },
  sending: { label: 'Sending', tone: 'info' },
  sent: { label: 'Sent', tone: 'success' },
  paused: { label: 'Paused', tone: 'warning' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'danger' },
};

export const EXCLUSION_LABELS: Record<ExclusionReason, string> = {
  no_email: 'No email address',
  invalid_email: 'Invalid email address',
  suppressed: 'Unsubscribed, bounced or complained',
  not_opted_in: 'Customer has not opted in to marketing',
  lead_no_consent: 'Leads (no marketing consent on record)',
  duplicate: 'Duplicate address',
};

export const PLACEHOLDERS = ['{{first_name}}', '{{name}}', '{{company_name}}'] as const;

export const SUBJECT_MAX = 150;
export const SCHEDULE_MIN_LEAD_MS = 60_000;
export const SCHEDULE_MAX_LEAD_MS = 365 * 86_400_000;

type DraftFields = Pick<EmailCampaign, 'name' | 'subject' | 'body' | 'sender_address' | 'reply_to' | 'audience' | 'segment_id'>;

/** Every problem that would stop this campaign from being sent (mirrors the server check). */
export function validateDraft(c: DraftFields): string[] {
  const errors: string[] = [];
  if (!c.name.trim()) errors.push('Give the campaign a name.');
  const subject = singleLine(c.subject);
  if (!subject) errors.push('Add a subject line.');
  else if (subject.length > SUBJECT_MAX) errors.push(`Keep the subject under ${SUBJECT_MAX} characters.`);
  if (!c.body.trim()) errors.push('Write the email body.');
  if ((c.sender_address ?? '').trim().length < 8) errors.push('Add your business postal address — it is printed in every email footer.');
  if (c.reply_to?.trim() && !isValidEmail(c.reply_to.trim().toLowerCase())) errors.push('The reply-to address is not a valid email.');
  if (c.audience === 'segment' && !c.segment_id) errors.push('Choose an audience.');
  return errors;
}

export function validateSchedule(iso: string, now: number = Date.now()): string | null {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 'Pick a valid date and time.';
  const lead = t - now;
  if (lead < SCHEDULE_MIN_LEAD_MS) return 'Pick a time at least a minute from now.';
  if (lead > SCHEDULE_MAX_LEAD_MS) return 'Pick a time within the next year.';
  return null;
}

const pct = (num: number, den: number) => (den > 0 ? num / den : 0);
export const openRate = (c: Pick<EmailCampaign, 'unique_opens' | 'sent_count'>) => pct(c.unique_opens, c.sent_count);
export const clickRate = (c: Pick<EmailCampaign, 'unique_clicks' | 'sent_count'>) => pct(c.unique_clicks, c.sent_count);
export const unsubscribeRate = (c: Pick<EmailCampaign, 'unsubscribe_count' | 'sent_count'>) => pct(c.unsubscribe_count, c.sent_count);
export const bounceRate = (c: Pick<EmailCampaign, 'bounce_count' | 'sent_count'>) => pct(c.bounce_count, c.sent_count);
export const progress = (c: Pick<EmailCampaign, 'sent_count' | 'failed_count' | 'recipient_count'>) =>
  Math.min(1, pct(c.sent_count + c.failed_count, c.recipient_count));

export function formatPct(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return '0%';
  return `${(ratio * 100).toFixed(ratio < 0.1 ? 1 : 0)}%`;
}

export function previewEmail(c: Pick<EmailCampaign, 'subject' | 'preheader' | 'body' | 'sender_address'>, companyName: string) {
  return renderEmail({
    subject: c.subject || '(no subject)',
    preheader: c.preheader,
    body: c.body || 'Your email will appear here.',
    vars: { name: 'Alex Customer', first_name: 'Alex', company_name: companyName },
    companyName,
    senderAddress: c.sender_address || '123 Main Street, Your City',
    unsubscribeUrl: '#',
  });
}

/** Local `datetime-local` value -> ISO string (the browser interprets it in the user's time zone). */
export function localInputToIso(value: string): string {
  return new Date(value).toISOString();
}

export function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ------------------------------------------------------------
// Edge function client
// ------------------------------------------------------------

export type CampaignAction = 'preview' | 'send' | 'unschedule' | 'pause' | 'resume' | 'cancel' | 'test';

/** Calls the `email-campaigns` function and surfaces its JSON error message. */
export async function callEmailCampaigns<T>(
  action: CampaignAction,
  campaignId: string,
  extra: Record<string, unknown> = {},
): Promise<T> {
  const { data, error } = await supabase.functions.invoke('email-campaigns', { body: { action, campaignId, ...extra } });
  if (error) {
    let message = error.message;
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === 'function') {
      const body = await ctx.json().catch(() => null);
      if (body?.detail || body?.error) message = String(body.detail ?? body.error);
    }
    throw new Error(message);
  }
  return data as T;
}
