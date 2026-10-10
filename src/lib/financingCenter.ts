import { supabase } from '@/lib/supabase';
import {
  fetchFinancingConnection,
  fetchFinancingOffers,
  MIN_FINANCING_AMOUNT_CENTS,
  type FinancingConnection,
  type FinancingOffer,
  type FinancingOfferStatus,
} from '@/lib/financing';
import { fetchPaymentRequests, type PaymentRequest } from '@/lib/payments';
import { calculateQuoteTotals, type QuoteLineItem } from '@/lib/quotes';
import { monthlyPayment } from '@/lib/serviceFinance';

/**
 * Financing Center — orchestration layer.
 * Reads the existing financing / jobs / quotes / payments data and derives
 * analytics + eligibility. It never writes financial state itself: offers are
 * created by `financing-create-offer`, statuses are updated by `financing-webhook`.
 */

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export interface FinancingJob {
  id: string;
  customer_id: string | null;
  customer_name: string;
  customer_phone: string | null;
  service_type: string | null;
  job_status: string;
  invoice_amount: number | null;
  invoice_status: string;
  quote_id: string | null;
  scheduled_datetime: string | null;
  created_at: string;
}

export interface FinancingQuote {
  id: string;
  customer_name: string;
  line_items: QuoteLineItem[] | null;
  tax_percent: number | null;
  status: string;
  created_at: string;
}

export interface FinancingOfferEvent {
  id: string;
  offer_id: string;
  event_type: string;
  raw_payload: Record<string, unknown>;
  received_at: string;
}

export interface FinancingCenterData {
  connection: FinancingConnection | null;
  offers: FinancingOffer[];
  jobs: FinancingJob[];
  quotes: FinancingQuote[];
  payments: PaymentRequest[];
  loadedAt: string;
}

// ---------------------------------------------------------------- providers

export const PROVIDER_CATALOG: Record<string, { name: string; minAmountCents: number }> = {
  wisetack: { name: 'Wisetack', minAmountCents: MIN_FINANCING_AMOUNT_CENTS },
};

export function providerName(id: string): string {
  return PROVIDER_CATALOG[id]?.name ?? id.charAt(0).toUpperCase() + id.slice(1);
}

// ---------------------------------------------------------------- statuses

export const ACTIVE_STATUSES: readonly FinancingOfferStatus[] = [
  'created', 'sent', 'clicked', 'applied', 'approved', 'loan_confirmed',
];
const APPROVED_STATUSES: readonly FinancingOfferStatus[] = ['approved', 'loan_confirmed', 'funded'];
const CLOSED_STATUSES: readonly FinancingOfferStatus[] = ['declined', 'expired', 'canceled'];

// How far an offer got. A declined offer necessarily reached the application step.
const STAGE_RANK: Record<FinancingOfferStatus, number> = {
  created: 0, sent: 1, clicked: 2, applied: 3, approved: 4,
  loan_confirmed: 5, funded: 6, declined: 3, expired: 1, canceled: 0,
};

export const isActiveOffer = (o: Pick<FinancingOffer, 'status'>): boolean => ACTIVE_STATUSES.includes(o.status);
const offerAmountCents = (o: FinancingOffer): number => o.approved_amount_cents ?? o.requested_amount_cents;

const EVENT_LABELS: Record<string, string> = {
  transaction_created: 'Offer created',
  application_started: 'Customer opened the application',
  application_submitted: 'Application submitted',
  loan_approved: 'Loan approved',
  loan_declined: 'Application declined',
  transaction_expired: 'Offer expired',
  loan_confirmed: 'Customer confirmed the loan',
  loan_funded: 'Loan funded — payout released',
  transaction_canceled: 'Offer canceled',
};

