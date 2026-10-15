import { supabase } from '@/lib/supabase';

/**
 * Collections — client library.
 *
 * Wraps supabase/migrations/20270411000000_collections_management.sql.
 * All writes go through SECURITY DEFINER RPCs that re-check permission and
 * business rules server-side; the validation here is only for instant
 * feedback. Money is always integer cents.
 */

export type Bucket = 'current' | '1-30' | '31-60' | '61-90' | '90+';
export type StepChannel = 'email' | 'sms' | 'call' | 'letter' | 'escalate';
export type ActionChannel = StepChannel | 'note';
export type ActionStatus = 'pending' | 'done' | 'skipped';
export type PromiseStatus = 'open' | 'kept' | 'broken' | 'cancelled';

export interface BucketSummary { bucket: Bucket; count: number; balance_cents: number }

export interface CollectionsOverview {
  as_of: string;
  buckets: BucketSummary[];
  totals: {
    open_invoices: number; open_balance_cents: number; overdue_invoices: number; overdue_balance_cents: number;
    on_hold: number; escalated: number; pending_actions: number; collected_30d_cents: number;
  };
  promises: { open: number; open_amount_cents: number; kept_90d: number; broken_90d: number };
}

export interface CollectionCase {
  invoice_id: string; invoice_number: string; customer_id: string | null; customer_name: string;
  customer_email: string | null; customer_phone: string | null; due_date: string; days_overdue: number;
  bucket: Bucket; balance_cents: number; on_hold: boolean; hold_reason: string | null; escalation_level: number;
  sequence_name: string | null; pending_actions: number; promise_id: string | null; promise_amount_cents: number | null;
  promise_date: string | null; broken_promises: number; last_contact_at: string | null; total_count: number;
}

export interface CollectionAction {
  id: string; invoice_id: string; invoice_number: string; customer_name: string; customer_email: string | null;
  customer_phone: string | null; channel: ActionChannel; escalation_level: number | null; due_date: string;
  status: ActionStatus; subject: string | null; body: string | null; outcome: string | null;
  completed_at: string | null; balance_cents: number; days_overdue: number;
}

export interface CollectionPromise {
  id: string; invoice_id: string; invoice_number: string; customer_name: string; customer_phone: string | null;
  promised_amount_cents: number; promised_date: string; status: PromiseStatus; notes: string | null;
  created_at: string; resolved_at: string | null; balance_cents: number;
}

export interface TimelineEntry {
  id: string; channel: ActionChannel; status: ActionStatus; subject: string | null; outcome: string | null;
  completed_at: string | null; created_at: string; due_date: string;
}

export interface SequenceStep {
  id?: string; days_after_due: number; channel: StepChannel; subject: string | null; template: string; escalation_level: number | null;
}
export interface Sequence { id: string; name: string; is_default: boolean; is_active: boolean; steps: (SequenceStep & { id: string })[] }
export interface SequenceDraft { id: string | null; name: string; is_default: boolean; is_active: boolean; steps: SequenceStep[] }

export const BUCKETS: { bucket: Bucket; label: string; tone: string }[] = [
  { bucket: 'current', label: 'Current', tone: 'bg-success' },
  { bucket: '1-30', label: '1–30 days', tone: 'bg-warning-500' },
  { bucket: '31-60', label: '31–60 days', tone: 'bg-orange-500' },
  { bucket: '61-90', label: '61–90 days', tone: 'bg-danger' },
  { bucket: '90+', label: '90+ days', tone: 'bg-red-700' },
];

export const CHANNELS: { channel: StepChannel; label: string }[] = [
  { channel: 'email', label: 'Email' },
  { channel: 'sms', label: 'Text message' },
  { channel: 'call', label: 'Phone call' },
  { channel: 'letter', label: 'Letter / formal notice' },
  { channel: 'escalate', label: 'Escalation' },
];

export const ESCALATION_LEVELS: { level: number; label: string }[] = [
  { level: 0, label: 'Not escalated' },
  { level: 1, label: 'Level 1 · Manager review' },
  { level: 2, label: 'Level 2 · Final demand' },
  { level: 3, label: 'Level 3 · External collections / legal' },
];

