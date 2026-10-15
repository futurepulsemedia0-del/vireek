/**
 * Priority Call Queue — data access.
 *
 * Reads signals that already exist (RLS-scoped, so a team member sees only
 * their account) and maps them to QueueCandidates for the pure ranker in
 * callQueue.ts. Each source loads independently: if one table is
 * unreachable the rest of the queue still renders and the failure is
 * reported, never silently swallowed.
 */

import { supabase } from '@/lib/supabase';
import { fetchTodayActions, type NextBestAction } from '@/lib/nextBestActions';
import { calculateQuoteTotals, type QuoteLineItem } from '@/lib/quotes';
import {
  type OutcomeRecord,
  type QueueCandidate,
  type QueueItem,
  type QueueOutcome,
  type QueueReason,
  toE164,
} from '@/lib/callQueue';

export interface QueueSnapshot {
  candidates: QueueCandidate[];
  outcomes: OutcomeRecord[];
  businessName: string;
  /** Sources that failed to load (human-readable). Empty when everything loaded. */
  failedSources: string[];
}

const DAY = 86_400_000;
const LOOKBACK_DAYS = 45;

function safeTotal(lineItems: unknown, taxPercent: unknown): number {
  if (!Array.isArray(lineItems)) return 0;
  const items = lineItems.filter(
    (li): li is QuoteLineItem => typeof li?.quantity === 'number' && typeof li?.unit_price_cents === 'number',
  );
  return calculateQuoteTotals(items, Number(taxPercent) || 0).totalCents;
}

function key(reason: QueueReason, table: string, id: string, suffix = ''): string {
  return `${reason}:${table}:${id}${suffix}`;
}

/** Ledger source types → queue reason. Unknown types are skipped, never guessed. */
const LEDGER_REASON: Record<string, QueueReason> = {
  missed_call: 'callback',
  voicemail: 'callback',
  not_booked: 'abandoned_booking',
  cancelled_job: 'abandoned_booking',
  declined_quote: 'quote_followup',
  expired_quote: 'quote_followup',
  quote_accepted_unbooked: 'abandoned_booking',
  quote_financing_stalled: 'quote_followup',
  invoice_overdue: 'unpaid_invoice',
  job_completed_unbilled: 'unpaid_invoice',
  membership_cancelled: 'churn_risk',
  membership_churned: 'churn_risk',
};

type Loader = () => Promise<QueueCandidate[]>;

function ledgerLoader(nbaById: Map<string, number>): Loader {
  return async () => {
    const { data, error } = await supabase
      .from('revenue_recovery_events')
      .select('id, source_type, customer_name, customer_phone, occurred_at, estimated_value_cents, next_follow_up_at')
      .in('status', ['open', 'contacted'])
      .order('occurred_at', { ascending: false })
      .limit(120);
    if (error) throw error;
    const out: QueueCandidate[] = [];
    for (const r of data ?? []) {
      const reason = LEDGER_REASON[r.source_type as string];
      if (!reason) continue;
      out.push({
        key: key(reason, 'revenue_recovery_events', r.id),
        reason,
        sourceTable: 'revenue_recovery_events',
        sourceId: r.id,
        customerName: r.customer_name || 'Unknown caller',
        phone: r.customer_phone,
        valueCents: r.estimated_value_cents ?? 0,
        occurredAt: r.occurred_at,
        detail: String(r.source_type).replace(/_/g, ' '),
        ctaHref: '/dashboard/recovery',
        snoozedUntil: r.next_follow_up_at,
        nbaScore: nbaById.get(r.id) ?? null,
      });
    }
    return out;
  };
}

const quotesLoader: Loader = async () => {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('quotes')
    .select('id, customer_name, customer_phone, line_items, tax_percent, sent_at, valid_until')
    .eq('status', 'sent')
    .lte('sent_at', new Date(Date.now() - 2 * DAY).toISOString())
    .order('sent_at', { ascending: true })
    .limit(60);
  if (error) throw error;
  return (data ?? [])
    .filter((q) => q.sent_at && (!q.valid_until || q.valid_until >= today))
    .map((q) => ({
      key: key('quote_followup', 'quotes', q.id),
      reason: 'quote_followup' as const,
      sourceTable: 'quotes',
      sourceId: q.id,
      customerName: q.customer_name,
      phone: q.customer_phone,
      valueCents: safeTotal(q.line_items, q.tax_percent),
      occurredAt: q.sent_at as string,
      detail: 'Estimate sent, no response yet',
      ctaHref: '/dashboard/quotes',
    }));
};

