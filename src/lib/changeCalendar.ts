/**
 * Business change calendar — pure domain logic (no I/O, no React).
 *
 * Scope: Vireek's OWN pricing / terms / SLA / policy changes. Platform staff only (/staff/change-calendar).
 * Schema, RLS and RPCs: supabase/migrations/20290311000000_change_calendar.sql.
 *
 * This file does NOT decide what notice period is legally required: `min_notice_days` is optional, empty by default,
 * and any value is a [COUNSEL] decision made by a person. Nothing here claims a notice is sufficient.
 * Dates are `YYYY-MM-DD` and are interpreted in UTC, the same as the database.
 */

export const CATEGORIES = ['pricing', 'terms', 'sla', 'policy'] as const;
export type Category = (typeof CATEGORIES)[number];

export const AUDIENCES = ['all_customers', 'affected_plans', 'partners', 'internal'] as const;
export type Audience = (typeof AUDIENCES)[number];

export const STATUSES = ['draft', 'pending_approval', 'approved', 'rejected', 'cancelled', 'completed'] as const;
export type Status = (typeof STATUSES)[number];

export const REMINDER_KINDS = [
  'unapproved_past_notice',
  'approval_needed',
  'notice_overdue',
  'notice_1d',
  'notice_7d',
  'completion_due',
  'effective_7d',
] as const;
export type ReminderKind = (typeof REMINDER_KINDS)[number];

export const CLOSED_STATUSES: readonly Status[] = ['cancelled', 'completed'];
export const isClosed = (s: Status): boolean => CLOSED_STATUSES.includes(s);