export function eventLabel(type: string): string {
  return EVENT_LABELS[type] ?? type.replace(/[_.-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------- formatting

const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const usd2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const formatUsd = (cents: number, precise = false): string => (precise ? usd2 : usd0).format(cents / 100);
export const formatPct = (v: number | null): string => (v === null ? '—' : `${Math.round(v * 100)}%`);
export const formatDays = (v: number | null): string => (v === null ? '—' : v < 1 ? '<1 day' : `${v.toFixed(1)} days`);
export const formatAprShort = (bps: number | null): string => (bps === null ? '—' : `${(bps / 100).toFixed(2)}%`);

/** Estimated level monthly payment in cents for an approved offer (display only). */
export function estimateMonthlyCents(o: FinancingOffer): number | null {
  if (!o.approved_amount_cents || !o.term_months || o.apr_bps === null) return null;
  const v = monthlyPayment(o.approved_amount_cents, o.apr_bps / 10000, o.term_months);
  return v > 0 ? Math.round(v) : null;
}

// ---------------------------------------------------------------- analytics

export interface FunnelStage { key: 'offered' | 'viewed' | 'applied' | 'approved' | 'funded'; label: string; count: number; pct: number }

export interface FinancingAnalytics {
  total: number;
  offered: number;
  active: number;
  funded: number;
  declined: number;
  fundedCents: number;
  pipelineCents: number;
  approvalRate: number | null;
  conversionRate: number | null;
  avgAprBps: number | null;
  avgTermMonths: number | null;
  avgDaysToFund: number | null;
  funnel: FunnelStage[];
  declineReasons: { reason: string; count: number }[];
  monthly: { month: string; label: string; fundedCents: number; count: number }[];
}

const monthKey = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

export function computeAnalytics(offers: FinancingOffer[], now: Date = new Date()): FinancingAnalytics {
  const offered = offers.filter((o) => o.application_url !== null || STAGE_RANK[o.status] >= 1);
  const funded = offers.filter((o) => o.status === 'funded');
  const declined = offers.filter((o) => o.status === 'declined');
  const active = offers.filter(isActiveOffer);
  const approvedPlus = offers.filter((o) => APPROVED_STATUSES.includes(o.status));

  const stageCount = (min: number) => offered.filter((o) => STAGE_RANK[o.status] >= min).length;
  const base = offered.length;
  const mk = (key: FunnelStage['key'], label: string, count: number): FunnelStage => ({
    key, label, count, pct: base > 0 ? count / base : 0,
  });
  const funnel = [
    mk('offered', 'Offered', base),
    mk('viewed', 'Opened', stageCount(2)),
    mk('applied', 'Applied', stageCount(3)),
    mk('approved', 'Approved', approvedPlus.length),
    mk('funded', 'Funded', funded.length),
  ];

  const decided = approvedPlus.length + declined.length;

  let aprWeight = 0;
  let aprSum = 0;
  for (const o of approvedPlus) {
    if (o.apr_bps === null) continue;
    const w = offerAmountCents(o);
    if (w <= 0) continue;
    aprWeight += w;
    aprSum += o.apr_bps * w;
  }

  const terms = approvedPlus.map((o) => o.term_months).filter((t): t is number => typeof t === 'number' && t > 0);
  const fundDays = funded
    .filter((o) => o.funded_at)
    .map((o) => (new Date(o.funded_at as string).getTime() - new Date(o.created_at).getTime()) / 86_400_000)
    .filter((d) => Number.isFinite(d) && d >= 0);

  const reasons = new Map<string, number>();
  for (const o of declined) {
    const r = o.decline_reason?.trim() || 'Not provided';
    reasons.set(r, (reasons.get(r) ?? 0) + 1);
  }

  const monthly = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (5 - i), 1);
    return { month: monthKey(d), label: d.toLocaleDateString('en-US', { month: 'short' }), fundedCents: 0, count: 0 };
  });
  for (const o of funded) {
    if (!o.funded_at) continue;
    const slot = monthly.find((m) => m.month === monthKey(new Date(o.funded_at as string)));
    if (slot) { slot.fundedCents += offerAmountCents(o); slot.count += 1; }
  }

  return {
    total: offers.length,
    offered: base,
    active: active.length,
    funded: funded.length,
    declined: declined.length,
    fundedCents: funded.reduce((s, o) => s + offerAmountCents(o), 0),
    pipelineCents: active.reduce((s, o) => s + offerAmountCents(o), 0),
    approvalRate: decided > 0 ? approvedPlus.length / decided : null,
    conversionRate: base > 0 ? funded.length / base : null,
    avgAprBps: aprWeight > 0 ? aprSum / aprWeight : null,
    avgTermMonths: terms.length ? terms.reduce((s, t) => s + t, 0) / terms.length : null,
    avgDaysToFund: fundDays.length ? fundDays.reduce((s, d) => s + d, 0) / fundDays.length : null,
    funnel,
    declineReasons: [...reasons.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count).slice(0, 5),
    monthly,
  };
}

export function analyticsByProvider(offers: FinancingOffer[], now: Date = new Date()): Record<string, FinancingAnalytics> {
  const groups: Record<string, FinancingOffer[]> = {};
  for (const o of offers) (groups[o.provider] ??= []).push(o);
  return Object.fromEntries(Object.entries(groups).map(([id, list]) => [id, computeAnalytics(list, now)]));
}