export const TEMPLATE_TOKENS = ['customer_name', 'invoice_number', 'balance', 'due_date', 'days_overdue', 'company_name'] as const;
export const MAX_STEPS = 12;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function usd(cents: number): string {
  const s = (Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${cents < 0 ? '-' : ''}$${s}`;
}

export function errMsg(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  if (e && typeof e === 'object' && 'message' in e && typeof (e as { message: unknown }).message === 'string') {
    return (e as { message: string }).message || 'Something went wrong.';
  }
  return 'Something went wrong.';
}

/** Same boundaries as get_ar_aging(): on/before the due date is current. */
export function bucketForDaysPastDue(daysPastDue: number): Bucket {
  if (daysPastDue <= 0) return 'current';
  if (daysPastDue <= 30) return '1-30';
  if (daysPastDue <= 60) return '31-60';
  if (daysPastDue <= 90) return '61-90';
  return '90+';
}

export function bucketMeta(bucket: Bucket) {
  return BUCKETS.find((b) => b.bucket === bucket) ?? BUCKETS[0];
}

/** Percent share of each bucket's balance, summing to 100 (all zeros when nothing is owed). */
export function bucketShares(buckets: BucketSummary[]): { bucket: Bucket; pct: number }[] {
  const total = buckets.reduce((s, b) => s + b.balance_cents, 0);
  if (total <= 0) return buckets.map((b) => ({ bucket: b.bucket, pct: 0 }));
  return buckets.map((b) => ({ bucket: b.bucket, pct: (b.balance_cents * 100) / total }));
}

/** kept / (kept + broken), or null when nothing has resolved yet. */
export function promiseKeptRate(kept: number, broken: number): number | null {
  const resolved = kept + broken;
  return resolved === 0 ? null : kept / resolved;
}

export function escalationLabel(level: number): string {
  return ESCALATION_LEVELS.find((l) => l.level === level)?.label ?? 'Not escalated';
}

export function describeTiming(days: number): string {
  if (days === 0) return 'On the due date';
  const n = Math.abs(days);
  return `${n} day${n === 1 ? '' : 's'} ${days < 0 ? 'before' : 'after'} due`;
}

/** Mirrors public._col_render() so the editor preview matches what staff will receive. */
export function renderTemplate(
  tpl: string,
  vars: { customer_name: string; invoice_number: string; balance_cents: number; due_date: string; days_overdue: number; company_name: string },
): string {
  const [y, m, d] = vars.due_date.split('-').map(Number);
  const due = new Date(Date.UTC(y, (m || 1) - 1, d || 1)).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric', timeZone: 'UTC' });
  return tpl
    .split('{{customer_name}}').join(vars.customer_name || 'there')
    .split('{{invoice_number}}').join(vars.invoice_number)
    .split('{{balance}}').join(usd(vars.balance_cents))
    .split('{{due_date}}').join(due)
    .split('{{days_overdue}}').join(String(Math.max(0, vars.days_overdue)))
    .split('{{company_name}}').join(vars.company_name.trim() || 'our team');
}

/** '$1,250.50' | '1250.5' -> 125050. Returns null for anything that isn't a clean amount. */
export function parseDollarsToCents(input: string): number | null {
  const s = input.trim().replace(/^\$/, '').replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

export function isoToday(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

export interface PromiseErrors { amount?: string; date?: string }

export function validatePromise(
  draft: { amount: string; date: string },
  balanceCents: number,
  today: string,
): { errors: PromiseErrors; amountCents: number | null } {
  const errors: PromiseErrors = {};
  const amountCents = parseDollarsToCents(draft.amount);
  if (amountCents === null || amountCents < 1) errors.amount = 'Enter an amount like 250.00.';
  else if (amountCents > balanceCents) errors.amount = `Can't exceed the open balance of ${usd(balanceCents)}.`;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.date)) errors.date = 'Choose a date.';
  else if (draft.date < today) errors.date = 'The date can’t be in the past.';
  else if (draft.date > addDaysIso(today, 180)) errors.date = 'Choose a date within 180 days.';
  return { errors, amountCents: errors.amount ? null : amountCents };
}

export interface SequenceErrors { name?: string; steps?: string; stepErrors: Record<number, string> }

export function validateSequenceDraft(d: SequenceDraft): SequenceErrors {
  const out: SequenceErrors = { stepErrors: {} };
  const name = d.name.trim();
  if (!name) out.name = 'Name the sequence.';
  else if (name.length > 80) out.name = 'Keep the name under 80 characters.';

  if (d.steps.length < 1) out.steps = 'Add at least one step.';
  else if (d.steps.length > MAX_STEPS) out.steps = `A sequence can have at most ${MAX_STEPS} steps.`;

  d.steps.forEach((s, i) => {
    if (!Number.isInteger(s.days_after_due) || s.days_after_due < -30 || s.days_after_due > 365) {
      out.stepErrors[i] = 'Timing must be between 30 days before and 365 days after the due date.';
    } else if (s.channel === 'escalate' && (s.escalation_level == null || s.escalation_level < 1 || s.escalation_level > 3)) {
      out.stepErrors[i] = 'Choose an escalation level.';
    } else if (s.channel !== 'call' && s.channel !== 'escalate' && !s.template.trim()) {
      out.stepErrors[i] = 'Write the message for this step.';
    } else if (s.template.length > 1000) {
      out.stepErrors[i] = 'Keep the message under 1000 characters.';
    } else if ((s.subject ?? '').length > 120) {
      out.stepErrors[i] = 'Keep the subject under 120 characters.';
    }
  });
  return out;
}

export function hasSequenceErrors(e: SequenceErrors): boolean {
  return !!e.name || !!e.steps || Object.keys(e.stepErrors).length > 0;
}

/** Steps sorted the way the server will store them (by timing, stable for ties). */
export function sortSteps<T extends { days_after_due: number }>(steps: T[]): T[] {
  return steps.map((s, i) => ({ s, i })).sort((a, b) => a.s.days_after_due - b.s.days_after_due || a.i - b.i).map((x) => x.s);
}

function cleanPhone(phone: string): string {
  return phone.replace(/(?!^\+)[^\d]/g, '');
}

/** Deep link that opens the user's own mail/phone/messages app with the prepared text. */
export function contactHref(
  channel: ActionChannel,
  c: { email: string | null; phone: string | null; subject: string | null; body: string | null },
): string | null {
  if (channel === 'email' || channel === 'letter') {
    if (!c.email) return null;
    return `mailto:${encodeURIComponent(c.email)}?subject=${encodeURIComponent(c.subject ?? '')}&body=${encodeURIComponent(c.body ?? '')}`;
  }
  if (channel === 'sms') {
    const p = c.phone ? cleanPhone(c.phone) : '';
    return p ? `sms:${p}?body=${encodeURIComponent(c.body ?? '')}` : null;
  }
  if (channel === 'call') {
    const p = c.phone ? cleanPhone(c.phone) : '';
    return p ? `tel:${p}` : null;
  }
  return null;
}

export type Urgency = 'low' | 'medium' | 'high' | 'critical';
export function urgencyFor(daysOverdue: number, escalationLevel = 0): Urgency {
  if (escalationLevel >= 2 || daysOverdue > 90) return 'critical';
  if (escalationLevel >= 1 || daysOverdue > 60) return 'high';
  if (daysOverdue > 30) return 'medium';
  return 'low';
}

export function describeTimelineEntry(e: TimelineEntry): string {
  const label = e.subject?.trim() || (e.channel === 'note' ? 'Note' : e.channel);
  return e.outcome ? `${label} — ${e.outcome}` : label;
}

// ---------------------------------------------------------------------------
// API (all throw on failure)
// ---------------------------------------------------------------------------

export async function runCollectionsCycle(): Promise<{ actions_created: number; actions_skipped: number; promises_kept: number; promises_broken: number }> {
  const { data, error } = await supabase.rpc('run_collections_cycle');
  if (error) throw error;
  return data as { actions_created: number; actions_skipped: number; promises_kept: number; promises_broken: number };
}

export async function fetchOverview(): Promise<CollectionsOverview> {
  const { data, error } = await supabase.rpc('get_collections_overview');
  if (error) throw error;
  return data as CollectionsOverview;
}

export async function fetchCases(bucket: Bucket | null, offset: number, limit = 100): Promise<CollectionCase[]> {
  const { data, error } = await supabase.rpc('get_collection_cases', { p_bucket: bucket, p_limit: limit, p_offset: offset });
  if (error) throw error;
  return ((data ?? []) as CollectionCase[]).map((c) => ({
    ...c,
    escalation_level: Number(c.escalation_level),
    pending_actions: Number(c.pending_actions),
    broken_promises: Number(c.broken_promises),
    total_count: Number(c.total_count),
  }));
}

export async function fetchActions(status: ActionStatus | null): Promise<CollectionAction[]> {
  const { data, error } = await supabase.rpc('get_collection_actions', { p_status: status, p_limit: 200 });
  if (error) throw error;
  return (data ?? []) as CollectionAction[];
}

export async function fetchPromises(status: PromiseStatus | null): Promise<CollectionPromise[]> {
  const { data, error } = await supabase.rpc('get_collection_promises', { p_status: status, p_limit: 200 });
  if (error) throw error;
  return (data ?? []) as CollectionPromise[];
}

export async function fetchSequences(): Promise<Sequence[]> {
  const { data, error } = await supabase.rpc('get_collection_sequences');
  if (error) throw error;
  return (data ?? []) as Sequence[];
}

export async function ensureDefaultSequence(): Promise<void> {
  const { error } = await supabase.rpc('ensure_default_collection_sequence');
  if (error) throw error;
}

export async function saveSequence(d: SequenceDraft): Promise<string> {
  const { data, error } = await supabase.rpc('save_collection_sequence', {
    p_id: d.id,
    p_name: d.name.trim(),
    p_is_default: d.is_default,
    p_is_active: d.is_active,
    p_steps: d.steps.map((s) => ({
      id: s.id ?? null,
      days_after_due: s.days_after_due,
      channel: s.channel,
      subject: s.subject?.trim() || null,
      template: s.template,
      escalation_level: s.channel === 'escalate' ? s.escalation_level : null,
    })),
  });
  if (error) throw error;
  return data as string;
}

export async function completeAction(id: string, status: 'done' | 'skipped', outcome?: string): Promise<void> {
  const { error } = await supabase.rpc('complete_collection_action', { p_action_id: id, p_status: status, p_outcome: outcome?.trim() || null });
  if (error) throw error;
}

export async function logContact(invoiceId: string, channel: ActionChannel, outcome: string): Promise<void> {
  const { error } = await supabase.rpc('log_collection_contact', { p_invoice_id: invoiceId, p_channel: channel, p_outcome: outcome.trim() });
  if (error) throw error;
}

export async function createPromise(invoiceId: string, amountCents: number, date: string, notes?: string): Promise<void> {
  const { error } = await supabase.rpc('create_collection_promise', {
    p_invoice_id: invoiceId, p_amount_cents: amountCents, p_promised_date: date, p_notes: notes?.trim() || null,
  });
  if (error) throw error;
}

export async function cancelPromise(id: string, reason?: string): Promise<void> {
  const { error } = await supabase.rpc('cancel_collection_promise', { p_promise_id: id, p_reason: reason?.trim() || null });
  if (error) throw error;
}

export async function setHold(invoiceId: string, hold: boolean, reason?: string): Promise<void> {
  const { error } = await supabase.rpc('set_invoice_collection_hold', { p_invoice_id: invoiceId, p_hold: hold, p_reason: reason?.trim() || null });
  if (error) throw error;
}

export async function setEscalation(invoiceId: string, level: number, note?: string): Promise<void> {
  const { error } = await supabase.rpc('escalate_collection_invoice', { p_invoice_id: invoiceId, p_level: level, p_note: note?.trim() || null });
  if (error) throw error;
}

/** accountOwnerId = owner's profile id, or a team member's account_owner_id. */
export async function fetchTimeline(accountOwnerId: string, invoiceId: string): Promise<TimelineEntry[]> {
  const { data, error } = await supabase
    .from('collection_actions')
    .select('id, channel, status, subject, outcome, completed_at, created_at, due_date')
    .eq('user_id', accountOwnerId)
    .eq('invoice_id', invoiceId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data ?? []) as TimelineEntry[];
}
