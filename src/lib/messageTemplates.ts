/**
 * Message Templates — pure logic for /dashboard/templates.
 *
 * Everything here is framework-free and side-effect-free so it can be unit-tested and reused by any
 * future sender (workflows, dispatch, follow-ups). Persistence, RLS and the approval state machine
 * live in supabase/migrations/20270501000000_message_templates.sql; data access in
 * lib/messageTemplatesApi.ts.
 *
 * Variable syntax:  {{first_name}}   or with a fallback   {{first_name|there}}
 * Rendering is single-pass: a value that itself contains "{{x}}" is never expanded again.
 */

// ---------------------------------------------------------------------------
// Types & labels
// ---------------------------------------------------------------------------

export type TemplateChannel = 'sms' | 'email';
export type TemplateCategory =
  | 'appointment'
  | 'service_update'
  | 'payment'
  | 'review_request'
  | 'follow_up'
  | 'marketing';
export type TemplateStatus = 'draft' | 'pending_review' | 'approved' | 'rejected' | 'archived';
export type ReviewAction = 'submit' | 'approve' | 'reject' | 'archive' | 'restore';

export const CHANNELS: readonly TemplateChannel[] = ['sms', 'email'];
export const CATEGORIES: readonly TemplateCategory[] = [
  'appointment',
  'service_update',
  'payment',
  'review_request',
  'follow_up',
  'marketing',
];
export const STATUSES: readonly TemplateStatus[] = ['draft', 'pending_review', 'approved', 'rejected', 'archived'];

export const CHANNEL_LABELS: Record<TemplateChannel, string> = { sms: 'SMS', email: 'Email' };

export const CATEGORY_LABELS: Record<TemplateCategory, string> = {
  appointment: 'Appointments',
  service_update: 'Service updates',
  payment: 'Payments',
  review_request: 'Review requests',
  follow_up: 'Follow-ups',
  marketing: 'Marketing',
};

export const STATUS_LABELS: Record<TemplateStatus, string> = {
  draft: 'Draft',
  pending_review: 'Pending review',
  approved: 'Approved',
  rejected: 'Rejected',
  archived: 'Archived',
};

export const STATUS_STYLES: Record<TemplateStatus, string> = {
  draft: 'bg-bg-tertiary text-text-secondary',
  pending_review: 'bg-warning-500/15 text-warning-500',
  approved: 'bg-success/15 text-success',
  rejected: 'bg-danger/15 text-danger',
  archived: 'bg-bg-tertiary text-text-secondary/70',
};

export const ACTION_LABELS: Record<ReviewAction, string> = {
  submit: 'Submit for review',
  approve: 'Approve',
  reject: 'Reject',
  archive: 'Archive',
  restore: 'Restore as draft',
};

export const NAME_LIMIT = 120;
export const SMS_HARD_LIMIT = 1600;
export const EMAIL_BODY_LIMIT = 10000;
export const EMAIL_SUBJECT_LIMIT = 200;