// ---------------------------------------------------------------- filtering / export

export type OfferFilter = 'all' | 'active' | 'approved' | 'funded' | 'closed';

export function filterOffers(offers: FinancingOffer[], filter: OfferFilter, query: string): FinancingOffer[] {
  const q = query.trim().toLowerCase();
  return offers.filter((o) => {
    if (filter === 'active' && !isActiveOffer(o)) return false;
    if (filter === 'approved' && !APPROVED_STATUSES.includes(o.status)) return false;
    if (filter === 'funded' && o.status !== 'funded') return false;
    if (filter === 'closed' && !CLOSED_STATUSES.includes(o.status)) return false;
    if (!q) return true;
    return [o.customer_name, o.customer_email, o.customer_phone, o.id]
      .some((v) => (v ?? '').toLowerCase().includes(q));
  });
}

function csvCell(v: string | number | null): string {
  if (v === null) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // neutralise spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function offersToCsv(offers: FinancingOffer[]): string {
  const header = ['id', 'provider', 'customer', 'email', 'phone', 'status', 'requested_usd', 'approved_usd', 'apr_percent', 'term_months', 'created_at', 'funded_at'];
  const rows = offers.map((o) => [
    o.id, o.provider, o.customer_name, o.customer_email, o.customer_phone, o.status,
    (o.requested_amount_cents / 100).toFixed(2),
    o.approved_amount_cents === null ? null : (o.approved_amount_cents / 100).toFixed(2),
    o.apr_bps === null ? null : (o.apr_bps / 100).toFixed(2),
    o.term_months, o.created_at, o.funded_at,
  ]);
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
}

// ---------------------------------------------------------------- eligibility

export type BlockReason = 'not_connected' | 'no_amount' | 'below_minimum' | 'already_paid' | 'already_financed' | 'offer_active';
export type RowWarning = 'open_payment_link' | 'needs_contact';

export const BLOCK_LABELS: Record<BlockReason, string> = {
  not_connected: 'Financing not enabled',
  no_amount: 'No invoice amount',
  below_minimum: `Below ${formatUsd(MIN_FINANCING_AMOUNT_CENTS)} minimum`,
  already_paid: 'Already paid',
  already_financed: 'Already financed',
  offer_active: 'Offer in progress',
};
export const WARNING_LABELS: Record<RowWarning, string> = {
  open_payment_link: 'Open payment link exists',
  needs_contact: 'Phone missing — add email',
};

export interface EligibilityRow {
  job: FinancingJob;
  amountCents: number;
  quoteTotalCents: number | null;
  blockers: BlockReason[];
  warnings: RowWarning[];
  eligible: boolean;
}

const OPEN_PAYMENT_STATUSES = ['pending', 'sent', 'overdue'];

function groupBy<T>(items: T[], key: (t: T) => string | null): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    if (!k) continue;
    const list = map.get(k);
    if (list) list.push(it); else map.set(k, [it]);
  }
  return map;
}

export function buildEligibility(input: {
  jobs: FinancingJob[];
  offers: FinancingOffer[];
  payments: PaymentRequest[];
  quotes: FinancingQuote[];
  connected: boolean;
}): EligibilityRow[] {
  const offersByJob = groupBy(input.offers, (o) => o.job_id);
  const paymentsByJob = groupBy(input.payments, (p) => p.job_id);
  const quoteTotals = new Map<string, number>();
  for (const q of input.quotes) quoteTotals.set(q.id, calculateQuoteTotals(q.line_items ?? [], Number(q.tax_percent) || 0).totalCents);

  const rows: EligibilityRow[] = [];
  for (const job of input.jobs) {
    if (job.job_status === 'cancelled' || job.job_status === 'no_show') continue;
    const amountCents = job.invoice_amount ? Math.round(Number(job.invoice_amount) * 100) : 0;
    const jobOffers = offersByJob.get(job.id) ?? [];
    const jobPayments = paymentsByJob.get(job.id) ?? [];

    const blockers: BlockReason[] = [];
    if (!input.connected) blockers.push('not_connected');
    if (amountCents <= 0) blockers.push('no_amount');
    else if (amountCents < MIN_FINANCING_AMOUNT_CENTS) blockers.push('below_minimum');
    if (jobOffers.some((o) => o.status === 'funded')) blockers.push('already_financed');
    else if (job.invoice_status === 'paid' || jobPayments.some((p) => p.status === 'paid')) blockers.push('already_paid');
    else if (jobOffers.some(isActiveOffer)) blockers.push('offer_active');

    const warnings: RowWarning[] = [];
    if (jobPayments.some((p) => OPEN_PAYMENT_STATUSES.includes(p.status))) warnings.push('open_payment_link');
    if (!job.customer_phone) warnings.push('needs_contact');

    rows.push({
      job,
      amountCents,
      quoteTotalCents: job.quote_id ? quoteTotals.get(job.quote_id) ?? null : null,
      blockers,
      warnings,
      eligible: blockers.length === 0,
    });
  }
  return rows.sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.amountCents - a.amountCents);
}