export interface ChangeEntry {
  id: string;
  category: Category;
  title: string;
  summary: string | null;
  audience: Audience;
  owner_id: string;
  status: Status;
  notice_date: string;
  effective_date: string;
  min_notice_days: number | null;
  reference_url: string | null;
  price_change_notice_id: string | null;
  notice_sent_at: string | null;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface ChangeDraft {
  id?: string;
  category: Category;
  title: string;
  summary: string;
  audience: Audience;
  owner_id: string;
  notice_date: string;
  effective_date: string;
  min_notice_days: string;
  reference_url: string;
  price_change_notice_id: string;
}

// ---------------------------------------------------------------- dates (UTC, day precision)

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 'YYYY-MM-DD' -> days since epoch, or null when it is not a real calendar date. */
export function dayNumber(s: unknown): number | null {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const t = Date.UTC(y, m - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
  return Math.round(t / 86_400_000);
}

export const todayUtc = (now: Date = new Date()): string => now.toISOString().slice(0, 10);

/** Whole days from `from` to `to` (negative when `to` is earlier). null if either is not a real date. */
export function daysBetween(from: string, to: string): number | null {
  const a = dayNumber(from);
  const b = dayNumber(to);
  return a === null || b === null ? null : b - a;
}

// ---------------------------------------------------------------- validation (client-side mirror of the CHECKs)

export type DraftErrorCode =
  | 'title_length'
  | 'category'
  | 'audience'
  | 'owner_required'
  | 'summary_too_long'
  | 'notice_date_invalid'
  | 'effective_date_invalid'
  | 'effective_in_past'
  | 'dates_order'
  | 'min_notice_invalid'
  | 'min_notice_not_met'
  | 'url_invalid'
  | 'notice_link_invalid';

export type DraftErrors = Partial<Record<keyof ChangeDraft, DraftErrorCode>>;

export function validateDraft(d: ChangeDraft, opts: { today?: string; requireFuture?: boolean } = {}): DraftErrors {
  const e: DraftErrors = {};
  const title = d.title.trim();
  if (title.length < 3 || title.length > 140) e.title = 'title_length';
  if (!CATEGORIES.includes(d.category)) e.category = 'category';
  if (!AUDIENCES.includes(d.audience)) e.audience = 'audience';
  if (!UUID_RE.test(d.owner_id)) e.owner_id = 'owner_required';
  if (d.summary.length > 2000) e.summary = 'summary_too_long';

  const notice = dayNumber(d.notice_date);
  const effective = dayNumber(d.effective_date);
  if (notice === null) e.notice_date = 'notice_date_invalid';
  if (effective === null) e.effective_date = 'effective_date_invalid';
  if (notice !== null && effective !== null && effective < notice) e.effective_date = 'dates_order';
  if (opts.requireFuture && effective !== null && !e.effective_date) {
    const today = dayNumber(opts.today ?? todayUtc());
    if (today !== null && effective < today) e.effective_date = 'effective_in_past';
  }

  const minRaw = d.min_notice_days.trim();
  if (minRaw !== '') {
    const n = Number(minRaw);
    if (!/^\d{1,3}$/.test(minRaw) || !Number.isInteger(n) || n > 365) e.min_notice_days = 'min_notice_invalid';
    else if (notice !== null && effective !== null && effective - notice < n && !e.effective_date) e.min_notice_days = 'min_notice_not_met';
  }

  const url = d.reference_url.trim();
  if (url !== '' && !(/^https:\/\/\S+$/.test(url) && url.length <= 500)) e.reference_url = 'url_invalid';
  const link = d.price_change_notice_id.trim();
  if (link !== '' && !UUID_RE.test(link)) e.price_change_notice_id = 'notice_link_invalid';
  return e;
}

export const hasErrors = (e: DraftErrors): boolean => Object.keys(e).length > 0;

/** Payload for staff_change_calendar_upsert. Empty optional fields become null; text is trimmed. */
export function draftToPayload(d: ChangeDraft): Record<string, string | number | null> {
  const orNull = (s: string): string | null => (s.trim() === '' ? null : s.trim());
  return {
    ...(d.id ? { id: d.id } : {}),
    category: d.category,
    title: d.title.trim(),
    summary: orNull(d.summary),
    audience: d.audience,
    owner_id: d.owner_id.trim(),
    notice_date: d.notice_date,
    effective_date: d.effective_date,
    min_notice_days: d.min_notice_days.trim() === '' ? null : Number(d.min_notice_days.trim()),
    reference_url: orNull(d.reference_url),
    price_change_notice_id: orNull(d.price_change_notice_id),
  };
}

export function emptyDraft(ownerId: string): ChangeDraft {
  return {
    category: 'pricing',
    title: '',
    summary: '',
    audience: 'all_customers',
    owner_id: ownerId,
    notice_date: '',
    effective_date: '',
    min_notice_days: '',
    reference_url: '',
    price_change_notice_id: '',
  };
}

export function entryToDraft(e: ChangeEntry): ChangeDraft {
  return {
    id: e.id,
    category: e.category,
    title: e.title,
    summary: e.summary ?? '',
    audience: e.audience,
    owner_id: e.owner_id,
    notice_date: e.notice_date,
    effective_date: e.effective_date,
    min_notice_days: e.min_notice_days === null ? '' : String(e.min_notice_days),
    reference_url: e.reference_url ?? '',
    price_change_notice_id: e.price_change_notice_id ?? '',
  };
}

// ---------------------------------------------------------------- reminders and urgency

type ReminderInput = Pick<ChangeEntry, 'status' | 'notice_date' | 'effective_date'> & { notice_sent_at: string | null };

/**
 * Which reminder (if any) is due on `today`. At most one, most urgent first.
 * TWIN of public.change_calendar_reminder_kind() in the migration; both are tested against the same cases.
 */
export function reminderKind(e: ReminderInput, today: string): ReminderKind | null {
  const untilNotice = daysBetween(today, e.notice_date);
  const untilEffective = daysBetween(today, e.effective_date);
  if (untilNotice === null || untilEffective === null) return null;
  const sent = e.notice_sent_at !== null;

  if (e.status === 'draft' || e.status === 'pending_approval') {
    if (untilNotice <= 0) return 'unapproved_past_notice';
    if (untilNotice <= 7) return 'approval_needed';
    return null;
  }
  if (e.status === 'approved') {
    if (!sent) {
      if (untilNotice < 0) return 'notice_overdue';
      if (untilNotice <= 1) return 'notice_1d';
      if (untilNotice <= 7) return 'notice_7d';
    }
    if (untilEffective < 0) return 'completion_due';
    if (untilEffective <= 7) return 'effective_7d';
  }
  return null;
}

export type UrgencyLevel = 'critical' | 'warning' | 'info' | 'none' | 'closed';

const LEVEL_BY_KIND: Record<ReminderKind, UrgencyLevel> = {
  unapproved_past_notice: 'critical',
  notice_overdue: 'critical',
  notice_1d: 'warning',
  completion_due: 'warning',
  approval_needed: 'warning',
  notice_7d: 'info',
  effective_7d: 'info',
};

export interface Urgency {
  level: UrgencyLevel;
  kind: ReminderKind | null;
  /** Days until the notice date (negative = overdue). null when the notice was already recorded or the entry is closed. */
  noticeInDays: number | null;
  effectiveInDays: number | null;
}

export function urgencyOf(e: ChangeEntry, today: string): Urgency {
  const effectiveInDays = daysBetween(today, e.effective_date);
  if (isClosed(e.status)) return { level: 'closed', kind: null, noticeInDays: null, effectiveInDays };
  const kind = reminderKind(e, today);
  return {
    level: kind ? LEVEL_BY_KIND[kind] : 'none',
    kind,
    noticeInDays: e.notice_sent_at ? null : daysBetween(today, e.notice_date),
    effectiveInDays,
  };
}

/**
 * Days by which the recorded notice fell short of `min_notice_days` (0 = met, or nothing to compare).
 * Uses the UTC date the notice was recorded. Informational only; it says nothing about legal sufficiency.
 */
export function noticeShortfallDays(e: Pick<ChangeEntry, 'min_notice_days' | 'notice_sent_at' | 'effective_date'>): number {
  if (e.min_notice_days === null || !e.notice_sent_at) return 0;
  const sentDay = e.notice_sent_at.slice(0, 10);
  const given = daysBetween(sentDay, e.effective_date);
  if (given === null) return 0;
  return Math.max(0, e.min_notice_days - given);
}

/** Open entries first, soonest relevant date first; closed entries last, newest effective date first. */
export function sortEntries(list: readonly ChangeEntry[]): ChangeEntry[] {
  const key = (e: ChangeEntry): string => (e.notice_sent_at ? e.effective_date : e.notice_date);
  return [...list].sort((a, b) => {
    const ac = isClosed(a.status);
    const bc = isClosed(b.status);
    if (ac !== bc) return ac ? 1 : -1;
    if (ac) return b.effective_date.localeCompare(a.effective_date) || a.title.localeCompare(b.title);
    return key(a).localeCompare(key(b)) || a.title.localeCompare(b.title);
  });
}

export interface CalendarSummary {
  open: number;
  critical: number;
  warning: number;
  awaitingApproval: number;
  noticeToSend: number;
}

export function summarize(list: readonly ChangeEntry[], today: string): CalendarSummary {
  const s: CalendarSummary = { open: 0, critical: 0, warning: 0, awaitingApproval: 0, noticeToSend: 0 };
  for (const e of list) {
    if (isClosed(e.status)) continue;
    s.open += 1;
    const u = urgencyOf(e, today);
    if (u.level === 'critical') s.critical += 1;
    if (u.level === 'warning') s.warning += 1;
    if (e.status === 'pending_approval') s.awaitingApproval += 1;
    if (e.status === 'approved' && !e.notice_sent_at && e.audience !== 'internal') s.noticeToSend += 1;
  }
  return s;
}

/** Which actions the UI may offer. The database enforces the same rules; this only avoids offering dead buttons. */
export interface Actions {
  edit: boolean;
  submit: boolean;
  approve: boolean;
  reject: boolean;
  markNoticeSent: boolean;
  complete: boolean;
  cancel: boolean;
  /** true when the notice already went out: content is locked (cancel and re-create to change course). */
  locked: boolean;
}

export function actionsFor(e: ChangeEntry, today: string): Actions {
  const closed = isClosed(e.status);
  const effectiveReached = (daysBetween(today, e.effective_date) ?? 1) <= 0;
  return {
    edit: !closed,
    submit: e.status === 'draft',
    approve: e.status === 'pending_approval',
    reject: e.status === 'pending_approval',
    markNoticeSent: e.status === 'approved' && !e.notice_sent_at,
    complete: e.status === 'approved' && effectiveReached && (e.notice_sent_at !== null || e.audience === 'internal'),
    cancel: !closed,
    locked: e.notice_sent_at !== null && !closed,
  };
}

// ---------------------------------------------------------------- reading rows from the API

const isStr = (v: unknown): v is string => typeof v === 'string';
const strOrNull = (v: unknown): string | null => (isStr(v) ? v : null);

export function normalizeEntry(raw: unknown): ChangeEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const category = r.category;
  const audience = r.audience;
  const status = r.status;
  if (!isStr(r.id) || !isStr(r.title) || !isStr(r.owner_id) || !isStr(r.created_by)) return null;
  if (!isStr(category) || !CATEGORIES.includes(category as Category)) return null;
  if (!isStr(audience) || !AUDIENCES.includes(audience as Audience)) return null;
  if (!isStr(status) || !STATUSES.includes(status as Status)) return null;
  if (dayNumber(r.notice_date) === null || dayNumber(r.effective_date) === null) return null;
  return {
    id: r.id,
    category: category as Category,
    title: r.title,
    summary: strOrNull(r.summary),
    audience: audience as Audience,
    owner_id: r.owner_id,
    status: status as Status,
    notice_date: r.notice_date as string,
    effective_date: r.effective_date as string,
    min_notice_days: typeof r.min_notice_days === 'number' ? r.min_notice_days : null,
    reference_url: strOrNull(r.reference_url),
    price_change_notice_id: strOrNull(r.price_change_notice_id),
    notice_sent_at: strOrNull(r.notice_sent_at),
    decided_by: strOrNull(r.decided_by),
    decided_at: strOrNull(r.decided_at),
    decision_note: strOrNull(r.decision_note),
    completed_at: strOrNull(r.completed_at),
    cancelled_at: strOrNull(r.cancelled_at),
    created_by: r.created_by,
    created_at: isStr(r.created_at) ? r.created_at : '',
    updated_at: isStr(r.updated_at) ? r.updated_at : '',
  };
}

// ---------------------------------------------------------------- reminder email (internal, to the entry owner)

export interface ReminderItem {
  entry_id: string;
  kind: ReminderKind;
  title: string;
  category: Category;
  status: Status;
  notice_date: string;
  effective_date: string;
  owner_email: string | null;
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const KIND_LINE: Record<ReminderKind, (i: ReminderItem) => string> = {
  unapproved_past_notice: (i) => `The notice date (${i.notice_date}) has arrived and this change is not approved yet.`,
  approval_needed: (i) => `Notice date ${i.notice_date} is within 7 days and this change is not approved yet.`,
  notice_overdue: (i) => `The notice date (${i.notice_date}) has passed and no notice is recorded as sent.`,
  notice_1d: (i) => `Notice is due by ${i.notice_date} (tomorrow or today) and is not recorded as sent.`,
  notice_7d: (i) => `Notice is due by ${i.notice_date} (within 7 days) and is not recorded as sent.`,
  completion_due: (i) => `The effective date (${i.effective_date}) has passed. Confirm the change is live and mark it completed.`,
  effective_7d: (i) => `This change takes effect on ${i.effective_date} (within 7 days). Confirm everything is ready.`,
};

/** Plain, short, no customer data. The link goes to the staff page, which re-checks staff status. */
export function composeReminderEmail(item: ReminderItem, siteUrl: string): { subject: string; text: string; html: string } {
  const base = siteUrl.replace(/\/+$/, '');
  const link = `${base}/staff/change-calendar`;
  const line = KIND_LINE[item.kind](item);
  const subject = `[Change calendar] ${item.category}: ${item.title}`.slice(0, 200);
  const text = `${line}\n\nChange: ${item.title}\nCategory: ${item.category}\nStatus: ${item.status}\nNotice date: ${item.notice_date}\nEffective date: ${item.effective_date}\n\nOpen the calendar: ${link}\n`;
  const html = `<p>${escapeHtml(line)}</p><p><strong>${escapeHtml(item.title)}</strong><br>Category: ${escapeHtml(item.category)} · Status: ${escapeHtml(item.status)}<br>Notice date: ${escapeHtml(item.notice_date)} · Effective date: ${escapeHtml(item.effective_date)}</p><p><a href="${escapeHtml(link)}">Open the calendar</a></p>`;
  return { subject, text, html };
}