const invoicesLoader: Loader = async () => {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('invoices')
    .select('id, invoice_number, customer_name, customer_phone, line_items, tax_percent, due_date, sent_at')
    .in('status', ['sent', 'viewed'])
    .not('sent_at', 'is', null)
    .order('due_date', { ascending: true, nullsFirst: false })
    .limit(80);
  if (error) throw error;
  const cutoff = Date.now() - 14 * DAY;
  const out: QueueCandidate[] = [];
  for (const inv of data ?? []) {
    const overdue = inv.due_date ? inv.due_date < today : new Date(inv.sent_at as string).getTime() < cutoff;
    if (!overdue) continue;
    out.push({
      key: key('unpaid_invoice', 'invoices', inv.id),
      reason: 'unpaid_invoice',
      sourceTable: 'invoices',
      sourceId: inv.id,
      customerName: inv.customer_name,
      phone: inv.customer_phone,
      valueCents: safeTotal(inv.line_items, inv.tax_percent),
      occurredAt: inv.due_date ? `${inv.due_date}T00:00:00Z` : (inv.sent_at as string),
      detail: `Invoice ${inv.invoice_number ?? ''} unpaid`.trim(),
      ctaHref: '/dashboard/invoicing',
    });
  }
  return out;
};

const membershipsLoader: Loader = async () => {
  const horizon = new Date(Date.now() + 30 * DAY).toISOString();
  const { data, error } = await supabase
    .from('memberships')
    .select('id, customer_name, customer_phone, status, current_period_end, auto_renew, membership_plans(price_cents)')
    .in('status', ['active', 'past_due'])
    .or(`status.eq.past_due,and(auto_renew.eq.false,current_period_end.lte.${horizon})`)
    .limit(60);
  if (error) throw error;
  return (data ?? []).map((m) => {
    const plan = Array.isArray(m.membership_plans) ? m.membership_plans[0] : m.membership_plans;
    const pastDue = m.status === 'past_due';
    return {
      key: key('expiring_membership', 'memberships', m.id, m.current_period_end ? `:${m.current_period_end.slice(0, 10)}` : ''),
      reason: 'expiring_membership' as const,
      sourceTable: 'memberships',
      sourceId: m.id,
      customerName: m.customer_name,
      phone: m.customer_phone,
      valueCents: plan?.price_cents ?? 0,
      occurredAt: new Date().toISOString(),
      expiresAt: m.current_period_end,
      pastDue,
      detail: pastDue ? 'Membership payment failed' : 'Membership ends soon, auto-renew off',
      ctaHref: '/dashboard/memberships',
    };
  });
};

const unhappyLoader: Loader = async () => {
  const since = new Date(Date.now() - 14 * DAY).toISOString();
  const [feedback, negative] = await Promise.all([
    supabase
      .from('call_feedback')
      .select('call_id, rating, comment, created_at, calls(caller_name, caller_phone)')
      .lte('rating', 2)
      .gte('created_at', since)
      .limit(40),
    supabase
      .from('calls')
      .select('id, caller_name, caller_phone, call_datetime, summary')
      .eq('sentiment', 'negative')
      .gte('call_datetime', since)
      .order('call_datetime', { ascending: false })
      .limit(40),
  ]);
  if (feedback.error) throw feedback.error;
  if (negative.error) throw negative.error;

  const out: QueueCandidate[] = [];
  for (const f of feedback.data ?? []) {
    const call = Array.isArray(f.calls) ? f.calls[0] : f.calls;
    out.push({
      key: key('unhappy_customer', 'calls', f.call_id),
      reason: 'unhappy_customer',
      sourceTable: 'calls',
      sourceId: f.call_id,
      customerName: call?.caller_name || 'Unknown caller',
      phone: call?.caller_phone ?? null,
      valueCents: 0,
      occurredAt: f.created_at,
      rating: f.rating,
      detail: f.comment ? `Rated ${f.rating}/5: ${String(f.comment).slice(0, 90)}` : `Rated ${f.rating}/5`,
      ctaHref: '/dashboard/calls',
    });
  }
  for (const c of negative.data ?? []) {
    out.push({
      key: key('unhappy_customer', 'calls', c.id), // same key as feedback for that call → deduped by the ranker
      reason: 'unhappy_customer',
      sourceTable: 'calls',
      sourceId: c.id,
      customerName: c.caller_name || 'Unknown caller',
      phone: c.caller_phone,
      valueCents: 0,
      occurredAt: c.call_datetime,
      detail: c.summary ? `Negative call: ${String(c.summary).slice(0, 90)}` : 'Call flagged as negative',
      ctaHref: '/dashboard/calls',
    });
  }
  return out;
};

/** Win-back candidates the NBA engine already ranked today (read-only: never triggers the AI run). */
function churnLoader(actions: NextBestAction[]): Loader {
  return async () => {
    const churn = actions.filter((a) => a.status === 'open' && a.category === 'churn_risk' && a.entity_type === 'customer' && a.entity_id);
    if (churn.length === 0) return [];
    const { data, error } = await supabase.from('customers').select('id, name, phone').in('id', churn.map((a) => a.entity_id as string));
    if (error) throw error;
    const byId = new Map((data ?? []).map((c) => [c.id, c]));
    const out: QueueCandidate[] = [];
    for (const a of churn) {
      const c = byId.get(a.entity_id as string);
      if (!c) continue;
      out.push({
        key: key('churn_risk', 'customers', c.id, `:${a.action_date}`),
        reason: 'churn_risk',
        sourceTable: 'customers',
        sourceId: c.id,
        customerName: c.name,
        phone: c.phone,
        valueCents: 0,
        occurredAt: a.created_at,
        detail: a.reasoning,
        ctaHref: a.cta_href ?? `/dashboard/customers/${c.id}`,
        nbaScore: a.priority_score,
      });
    }
    return out;
  };
}