export interface MessageTemplate {
  id: string;
  user_id: string;
  name: string;
  channel: TemplateChannel;
  category: TemplateCategory;
  subject: string | null;
  body: string;
  status: TemplateStatus;
  review_note: string | null;
  created_by: string;
  submitted_at: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TemplateDraft {
  name: string;
  channel: TemplateChannel;
  category: TemplateCategory;
  subject: string;
  body: string;
}

export interface TemplateStats {
  template_id: string;
  total_uses: number;
  uses_30d: number;
  last_used_at: string | null;
}

export const EMPTY_DRAFT: TemplateDraft = { name: '', channel: 'sms', category: 'appointment', subject: '', body: '' };

export function toDraft(t: MessageTemplate): TemplateDraft {
  return { name: t.name, channel: t.channel, category: t.category, subject: t.subject ?? '', body: t.body };
}

export function draftsEqual(a: TemplateDraft, b: TemplateDraft): boolean {
  return (
    a.name.trim() === b.name.trim() &&
    a.channel === b.channel &&
    a.category === b.category &&
    (a.channel === 'email' ? a.subject.trim() === b.subject.trim() : true) &&
    a.body === b.body
  );
}

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

export type VariableGroup = 'customer' | 'business' | 'job' | 'links';

export interface TemplateVariable {
  key: string;
  label: string;
  sample: string;
  group: VariableGroup;
  /** When set, the variable reads badly if empty, so a fallback is recommended (and inserted by default). */
  defaultFallback?: string;
}

export const VARIABLE_GROUP_LABELS: Record<VariableGroup, string> = {
  customer: 'Customer',
  business: 'Business',
  job: 'Job',
  links: 'Links',
};

export const TEMPLATE_VARIABLES: readonly TemplateVariable[] = [
  { key: 'first_name', label: 'First name', sample: 'Jordan', group: 'customer', defaultFallback: 'there' },
  { key: 'last_name', label: 'Last name', sample: 'Rivera', group: 'customer' },
  { key: 'business_name', label: 'Business name', sample: 'Summit Home Services', group: 'business' },
  { key: 'business_phone', label: 'Business phone', sample: '(555) 010-2030', group: 'business' },
  { key: 'business_address', label: 'Business address', sample: '120 Main St, Austin, TX 78701', group: 'business' },
  { key: 'technician_name', label: 'Technician', sample: 'Alex', group: 'job', defaultFallback: 'your technician' },
  { key: 'service_type', label: 'Service type', sample: 'AC tune-up', group: 'job', defaultFallback: 'service' },
  { key: 'appointment_date', label: 'Appointment date', sample: 'Tue, Jun 9', group: 'job' },
  { key: 'appointment_time', label: 'Appointment time', sample: '2:00 PM', group: 'job' },
  { key: 'arrival_window', label: 'Arrival window', sample: 'between 2:00 and 4:00 PM', group: 'job', defaultFallback: 'soon' },
  { key: 'job_address', label: 'Job address', sample: '48 Oak Ave', group: 'job' },
  { key: 'invoice_amount', label: 'Invoice amount', sample: '$189.00', group: 'job' },
  { key: 'payment_link', label: 'Payment link', sample: 'https://pay.example.com/i/1042', group: 'links' },
  { key: 'review_link', label: 'Review link', sample: 'https://example.com/review', group: 'links' },
  { key: 'booking_link', label: 'Booking link', sample: 'https://example.com/book', group: 'links' },
  { key: 'unsubscribe_link', label: 'Unsubscribe link', sample: 'https://example.com/unsubscribe', group: 'links' },
];

export const VARIABLE_KEYS: ReadonlySet<string> = new Set(TEMPLATE_VARIABLES.map((v) => v.key));
const LINK_KEYS: ReadonlySet<string> = new Set(
  TEMPLATE_VARIABLES.filter((v) => v.group === 'links').map((v) => v.key),
);
const FALLBACK_KEYS: ReadonlySet<string> = new Set(
  TEMPLATE_VARIABLES.filter((v) => v.defaultFallback !== undefined).map((v) => v.key),
);

export const SAMPLE_VALUES: Readonly<Record<string, string>> = Object.fromEntries(
  TEMPLATE_VARIABLES.map((v) => [v.key, v.sample]),
);

/** Text inserted when the user clicks a variable chip. */
export function variableSnippet(v: TemplateVariable): string {
  return v.defaultFallback ? `{{${v.key}|${v.defaultFallback}}}` : `{{${v.key}}}`;
}

// ---------------------------------------------------------------------------
// Parsing & rendering
// ---------------------------------------------------------------------------

const TOKEN_SOURCE = '\\{\\{\\s*([A-Za-z][A-Za-z0-9_]*)\\s*(?:\\|([^{}|]{0,60}))?\\}\\}';

export interface TemplateToken {
  raw: string;
  key: string;
  fallback: string | null;
  start: number;
  end: number;
}

export function tokenize(text: string): TemplateToken[] {
  const out: TemplateToken[] = [];
  for (const m of text.matchAll(new RegExp(TOKEN_SOURCE, 'g'))) {
    const start = m.index ?? 0;
    out.push({
      raw: m[0],
      key: m[1].toLowerCase(),
      fallback: m[2] === undefined ? null : m[2].trim(),
      start,
      end: start + m[0].length,
    });
  }
  return out;
}

export function extractVariableKeys(text: string): string[] {
  return [...new Set(tokenize(text).map((t) => t.key))];
}

export interface RenderResult {
  text: string;
  /** Keys that had neither a value nor a fallback (rendered as empty text). */
  missing: string[];
}

export function renderTemplate(text: string, values: Readonly<Record<string, string | null | undefined>>): RenderResult {
  const missing = new Set<string>();
  const out = text.replace(new RegExp(TOKEN_SOURCE, 'g'), (_m: string, rawKey: string, fb: string | undefined) => {
    const key = rawKey.toLowerCase();
    const value = values[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
    if (fb !== undefined && fb.trim() !== '') return fb.trim();
    missing.add(key);
    return '';
  });
  return { text: out, missing: [...missing] };
}

export type PreviewSegment =
  | { kind: 'text'; text: string }
  | { kind: 'variable'; key: string; text: string; state: 'value' | 'fallback' | 'unknown' | 'missing' };

export function buildPreviewSegments(
  text: string,
  values: Readonly<Record<string, string | null | undefined>> = SAMPLE_VALUES,
): PreviewSegment[] {
  const segments: PreviewSegment[] = [];
  let cursor = 0;
  for (const t of tokenize(text)) {
    if (t.start > cursor) segments.push({ kind: 'text', text: text.slice(cursor, t.start) });
    const value = values[t.key];
    if (!VARIABLE_KEYS.has(t.key)) segments.push({ kind: 'variable', key: t.key, text: t.raw, state: 'unknown' });
    else if (typeof value === 'string' && value.trim() !== '')
      segments.push({ kind: 'variable', key: t.key, text: value, state: 'value' });
    else if (t.fallback) segments.push({ kind: 'variable', key: t.key, text: t.fallback, state: 'fallback' });
    else segments.push({ kind: 'variable', key: t.key, text: `[${t.key}]`, state: 'missing' });
    cursor = t.end;
  }
  if (cursor < text.length) segments.push({ kind: 'text', text: text.slice(cursor) });
  return segments;
}

// ---------------------------------------------------------------------------
// SMS segment analysis (GSM-7 vs UCS-2)
// ---------------------------------------------------------------------------

const GSM_BASIC: ReadonlySet<string> = new Set(
  Array.from(
    '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
  ),
);
const GSM_EXTENDED: ReadonlySet<string> = new Set(Array.from('^{}\\[~]|€\f'));

export interface SmsAnalysis {
  characters: number;
  units: number;
  encoding: 'GSM-7' | 'UCS-2';
  segments: number;
  perSegment: number;
  nonGsmChars: string[];
}

export function analyzeSms(text: string): SmsAnalysis {
  const chars = Array.from(text);
  const nonGsm = new Set<string>();
  let gsmUnits = 0;
  for (const ch of chars) {
    if (GSM_BASIC.has(ch)) gsmUnits += 1;
    else if (GSM_EXTENDED.has(ch)) gsmUnits += 2;
    else nonGsm.add(ch);
  }
  const encoding = nonGsm.size === 0 ? 'GSM-7' : 'UCS-2';
  const units = encoding === 'GSM-7' ? gsmUnits : text.length;
  const single = encoding === 'GSM-7' ? 160 : 70;
  const multi = encoding === 'GSM-7' ? 153 : 67;
  const segments = units === 0 ? 0 : units <= single ? 1 : Math.ceil(units / multi);
  return {
    characters: chars.length,
    units,
    encoding,
    segments,
    perSegment: segments > 1 ? multi : single,
    nonGsmChars: [...nonGsm].slice(0, 8),
  };
}

// ---------------------------------------------------------------------------
// Compliance lint (A2P 10DLC / CTIA / CAN-SPAM friendly)
// ---------------------------------------------------------------------------

export type LintSeverity = 'error' | 'warning' | 'info';

export interface LintIssue {
  code: string;
  severity: LintSeverity;
  message: string;
}

const URL_SHORTENERS =
  /\b(?:bit\.ly|tinyurl\.com|goo\.gl|t\.co|ow\.ly|is\.gd|buff\.ly|rebrand\.ly|cutt\.ly|tiny\.cc|shorturl\.at)\b/i;
const SPAM_PHRASES =
  /\b(?:act now|click here|you(?:'ve| have) won|winner|free money|guaranteed|congratulations|urgent|final notice|risk[- ]free|cash bonus)\b/i;
const RESTRICTED_TERMS =
  /\b(?:cannabis|marijuana|cbd|vape|vaping|tobacco|firearms?|ammo|casino|gambling|sweepstakes|payday loans?|bitcoin|crypto(?:currency)?|escort)\b/i;
const STOP_WORD = /\bstop\b/i;
const SEVERITY_ORDER: Record<LintSeverity, number> = { error: 0, warning: 1, info: 2 };

function upperRatio(text: string): { letters: number; ratio: number } {
  const letters = text.replace(/[^A-Za-z]/g, '');
  if (letters.length === 0) return { letters: 0, ratio: 0 };
  const upper = letters.replace(/[^A-Z]/g, '').length;
  return { letters: letters.length, ratio: upper / letters.length };
}

export function lintTemplate(draft: TemplateDraft): LintIssue[] {
  const issues: LintIssue[] = [];
  const add = (code: string, severity: LintSeverity, message: string) => issues.push({ code, severity, message });

  const isSms = draft.channel === 'sms';
  const isMarketing = draft.category === 'marketing';
  const subject = isSms ? '' : draft.subject;
  const combined = `${subject}\n${draft.body}`;
  const bodyKeys = extractVariableKeys(draft.body);
  const allKeys = extractVariableKeys(combined);

  if (draft.name.trim() === '') add('EMPTY_NAME', 'error', 'Give the template a name.');
  else if (Array.from(draft.name.trim()).length > NAME_LIMIT) add('NAME_TOO_LONG', 'error', `Name must be ${NAME_LIMIT} characters or fewer.`);
  if (draft.body.trim() === '') add('EMPTY_BODY', 'error', 'The message body is empty.');

  // Variables
  const unknown = allKeys.filter((k) => !VARIABLE_KEYS.has(k));
  if (unknown.length > 0)
    add('UNKNOWN_VARIABLE', 'error', `Unknown variable${unknown.length > 1 ? 's' : ''}: ${unknown.map((k) => `{{${k}}}`).join(', ')}.`);
  if (/\{\{|\}\}/.test(combined.replace(new RegExp(TOKEN_SOURCE, 'g'), '')))
    add('BROKEN_VARIABLE', 'error', 'A variable is malformed. Use {{first_name}} or {{first_name|there}}.');
  const noFallback = tokenize(combined).filter((t) => FALLBACK_KEYS.has(t.key) && !t.fallback);
  if (noFallback.length > 0)
    add(
      'NO_FALLBACK',
      'warning',
      `${[...new Set(noFallback.map((t) => `{{${t.key}}}`))].join(', ')} has no fallback. If the value is missing the sentence will read badly. Try {{first_name|there}}.`,
    );

  if (isSms) {
    const rawLength = Array.from(draft.body).length;
    if (rawLength > SMS_HARD_LIMIT) add('TOO_LONG', 'error', `SMS body is over ${SMS_HARD_LIMIT} characters.`);

    const sample = renderTemplate(draft.body, SAMPLE_VALUES).text;
    const sms = analyzeSms(sample);
    if (sms.segments > 3)
      add('LONG_SMS', 'warning', `About ${sms.segments} segments. Long texts cost more and are filtered more often. Aim for 3 or fewer.`);
    if (sms.encoding === 'UCS-2')
      add(
        'UCS2_ENCODING',
        'warning',
        `Special characters (${sms.nonGsmChars.join(' ')}) switch the text to UCS-2, cutting each segment to 70 characters. Use plain quotes and dashes.`,
      );

    if (!bodyKeys.includes('business_name'))
      add(
        'NO_SENDER_ID',
        isMarketing ? 'error' : 'warning',
        'Identify your business. Start with {{business_name}} so recipients know who is texting.',
      );
    if (!STOP_WORD.test(draft.body)) {
      if (isMarketing) add('NO_OPT_OUT', 'error', 'Marketing texts must include opt-out language, e.g. "Reply STOP to opt out."');
      else add('NO_OPT_OUT_HINT', 'info', 'Best practice: add "Reply STOP to opt out." to the first message a customer receives.');
    }
    if (URL_SHORTENERS.test(draft.body))
      add('URL_SHORTENER', 'error', 'Public URL shorteners (bit.ly, tinyurl, etc.) are blocked by carriers. Use a {{..._link}} variable or your own domain.');
    const urlCount = (draft.body.match(/https?:\/\/\S+/gi) ?? []).length + bodyKeys.filter((k) => LINK_KEYS.has(k)).length;
    if (urlCount > 1) add('MULTIPLE_LINKS', 'warning', 'More than one link raises the chance of carrier filtering. Keep it to one.');
    if ((draft.body.match(/!/g) ?? []).length > 2) add('EXCLAMATIONS', 'warning', 'Too many exclamation marks look like spam.');
    const caps = upperRatio(draft.body.replace(new RegExp(TOKEN_SOURCE, 'g'), ''));
    if (caps.letters >= 12 && caps.ratio > 0.7) add('ALL_CAPS', 'warning', 'Mostly capital letters read as shouting and trigger spam filters.');
    if (isMarketing)
      add(
        'CONSENT_REMINDER',
        'info',
        'Send marketing texts only to customers with written consent, and never outside 8 AM to 9 PM in their local time.',
      );
  } else {
    if (subject.trim() === '') add('EMPTY_SUBJECT', 'error', 'Add a subject line.');
    if (/[\r\n]/.test(subject)) add('SUBJECT_NEWLINE', 'error', 'The subject must be a single line.');
    if (Array.from(subject).length > EMAIL_SUBJECT_LIMIT) add('SUBJECT_TOO_LONG', 'error', `Subject must be ${EMAIL_SUBJECT_LIMIT} characters or fewer.`);
    else if (Array.from(renderTemplate(subject, SAMPLE_VALUES).text).length > 78)
      add('LONG_SUBJECT', 'warning', 'Subjects over about 78 characters get cut off in most inboxes.');
    const subjectCaps = upperRatio(subject.replace(new RegExp(TOKEN_SOURCE, 'g'), ''));
    if ((subject.match(/!/g) ?? []).length > 1 || (subjectCaps.letters >= 8 && subjectCaps.ratio > 0.7))
      add('SUBJECT_SHOUTING', 'warning', 'Avoid all-caps or repeated exclamation marks in the subject.');
    if (Array.from(draft.body).length > EMAIL_BODY_LIMIT) add('TOO_LONG', 'error', `Email body is over ${EMAIL_BODY_LIMIT} characters.`);
    if (isMarketing) {
      if (!allKeys.includes('unsubscribe_link')) add('NO_UNSUBSCRIBE', 'error', 'Marketing emails must include {{unsubscribe_link}} (CAN-SPAM).');
      if (!allKeys.includes('business_address')) add('NO_POSTAL_ADDRESS', 'error', 'Marketing emails must include your postal address via {{business_address}} (CAN-SPAM).');
    }
  }

  if (SPAM_PHRASES.test(combined)) add('SPAM_PHRASE', 'warning', 'Phrases like "act now" or "winner" are common spam signals. Consider softer wording.');
  if (RESTRICTED_TERMS.test(combined))
    add('RESTRICTED_TERM', 'warning', 'Carriers restrict some topics (cannabis, tobacco, firearms, gambling, crypto, high-risk loans). Messages mentioning them can be filtered.');

  return issues.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

export interface LintSummary {
  errors: number;
  warnings: number;
  infos: number;
  canSubmit: boolean;
}

export function summarizeLint(issues: readonly LintIssue[]): LintSummary {
  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.filter((i) => i.severity === 'warning').length;
  return { errors, warnings, infos: issues.length - errors - warnings, canSubmit: errors === 0 };
}

// ---------------------------------------------------------------------------
// Approval workflow (mirrors review_message_template() in the migration; the database is the authority)
// ---------------------------------------------------------------------------

export interface ActionContext {
  status: TemplateStatus;
  canReview: boolean;
  isOwner: boolean;
  isAuthor: boolean;
}

export function availableActions(ctx: ActionContext): ReviewAction[] {
  const actions: ReviewAction[] = [];
  switch (ctx.status) {
    case 'draft':
    case 'rejected':
      actions.push('submit', 'archive');
      break;
    case 'pending_review':
      if (ctx.canReview && (ctx.isOwner || !ctx.isAuthor)) actions.push('approve', 'reject');
      actions.push('archive');
      break;
    case 'approved':
      actions.push('archive');
      break;
    case 'archived':
      actions.push('restore');
      break;
  }
  return actions;
}

export function isEditable(status: TemplateStatus): boolean {
  return status !== 'archived';
}

/** Editing these statuses sends the template back to draft (enforced by a database trigger). */
export function editResetsApproval(status: TemplateStatus): boolean {
  return status === 'approved' || status === 'pending_review' || status === 'rejected';
}

// ---------------------------------------------------------------------------
// List helpers
// ---------------------------------------------------------------------------

export interface TemplateFilters {
  channel: TemplateChannel | 'all';
  status: TemplateStatus | 'all' | 'active';
  query: string;
}

export const DEFAULT_FILTERS: TemplateFilters = { channel: 'all', status: 'active', query: '' };

export function filterTemplates(list: readonly MessageTemplate[], f: TemplateFilters): MessageTemplate[] {
  const q = f.query.trim().toLowerCase();
  return list
    .filter((t) => {
      if (f.channel !== 'all' && t.channel !== f.channel) return false;
      if (f.status === 'active' ? t.status === 'archived' : f.status !== 'all' && t.status !== f.status) return false;
      if (!q) return true;
      return t.name.toLowerCase().includes(q) || t.body.toLowerCase().includes(q) || (t.subject ?? '').toLowerCase().includes(q);
    })
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export interface TemplateSummary {
  active: number;
  approved: number;
  pendingReview: number;
  uses30d: number;
}

export function summarizeTemplates(list: readonly MessageTemplate[], stats: Readonly<Record<string, TemplateStats>>): TemplateSummary {
  let uses30d = 0;
  for (const s of Object.values(stats)) uses30d += s.uses_30d;
  return {
    active: list.filter((t) => t.status !== 'archived').length,
    approved: list.filter((t) => t.status === 'approved').length,
    pendingReview: list.filter((t) => t.status === 'pending_review').length,
    uses30d,
  };
}

// ---------------------------------------------------------------------------
// Defensive normalisers — a malformed row can never crash the UI
// ---------------------------------------------------------------------------

function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : null;
}
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export function normalizeTemplate(raw: unknown): MessageTemplate | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const channel = oneOf(r.channel, CHANNELS);
  const category = oneOf(r.category, CATEGORIES);
  const status = oneOf(r.status, STATUSES);
  const id = str(r.id);
  const userId = str(r.user_id);
  if (!id || !userId || !channel || !category || !status) return null;
  return {
    id,
    user_id: userId,
    name: str(r.name) ?? '',
    channel,
    category,
    subject: str(r.subject),
    body: str(r.body) ?? '',
    status,
    review_note: str(r.review_note),
    created_by: str(r.created_by) ?? '',
    submitted_at: str(r.submitted_at),
    reviewed_by: str(r.reviewed_by),
    reviewed_at: str(r.reviewed_at),
    created_at: str(r.created_at) ?? '',
    updated_at: str(r.updated_at) ?? '',
  };
}

export function normalizeTemplates(rows: unknown): MessageTemplate[] {
  if (!Array.isArray(rows)) return [];
  return rows.map(normalizeTemplate).filter((t): t is MessageTemplate => t !== null);
}

export function normalizeStats(rows: unknown): Record<string, TemplateStats> {
  const out: Record<string, TemplateStats> = {};
  if (!Array.isArray(rows)) return out;
  const num = (v: unknown) => {
    const n = typeof v === 'string' ? Number(v) : v;
    return typeof n === 'number' && Number.isFinite(n) ? n : 0;
  };
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const id = str(r.template_id);
    if (!id) continue;
    out[id] = { template_id: id, total_uses: num(r.total_uses), uses_30d: num(r.uses_30d), last_used_at: str(r.last_used_at) };
  }
  return out;
}

// ---------------------------------------------------------------------------
// A2P-safe starter library (copied into the account as drafts; nothing is auto-approved)
// ---------------------------------------------------------------------------

export interface StarterTemplate extends TemplateDraft {
  id: string;
  summary: string;
}

const OPT_OUT = 'Reply STOP to opt out.';

export const STARTER_TEMPLATES: readonly StarterTemplate[] = [
  {
    id: 'sms-appointment-confirmation',
    name: 'Appointment confirmation',
    channel: 'sms',
    category: 'appointment',
    subject: '',
    summary: 'Sent right after booking, with a clear way to reschedule.',
    body: `{{business_name}}: Hi {{first_name|there}}, your {{service_type|service}} visit is confirmed for {{appointment_date}} at {{appointment_time}}. Need to change it? Call {{business_phone}}. ${OPT_OUT}`,
  },
  {
    id: 'sms-appointment-reminder',
    name: 'Day-before reminder',
    channel: 'sms',
    category: 'appointment',
    subject: '',
    summary: 'Cuts no-shows with a short reminder the day before.',
    body: `{{business_name}}: Reminder for {{first_name|there}}: {{technician_name|your technician}} is scheduled for {{appointment_date}}, {{arrival_window|soon}}. Call {{business_phone}} to reschedule. ${OPT_OUT}`,
  },
  {
    id: 'sms-on-the-way',
    name: 'Technician on the way',
    channel: 'sms',
    category: 'service_update',
    subject: '',
    summary: 'Live ETA update when the technician leaves for the job.',
    body: `{{business_name}}: {{technician_name|Your technician}} is on the way and should arrive {{arrival_window|soon}}. Questions? Call {{business_phone}}. ${OPT_OUT}`,
  },
  {
    id: 'sms-invoice-ready',
    name: 'Invoice ready to pay',
    channel: 'sms',
    category: 'payment',
    subject: '',
    summary: 'One payment link, amount and a callback number.',
    body: `{{business_name}}: Your invoice for {{invoice_amount}} is ready. Pay securely here: {{payment_link}} Questions? Call {{business_phone}}. ${OPT_OUT}`,
  },
  {
    id: 'sms-review-request',
    name: 'Review request',
    channel: 'sms',
    category: 'review_request',
    subject: '',
    summary: 'Polite, single-link ask after a completed job.',
    body: `{{business_name}}: Thanks for choosing us, {{first_name|there}}. If we earned it, would you share a quick review? {{review_link}} ${OPT_OUT}`,
  },
  {
    id: 'sms-follow-up',
    name: 'Post-service check-in',
    channel: 'sms',
    category: 'follow_up',
    subject: '',
    summary: 'Catches problems early and invites a reply.',
    body: `{{business_name}}: Hi {{first_name|there}}, just checking in after your {{service_type|service}} visit. Anything we can do better? Reply here or call {{business_phone}}. ${OPT_OUT}`,
  },
  {
    id: 'sms-seasonal-offer',
    name: 'Seasonal maintenance offer',
    channel: 'sms',
    category: 'marketing',
    subject: '',
    summary: 'Consent-based promo with sender ID and opt-out built in.',
    body: `{{business_name}}: Hi {{first_name|there}}, book a seasonal maintenance visit this month and get priority scheduling. Book here: {{booking_link}} ${OPT_OUT}`,
  },
  {
    id: 'email-appointment-confirmation',
    name: 'Appointment confirmation (email)',
    channel: 'email',
    category: 'appointment',
    subject: 'Your {{service_type|service}} appointment is confirmed',
    summary: 'Full details: when, where, who, and how to reschedule.',
    body: [
      'Hi {{first_name|there}},',
      '',
      'Your {{service_type|service}} appointment with {{business_name}} is confirmed.',
      '',
      'When: {{appointment_date}} at {{appointment_time}}',
      'Where: {{job_address}}',
      'Technician: {{technician_name|Your technician}}',
      '',
      'Need to reschedule? Call us at {{business_phone}} and we will find a time that works.',
      '',
      'Thank you,',
      '{{business_name}}',
    ].join('\n'),
  },
  {
    id: 'email-invoice',
    name: 'Invoice (email)',
    channel: 'email',
    category: 'payment',
    subject: 'Your invoice from {{business_name}}: {{invoice_amount}}',
    summary: 'Clear amount, secure pay link and a contact line.',
    body: [
      'Hi {{first_name|there}},',
      '',
      'Thank you for choosing {{business_name}}. Your invoice for {{invoice_amount}} is ready.',
      '',
      'Pay securely online: {{payment_link}}',
      '',
      'Questions about this invoice? Call {{business_phone}}.',
      '',
      '{{business_name}}',
    ].join('\n'),
  },
  {
    id: 'email-maintenance-offer',
    name: 'Maintenance offer (email)',
    channel: 'email',
    category: 'marketing',
    subject: 'Keep your home running smoothly this season',
    summary: 'CAN-SPAM ready: postal address and unsubscribe link included.',
    body: [
      'Hi {{first_name|there}},',
      '',
      'A seasonal maintenance visit catches small issues before they turn into expensive repairs.',
      '',
      'Book your visit: {{booking_link}}',
      '',
      '{{business_name}} | {{business_address}}',
      'You are receiving this because you are a customer of {{business_name}}.',
      'Unsubscribe: {{unsubscribe_link}}',
    ].join('\n'),
  },
];

export function starterToDraft(s: StarterTemplate): TemplateDraft {
  return { name: s.name, channel: s.channel, category: s.category, subject: s.subject, body: s.body };
}
