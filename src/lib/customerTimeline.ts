/**
 * Customer activity timeline — pure domain logic (no Supabase, no React).
 *
 * Turns rows from calls / SMS / email / jobs / quotes / invoices / payments /
 * review requests / customer_notes into ONE chronological feed. All network
 * access lives in customerTimelineApi.ts; everything here is deterministic and
 * unit-tested (customerTimeline.test.ts).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TimelineKind = 'call' | 'sms' | 'email' | 'job' | 'quote' | 'invoice' | 'payment' | 'review' | 'note';

export const TIMELINE_KINDS: readonly TimelineKind[] = [
  'note',
  'call',
  'sms',
  'email',
  'job',
  'quote',
  'invoice',
  'payment',
  'review',
];

export const KIND_LABELS: Record<TimelineKind, string> = {
  note: 'Notes',
  call: 'Calls',
  sms: 'SMS',
  email: 'Email',
  job: 'Jobs',
  quote: 'Quotes',
  invoice: 'Invoices',
  payment: 'Payments',
  review: 'Reviews',
};

/** Kinds that expose money — hidden from team members without can_view_billing. */
export const BILLING_KINDS: readonly TimelineKind[] = ['invoice', 'payment'];

export type TimelineTone = 'neutral' | 'good' | 'warn' | 'bad';

export interface CustomerNoteAttachment {
  id: string;
  note_id: string;
  storage_path: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
}

export interface CustomerNote {
  id: string;
  user_id: string;
  customer_id: string;
  author_id: string | null;
  author_name: string | null;
  body: string;
  pinned: boolean;
  pinned_at: string | null;
  edited_at: string | null;
  created_at: string;
  updated_at: string;
  attachments: CustomerNoteAttachment[];
}

export interface TimelineEvent {
  /** Globally unique, stable: `${kind}:${sourceId}[:variant]`. */
  id: string;
  kind: TimelineKind;
  /** ISO timestamp the event belongs at. */
  at: string;
  title: string;
  detail: string | null;
  meta: string[];
  tone: TimelineTone;
  direction: 'inbound' | 'outbound' | null;
  amountCents: number | null;
  /** In-app route that opens the source record, when one exists. */
  href: string | null;
  note: CustomerNote | null;
}