async function loadOutcomes(): Promise<OutcomeRecord[]> {
  const since = new Date(Date.now() - LOOKBACK_DAYS * DAY).toISOString();
  const { data, error } = await supabase
    .from('call_queue_outcomes')
    .select('item_key, outcome, snooze_until, created_at')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(1000);
  if (error) throw error;
  return (data ?? []).map((o) => ({
    itemKey: o.item_key,
    outcome: o.outcome as QueueOutcome,
    snoozeUntil: o.snooze_until,
    createdAt: o.created_at,
  }));
}

async function loadBusinessName(): Promise<string> {
  try {
    const { data: ownerId } = await supabase.rpc('get_account_owner_id');
    if (!ownerId) return '';
    const { data } = await supabase.from('profiles').select('company_name').eq('id', ownerId).maybeSingle();
    return (data?.company_name as string | undefined)?.trim() ?? '';
  } catch {
    return '';
  }
}

export async function loadQueueSnapshot(): Promise<QueueSnapshot> {
  // NBA is optional context: its failure must not block the queue.
  let nbaActions: NextBestAction[] = [];
  let nbaFailed = false;
  try {
    nbaActions = await fetchTodayActions();
  } catch {
    nbaFailed = true;
  }
  const nbaById = new Map<string, number>();
  for (const a of nbaActions) {
    if (a.status === 'open' && a.entity_id) nbaById.set(a.entity_id, Math.max(a.priority_score, nbaById.get(a.entity_id) ?? 0));
  }

  const sources: Array<[string, Loader]> = [
    ['Recovery ledger', ledgerLoader(nbaById)],
    ['Quotes', quotesLoader],
    ['Invoices', invoicesLoader],
    ['Memberships', membershipsLoader],
    ['Customer satisfaction', unhappyLoader],
    ['Win-back', churnLoader(nbaActions)],
  ];

  const [results, outcomesResult, businessName] = await Promise.all([
    Promise.allSettled(sources.map(([, load]) => load())),
    loadOutcomes().then(
      (v) => ({ ok: true as const, v }),
      () => ({ ok: false as const, v: [] as OutcomeRecord[] }),
    ),
    loadBusinessName(),
  ]);

  const failedSources: string[] = [];
  const candidates: QueueCandidate[] = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') candidates.push(...r.value);
    else failedSources.push(sources[i][0]);
  });
  if (nbaFailed) failedSources.push('Next Best Actions');
  if (!outcomesResult.ok) failedSources.push('Call history');

  return { candidates, outcomes: outcomesResult.v, businessName, failedSources };
}

export interface LogOutcomeInput {
  item: Pick<QueueItem, 'key' | 'reason' | 'sourceTable' | 'sourceId' | 'customerName' | 'phone' | 'valueCents'>;
  outcome: QueueOutcome;
  channel: 'call' | 'sms' | 'none';
  note?: string;
  snoozeUntil: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function logQueueOutcome({ item, outcome, channel, note, snoozeUntil }: LogOutcomeInput): Promise<void> {
  const { error } = await supabase.rpc('log_call_queue_outcome', {
    p_item_key: item.key,
    p_reason: item.reason,
    p_source_table: item.sourceTable,
    p_source_id: UUID.test(item.sourceId) ? item.sourceId : null,
    p_customer_name: item.customerName,
    p_phone: item.phone,
    p_outcome: outcome,
    p_channel: channel,
    p_note: note?.trim() || null,
    p_snooze_until: snoozeUntil,
    p_value_cents: item.valueCents > 0 ? Math.round(item.valueCents) : null,
  });
  if (error) throw new Error(error.message || 'Could not save the call outcome.');
}

export async function sendQueueSms(phone: string, body: string, customerName: string): Promise<void> {
  const { data, error } = await supabase.functions.invoke('call-queue-sms', {
    body: { phone: toE164(phone), body, customerName },
  });
  if (error) {
    const ctx = (error as { context?: unknown }).context;
    if (typeof Response !== 'undefined' && ctx instanceof Response) {
      try {
        const j = (await ctx.clone().json()) as { error?: unknown };
        if (typeof j?.error === 'string' && j.error) throw new Error(j.error);
      } catch (e) {
        if (e instanceof Error && e.message !== error.message) throw e;
      }
    }
    throw new Error('Could not send the text. Try again or use your phone’s Messages app.');
  }
  if (data?.error) throw new Error(String(data.error));
}