// ---------------------------------------------------------------- payments view

export interface OfferPaymentView { label: string; tone: Tone; hint: string }

export function offerPaymentView(offer: FinancingOffer, payments: PaymentRequest[]): OfferPaymentView {
  const jobPayments = offer.job_id ? payments.filter((p) => p.job_id === offer.job_id) : [];
  if (offer.status === 'funded') return { label: 'Paid via financing', tone: 'success', hint: 'Provider funded this job.' };
  if (offer.status === 'approved' || offer.status === 'loan_confirmed') {
    return { label: 'Awaiting funding', tone: 'accent', hint: 'Approved — payout follows once the loan is funded.' };
  }
  if (isActiveOffer(offer)) return { label: 'Awaiting customer', tone: 'accent', hint: 'The customer has not finished the application.' };
  if (jobPayments.some((p) => p.status === 'paid')) return { label: 'Paid by payment link', tone: 'success', hint: 'Collected through a payment request.' };
  if (jobPayments.some((p) => OPEN_PAYMENT_STATUSES.includes(p.status))) return { label: 'Payment link open', tone: 'warning', hint: 'Financing closed; a payment link is still pending.' };
  return { label: 'Needs another payment method', tone: 'danger', hint: 'Financing closed and nothing has been collected yet.' };
}

export function summarizePayments(payments: PaymentRequest[]): { paidCents: number; openCents: number; openCount: number } {
  let paidCents = 0;
  let openCents = 0;
  let openCount = 0;
  for (const p of payments) {
    const cents = Math.round(Number(p.amount) * 100) || 0;
    if (p.status === 'paid') paidCents += cents;
    else if (OPEN_PAYMENT_STATUSES.includes(p.status)) { openCents += cents; openCount += 1; }
  }
  return { paidCents, openCents, openCount };
}

// ---------------------------------------------------------------- data access

const JOB_COLUMNS =
  'id, customer_id, customer_name, customer_phone, service_type, job_status, invoice_amount, invoice_status, quote_id, scheduled_datetime, created_at';

export async function fetchFinancingCenterData(): Promise<FinancingCenterData> {
  const [connection, offers, jobsRes, quotesRes, payments] = await Promise.all([
    fetchFinancingConnection(),
    fetchFinancingOffers(),
    supabase.from('jobs').select(JOB_COLUMNS).order('created_at', { ascending: false }).limit(500),
    supabase.from('quotes').select('id, customer_name, line_items, tax_percent, status, created_at').eq('status', 'accepted').order('created_at', { ascending: false }).limit(500),
    fetchPaymentRequests().catch(() => [] as PaymentRequest[]),
  ]);
  if (jobsRes.error) throw jobsRes.error;
  return {
    connection,
    offers,
    jobs: (jobsRes.data ?? []) as unknown as FinancingJob[],
    quotes: quotesRes.error ? [] : ((quotesRes.data ?? []) as unknown as FinancingQuote[]),
    payments,
    loadedAt: new Date().toISOString(),
  };
}

export async function fetchOfferEvents(offerId: string): Promise<FinancingOfferEvent[]> {
  const { data, error } = await supabase
    .from('financing_offer_events')
    .select('id, offer_id, event_type, raw_payload, received_at')
    .eq('offer_id', offerId)
    .order('received_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as FinancingOfferEvent[];
}

/** Extracts the `{ error }` message from a failed edge-function call. */
export async function describeFinancingError(e: unknown): Promise<string> {
  if (e && typeof e === 'object') {
    const ctx = (e as { context?: unknown }).context;
    if (ctx instanceof Response) {
      try {
        const body = (await ctx.clone().json()) as { error?: unknown };
        if (typeof body?.error === 'string' && body.error) return body.error;
      } catch { /* fall through */ }
    }
    const msg = (e as { message?: unknown }).message;
    if (typeof msg === 'string' && msg) return msg;
  }
  return 'Something went wrong. Please try again.';
}