// Raw, query-shaped rows (only the columns the API selects).
export interface RawCall {
  id: string;
  call_datetime: string;
  summary: string | null;
  status: string | null;
  sentiment: string | null;
  duration_seconds: number | null;
  is_emergency: boolean | null;
}
export interface RawSms {
  id: string;
  direction: 'inbound' | 'outbound';
  body: string;
  created_at: string;
}
export interface RawOutboundSms {
  id: string;
  body: string;
  status: string;
  sent_at: string | null;
  created_at: string;
}
export interface RawEmail {
  id: string;
  direction: 'inbound' | 'outbound';
  subject: string | null;
  body_text: string | null;
  created_at: string;
}
export interface RawJob {
  id: string;
  service_type: string | null;
  job_status: string;
  invoice_status: string | null;
  scheduled_datetime: string | null;
  created_at: string;
}
export interface RawLineItem {
  quantity?: unknown;
  unit_price_cents?: unknown;
}
export interface RawQuote {
  id: string;
  status: string;
  line_items: unknown;
  tax_percent: number | null;
  sent_at: string | null;
  responded_at: string | null;
  created_at: string;
}
export interface RawInvoice {
  id: string;
  job_id: string | null;
  invoice_number: string | null;
  status: string;
  line_items: unknown;
  tax_percent: number | null;
  payment_method: string | null;
  sent_at: string | null;
  viewed_at: string | null;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface RawPayment {
  id: string;
  job_id: string;
  method: string;
  status: string;
  amount_cents: number;
  card_brand: string | null;
  card_last4: string | null;
  check_number: string | null;
  note: string | null;
  received_at: string;
}
export interface RawReview {
  id: string;
  status: string;
  rating: number | null;
  sent_at: string;
  completed_at: string | null;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const toTime = (iso: string | null | undefined): number => {
  if (!iso) return NaN;
  return Date.parse(iso);
};

function ev(partial: Partial<TimelineEvent> & Pick<TimelineEvent, 'id' | 'kind' | 'at' | 'title'>): TimelineEvent {
  return {
    detail: null,
    meta: [],
    tone: 'neutral',
    direction: null,
    amountCents: null,
    href: null,
    note: null,
    ...partial,
  };
}

function humanize(value: string | null | undefined): string {
  if (!value) return '';
  const s = value.replace(/[_-]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Collapses whitespace and clamps to `max` characters (adds an ellipsis). */
export function snippet(text: string | null | undefined, max = 240): string | null {
  if (!text) return null;
  const s = text.replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

export function formatDuration(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null;
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m === 0) return `${rem}s`;
  return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Robust against malformed jsonb: bad rows contribute 0 instead of NaN. */
export function lineItemsTotalCents(items: unknown, taxPercent: number | null | undefined): number {
  const list = Array.isArray(items) ? (items as RawLineItem[]) : [];
  const subtotal = list.reduce((sum, li) => {
    const v = Number(li?.quantity) * Number(li?.unit_price_cents);
    return Number.isFinite(v) ? sum + v : sum;
  }, 0);
  const tax = Number(taxPercent);
  return subtotal + (Number.isFinite(tax) ? Math.round((subtotal * tax) / 100) : 0);
}

// ---------------------------------------------------------------------------
// Customer-link matching (phone / email variants)
//
// customers.phone is free-form while sms_conversations / calls store E.164 or
// provider formats, so we query every plausible variant of the same number.
// ---------------------------------------------------------------------------

export function phoneVariants(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 7) return [];
  const out = new Set<string>();
  const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (national.length === 10) {
    out.add(`+1${national}`);
    out.add(`1${national}`);
    out.add(national);
  } else {
    out.add(`+${digits}`);
    out.add(digits);
  }
  const trimmed = raw.trim();
  if (/^[\d+]+$/.test(trimmed)) out.add(trimmed); // already digit-only: keep as stored
  return [...out];
}

const EMAIL_RE = /^[^\s,()"'<>]+@[^\s,()"'<>]+\.[^\s,()"'<>]+$/;

export function emailVariants(raw: string | null | undefined): string[] {
  const e = raw?.trim();
  if (!e || !EMAIL_RE.test(e)) return [];
  return [...new Set([e, e.toLowerCase()])];
}

const q = (v: string) => `"${v.replace(/"/g, '')}"`;

/**
 * Builds a PostgREST `or=` expression that links a table to a customer.
 * Every interpolated value is either a UUID, digits/+, or a validated email,
 * so the expression cannot be broken or injected into.
 */
export function buildLinkFilter(opts: {
  customerIdColumn?: string;
  customerId?: string;
  phoneColumn?: string;
  phones?: string[];
  emailColumn?: string;
  emails?: string[];
  jobColumn?: string;
  jobIds?: string[];
}): string | null {
  const parts: string[] = [];
  const unlinkedGuard = opts.customerIdColumn ? `${opts.customerIdColumn}.is.null,` : '';
  if (opts.customerIdColumn && opts.customerId) {
    parts.push(`${opts.customerIdColumn}.eq.${opts.customerId}`);
  }
  if (opts.jobColumn && opts.jobIds && opts.jobIds.length > 0) {
    parts.push(`${opts.jobColumn}.in.(${opts.jobIds.join(',')})`);
  }
  if (opts.phoneColumn && opts.phones && opts.phones.length > 0) {
    const inList = `${opts.phoneColumn}.in.(${opts.phones.map(q).join(',')})`;
    parts.push(unlinkedGuard ? `and(${unlinkedGuard}${inList})` : inList);
  }
  if (opts.emailColumn && opts.emails && opts.emails.length > 0) {
    const inList = `${opts.emailColumn}.in.(${opts.emails.map(q).join(',')})`;
    parts.push(unlinkedGuard ? `and(${unlinkedGuard}${inList})` : inList);
  }
  return parts.length > 0 ? parts.join(',') : null;
}

export function uniqueById<T extends { id: string }>(rows: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Row -> event mappers
// ---------------------------------------------------------------------------

export function mapCall(r: RawCall): TimelineEvent {
  const emergency = r.is_emergency === true;
  const tone: TimelineTone = emergency ? 'bad' : r.sentiment === 'negative' ? 'warn' : r.sentiment === 'positive' ? 'good' : 'neutral';
  const meta = [formatDuration(r.duration_seconds), r.sentiment ? `${humanize(r.sentiment)} sentiment` : null, humanize(r.status)].filter(
    (m): m is string => !!m,
  );
  return ev({
    id: `call:${r.id}`,
    kind: 'call',
    at: r.call_datetime,
    title: emergency ? 'Emergency call' : 'Phone call',
    detail: snippet(r.summary),
    meta,
    tone,
    href: '/dashboard/calls',
  });
}

export function mapSms(r: RawSms): TimelineEvent {
  return ev({
    id: `sms:${r.id}`,
    kind: 'sms',
    at: r.created_at,
    title: r.direction === 'inbound' ? 'SMS received' : 'SMS sent',
    detail: snippet(r.body, 400),
    direction: r.direction,
    href: '/dashboard/inbox',
  });
}

export function mapOutboundSms(r: RawOutboundSms): TimelineEvent {
  const tone: TimelineTone = r.status === 'failed' ? 'bad' : r.status === 'opted_out' ? 'warn' : 'neutral';
  return ev({
    id: `sms:auto:${r.id}`,
    kind: 'sms',
    at: r.sent_at ?? r.created_at,
    title: 'Automated SMS',
    detail: snippet(r.body, 400),
    meta: [humanize(r.status)],
    tone,
    direction: 'outbound',
    href: '/dashboard/inbox',
  });
}

export function mapEmail(r: RawEmail): TimelineEvent {
  const subject = r.subject?.trim();
  const base = r.direction === 'inbound' ? 'Email received' : 'Email sent';
  return ev({
    id: `email:${r.id}`,
    kind: 'email',
    at: r.created_at,
    title: subject ? `${base}: ${subject}` : base,
    detail: snippet(r.body_text),
    direction: r.direction,
    href: '/dashboard/inbox',
  });
}

export function mapJob(r: RawJob): TimelineEvent {
  const status = (r.job_status ?? '').toLowerCase();
  const tone: TimelineTone = status.includes('complete')
    ? 'good'
    : status.includes('cancel')
      ? 'bad'
      : status.includes('no_show') || status.includes('missed')
        ? 'warn'
        : 'neutral';
  const invoice = r.invoice_status && r.invoice_status !== 'not_sent' ? `Invoice ${humanize(r.invoice_status).toLowerCase()}` : null;
  return ev({
    id: `job:${r.id}`,
    kind: 'job',
    at: r.scheduled_datetime ?? r.created_at,
    title: r.service_type?.trim() || 'Service call',
    meta: [humanize(r.job_status), invoice].filter((m): m is string => !!m),
    tone,
    href: `/dashboard/jobs/${r.id}`,
  });
}

export function mapQuote(r: RawQuote): TimelineEvent[] {
  const total = lineItemsTotalCents(r.line_items, r.tax_percent);
  const amountCents = total > 0 ? total : null;
  const href = `/dashboard/quotes/${r.id}`;
  const out: TimelineEvent[] = [
    ev({
      id: `quote:${r.id}`,
      kind: 'quote',
      at: r.status === 'draft' ? r.created_at : (r.sent_at ?? r.created_at),
      title: r.status === 'draft' ? 'Quote drafted' : 'Quote sent',
      meta: r.status === 'expired' ? ['Expired'] : [],
      tone: r.status === 'expired' ? 'warn' : 'neutral',
      amountCents,
      href,
    }),
  ];
  if ((r.status === 'accepted' || r.status === 'declined') && r.responded_at) {
    out.push(
      ev({
        id: `quote:${r.id}:response`,
        kind: 'quote',
        at: r.responded_at,
        title: r.status === 'accepted' ? 'Quote accepted' : 'Quote declined',
        tone: r.status === 'accepted' ? 'good' : 'bad',
        amountCents,
        href,
      }),
    );
  }
  return out;
}

export function mapInvoice(r: RawInvoice): TimelineEvent[] {
  const number = r.invoice_number ? ` ${r.invoice_number}` : '';
  const amountCents = lineItemsTotalCents(r.line_items, r.tax_percent) || null;
  const href = r.job_id ? `/dashboard/jobs/${r.job_id}` : null;
  const out: TimelineEvent[] = [
    ev({
      id: `invoice:${r.id}`,
      kind: 'invoice',
      at: r.status === 'draft' ? r.created_at : (r.sent_at ?? r.created_at),
      title: r.status === 'draft' ? `Invoice${number} drafted` : `Invoice${number} sent`,
      amountCents,
      href,
    }),
  ];
  if (r.viewed_at) {
    out.push(ev({ id: `invoice:${r.id}:viewed`, kind: 'invoice', at: r.viewed_at, title: `Invoice${number} viewed`, href }));
  }
  if (r.paid_at) {
    out.push(
      ev({
        id: `invoice:${r.id}:paid`,
        kind: 'invoice',
        at: r.paid_at,
        title: `Invoice${number} paid`,
        meta: r.payment_method ? [humanize(r.payment_method)] : [],
        tone: 'good',
        amountCents,
        href,
      }),
    );
  }
  if (r.status === 'void') {
    out.push(ev({ id: `invoice:${r.id}:void`, kind: 'invoice', at: r.updated_at, title: `Invoice${number} voided`, tone: 'warn', href }));
  }
  return out;
}

const PAYMENT_METHOD_LABELS: Record<string, string> = { card_present: 'Card', cash: 'Cash', check: 'Check' };

export function mapPayment(r: RawPayment): TimelineEvent {
  const method = PAYMENT_METHOD_LABELS[r.method] ?? humanize(r.method);
  const tone: TimelineTone = r.status === 'succeeded' ? 'good' : r.status === 'failed' ? 'bad' : r.status === 'voided' ? 'warn' : 'neutral';
  const meta: string[] = [];
  if (r.card_brand || r.card_last4) meta.push([humanize(r.card_brand), r.card_last4 ? `•••• ${r.card_last4}` : ''].filter(Boolean).join(' '));
  if (r.check_number) meta.push(`Check #${r.check_number}`);
  return ev({
    id: `payment:${r.id}`,
    kind: 'payment',
    at: r.received_at,
    title: `${method} payment ${r.status === 'succeeded' ? 'received' : r.status}`,
    detail: snippet(r.note, 200),
    meta,
    tone,
    amountCents: r.amount_cents,
    href: `/dashboard/jobs/${r.job_id}`,
  });
}

export function mapReview(r: RawReview): TimelineEvent[] {
  const out: TimelineEvent[] = [ev({ id: `review:${r.id}:sent`, kind: 'review', at: r.sent_at, title: 'Review requested' })];
  if (r.status === 'completed' && r.completed_at) {
    const rating = r.rating ?? 0;
    out.push(
      ev({
        id: `review:${r.id}:done`,
        kind: 'review',
        at: r.completed_at,
        title: rating > 0 ? `Review received — ${'★'.repeat(rating)}${'☆'.repeat(5 - rating)}` : 'Review received',
        meta: rating > 0 ? [`${rating} / 5`] : [],
        tone: rating >= 4 ? 'good' : rating === 3 ? 'warn' : rating > 0 ? 'bad' : 'neutral',
      }),
    );
  } else if (r.status === 'declined') {
    out.push(ev({ id: `review:${r.id}:declined`, kind: 'review', at: r.completed_at ?? r.sent_at, title: 'Review declined', tone: 'warn' }));
  }
  return out;
}

export function mapNote(n: CustomerNote): TimelineEvent {
  return ev({
    id: `note:${n.id}`,
    kind: 'note',
    at: n.created_at,
    title: `Note by ${n.author_name?.trim() || 'a team member'}`,
    detail: n.body,
    meta: n.edited_at ? ['Edited'] : [],
    note: n,
  });
}

// ---------------------------------------------------------------------------
// Feed building: sort, filter, search, count, group
// ---------------------------------------------------------------------------

/** Newest first; invalid dates sink to the bottom; ties are stable by id. */
export function sortEvents(events: readonly TimelineEvent[]): TimelineEvent[] {
  return [...events].sort((a, b) => {
    const ta = toTime(a.at);
    const tb = toTime(b.at);
    const na = Number.isNaN(ta);
    const nb = Number.isNaN(tb);
    if (na && nb) return a.id.localeCompare(b.id);
    if (na) return 1;
    if (nb) return -1;
    if (tb !== ta) return tb - ta;
    return a.id.localeCompare(b.id);
  });
}

function haystack(e: TimelineEvent): string {
  const files = e.note?.attachments.map((a) => a.file_name).join(' ') ?? '';
  return [e.title, e.detail ?? '', e.meta.join(' '), e.note?.author_name ?? '', files].join(' ').toLowerCase();
}

export function matchesQuery(e: TimelineEvent, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const h = haystack(e);
  return terms.every((t) => h.includes(t));
}

export interface FeedOptions {
  /** Empty = all kinds. */
  kinds: readonly TimelineKind[];
  query: string;
  /** Pinned notes live in their own panel, so the feed omits them. */
  excludePinnedNotes?: boolean;
}

export function buildFeed(events: readonly TimelineEvent[], opts: FeedOptions): TimelineEvent[] {
  const kinds = new Set(opts.kinds);
  return sortEvents(
    events.filter((e) => {
      if (kinds.size > 0 && !kinds.has(e.kind)) return false;
      if (opts.excludePinnedNotes && e.note?.pinned) return false;
      return matchesQuery(e, opts.query);
    }),
  );
}

export function pinnedNotes(notes: readonly CustomerNote[], query = ''): CustomerNote[] {
  return notes
    .filter((n) => n.pinned && matchesQuery(mapNote(n), query))
    .sort((a, b) => (toTime(b.pinned_at) || 0) - (toTime(a.pinned_at) || 0) || a.id.localeCompare(b.id));
}

export function countByKind(events: readonly TimelineEvent[]): Record<TimelineKind, number> {
  const counts = Object.fromEntries(TIMELINE_KINDS.map((k) => [k, 0])) as Record<TimelineKind, number>;
  for (const e of events) counts[e.kind] += 1;
  return counts;
}

export interface DayGroup {
  key: string;
  label: string;
  events: TimelineEvent[];
}

const pad = (n: number) => String(n).padStart(2, '0');
const localDayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function dayLabel(date: Date, now: Date): string {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Expects events already sorted newest-first. Future events form an "Upcoming" group. */
export function groupByDay(events: readonly TimelineEvent[], now: Date = new Date()): DayGroup[] {
  const groups: DayGroup[] = [];
  const index = new Map<string, DayGroup>();
  const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  for (const e of events) {
    const t = toTime(e.at);
    let key: string;
    let label: string;
    if (Number.isNaN(t)) {
      key = 'unknown';
      label = 'Unknown date';
    } else if (t >= endOfToday) {
      key = 'upcoming';
      label = 'Upcoming';
    } else {
      const d = new Date(t);
      key = localDayKey(d);
      label = dayLabel(d, now);
    }
    let g = index.get(key);
    if (!g) {
      g = { key, label, events: [] };
      index.set(key, g);
      groups.push(g);
    }
    g.events.push(e);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Notes: validation, attachments, storage paths
// ---------------------------------------------------------------------------

export const MAX_NOTE_LENGTH = 8000;
export const MAX_PINNED_NOTES = 5;
export const MAX_ATTACHMENTS_PER_NOTE = 10;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export const ALLOWED_ATTACHMENT_TYPES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];

export function validateNoteBody(body: string, hasAttachments = false): string | null {
  const trimmed = body.trim();
  if (trimmed.length === 0 && !hasAttachments) return 'Write a note or attach a file.';
  if (trimmed.length === 0) return 'Add a short note to go with the files.';
  if (trimmed.length > MAX_NOTE_LENGTH) return `Notes are limited to ${MAX_NOTE_LENGTH.toLocaleString('en-US')} characters.`;
  return null;
}

export interface FileLike {
  name: string;
  size: number;
  type: string;
}

export interface AttachmentCheck<T extends FileLike> {
  accepted: T[];
  errors: string[];
}

/** Splits a candidate file list into accepted files and human-readable errors. */
export function checkAttachments<T extends FileLike>(existing: readonly FileLike[], incoming: readonly T[]): AttachmentCheck<T> {
  const accepted: T[] = [];
  const errors: string[] = [];
  for (const f of incoming) {
    if (existing.length + accepted.length >= MAX_ATTACHMENTS_PER_NOTE) {
      errors.push(`Up to ${MAX_ATTACHMENTS_PER_NOTE} files per note.`);
      break;
    }
    if (!ALLOWED_ATTACHMENT_TYPES.includes(f.type)) {
      errors.push(`${f.name}: this file type isn't supported.`);
    } else if (f.size <= 0) {
      errors.push(`${f.name}: the file is empty.`);
    } else if (f.size > MAX_ATTACHMENT_BYTES) {
      errors.push(`${f.name}: larger than ${formatBytes(MAX_ATTACHMENT_BYTES)}.`);
    } else if (existing.some((x) => x.name === f.name && x.size === f.size) || accepted.some((x) => x.name === f.name && x.size === f.size)) {
      errors.push(`${f.name}: already added.`);
    } else {
      accepted.push(f);
    }
  }
  return { accepted, errors };
}

export function safeFileName(name: string): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[^\w.\- ]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+/, '');
  const base = cleaned.length > 0 ? cleaned : 'file';
  return base.length > 120 ? base.slice(base.length - 120) : base;
}

/** `<accountOwnerId>/<customerId>/<noteId>/<uuid>-<name>` — the first folder is what storage RLS checks. */
export function buildStoragePath(p: { ownerId: string; customerId: string; noteId: string; fileId: string; fileName: string }): string {
  return `${p.ownerId}/${p.customerId}/${p.noteId}/${p.fileId}-${safeFileName(p.fileName)}`;
}

export function isImageType(mime: string): boolean {
  return mime.startsWith('image/') && mime !== 'image/heic';
}

/** Maps Postgres / PostgREST failures from the notes table to a friendly message. */
export function noteErrorMessage(error: { message?: string; code?: string } | null | undefined): string {
  const msg = error?.message ?? '';
  if (msg.includes('too_many_pinned_notes')) return `You can pin up to ${MAX_PINNED_NOTES} notes per customer. Unpin one first.`;
  if (error?.code === '42501' || /row-level security/i.test(msg)) return "You don't have permission to do that.";
  if (error?.code === '42P01' || (/customer_notes/.test(msg) && /does not exist|schema cache/i.test(msg))) {
    return 'Notes are not set up yet — run the latest database migration.';
  }
  return 'Something went wrong. Please try again.';
}
