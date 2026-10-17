/**
 * Payment Plans — pure domain helpers (no I/O). The schedule builder mirrors create_payment_plan() in SQL so the
 * form can preview exactly what the server will create; the server remains the source of truth.
 */

export type PlanTone = 'neutral' | 'accent' | 'success' | 'danger' | 'warning';
export type PlanFrequency = 'weekly' | 'biweekly' | 'monthly';
export type LateFeeType = 'none' | 'flat' | 'percent';

export interface PlanRow {
  id: string;
  user_id: string;
  job_id: string | null;
  customer_name: string;
  customer_email: string | null;
  customer_phone: string | null;
  currency: string;
  total_cents: number;
  deposit_cents: number;
  installment_count: number;
  frequency: PlanFrequency;
  first_due_date: string;
  late_fee_type: LateFeeType;
  late_fee_value: number;
  late_fee_cap_cents: number;
  grace_days: number;
  auto_charge: boolean;
  max_charge_attempts: number;
  retry_interval_days: number;
  status: 'draft' | 'pending_authorization' | 'active' | 'paused' | 'completed' | 'canceled';
  authorization_url: string | null;
  authorization_sent_at: string | null;
  terms_text: string | null;
  terms_accepted_at: string | null;
  stripe_payment_method_id: string | null;
  notes: string | null;
  created_at: string;
  canceled_at: string | null;
  payment_plan_installments?: InstallmentRow[];
}

export interface InstallmentRow {
  id: string;
  plan_id: string;
  seq: number;
  kind: 'deposit' | 'installment';
  amount_cents: number;
  late_fee_cents: number;
  due_date: string;
  status: 'scheduled' | 'processing' | 'requires_action' | 'failed' | 'paid' | 'waived' | 'canceled';
  attempt_count: number;
  next_attempt_at: string | null;
  paid_at: string | null;
  paid_cents: number;
  payment_method: 'stripe' | 'offline' | null;
  last_error: string | null;
}

export interface PlanEventRow { id: string; type: string; detail: Record<string, unknown>; created_at: string }

export interface PlanStats {
  active_plans: number;
  awaiting_approval: number;
  outstanding_cents: number;
  overdue_cents: number;
  overdue_count: number;
  due_7d_cents: number;
  collected_30d_cents: number;
  late_fees_assessed_cents: number;
  failed_charges: number;
}

export const TONE_CLASS: Record<PlanTone, string> = {
  neutral: 'bg-bg-tertiary text-text-secondary border-border',
  accent: 'bg-accent/10 text-accent border-accent/25',
  success: 'bg-success/10 text-success border-success/25',
  danger: 'bg-danger/10 text-danger border-danger/25',
  warning: 'bg-warning-500/10 text-warning-500 border-warning-500/25',
};

export const PLAN_STATUS_META: Record<PlanRow['status'], { label: string; tone: PlanTone }> = {
  draft: { label: 'Not sent', tone: 'neutral' },
  pending_authorization: { label: 'Awaiting approval', tone: 'warning' },
  active: { label: 'Active', tone: 'accent' },
  paused: { label: 'Paused', tone: 'neutral' },
  completed: { label: 'Completed', tone: 'success' },
  canceled: { label: 'Canceled', tone: 'neutral' },
};

export const INSTALLMENT_STATUS_META: Record<InstallmentRow['status'], { label: string; tone: PlanTone }> = {
  scheduled: { label: 'Scheduled', tone: 'neutral' },
  processing: { label: 'Processing', tone: 'accent' },
  requires_action: { label: 'Needs customer', tone: 'warning' },
  failed: { label: 'Failed', tone: 'danger' },
  paid: { label: 'Paid', tone: 'success' },
  waived: { label: 'Waived', tone: 'neutral' },
  canceled: { label: 'Canceled', tone: 'neutral' },
};

export const FREQUENCY_LABEL: Record<PlanFrequency, string> = { weekly: 'Weekly', biweekly: 'Every 2 weeks', monthly: 'Monthly' };

// ---------------------------------------------------------------- money & dates

export function formatMoney(cents: number, currency = 'usd'): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

/** "1,250.5" -> 125050. Returns null for anything that is not a plain positive-or-zero money amount. */
export function dollarsToCents(input: string): number | null {
  const cleaned = input.replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(parseFloat(cleaned) * 100);
}

const DAY = 86_400_000;
const parseDay = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const todayIso = (now = Date.now()) => isoDay(now);
export const addDays = (iso: string, n: number) => isoDay(parseDay(iso) + n * DAY);

/** Month arithmetic with end-of-month clamping — identical to Postgres `date + interval 'n month'`. */
export function addMonths(iso: string, n: number): string {
  const d = new Date(parseDay(iso));
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + n, day = d.getUTCDate();
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return isoDay(Date.UTC(y, m, Math.min(day, last)));
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((parseDay(toIso) - parseDay(fromIso)) / DAY);
}

// ---------------------------------------------------------------- schedule

export interface PlanInput {
  total_cents: number;
  deposit_cents: number;
  installment_count: number;
  frequency: PlanFrequency;
  first_due_date: string;
  late_fee_type: LateFeeType;
  late_fee_value: number;
  late_fee_cap_cents: number;
  grace_days: number;
  auto_charge: boolean;
}

export interface ScheduleItem { seq: number; kind: 'deposit' | 'installment'; amount_cents: number; due_date: string }

/** The remainder cents go to the earliest installments (+1 cent each), so the parts always sum to the total. */
export function buildSchedule(input: Pick<PlanInput, 'total_cents' | 'deposit_cents' | 'installment_count' | 'frequency' | 'first_due_date'>, today = todayIso()): ScheduleItem[] {
  const { total_cents, deposit_cents, installment_count: n, frequency, first_due_date } = input;
  const rem = total_cents - deposit_cents;
  if (!(n >= 1) || rem <= 0) return [];
  const base = Math.floor(rem / n);
  const extra = rem % n;
  const items: ScheduleItem[] = [];
  if (deposit_cents > 0) items.push({ seq: 0, kind: 'deposit', amount_cents: deposit_cents, due_date: today });
  for (let i = 1; i <= n; i++) {
    items.push({
      seq: i, kind: 'installment', amount_cents: base + (i <= extra ? 1 : 0),
      due_date: frequency === 'weekly' ? addDays(first_due_date, (i - 1) * 7) : frequency === 'biweekly' ? addDays(first_due_date, (i - 1) * 14) : addMonths(first_due_date, i - 1),
    });
  }
  return items;
}

export function lateFeeFor(rule: Pick<PlanInput, 'late_fee_type' | 'late_fee_value' | 'late_fee_cap_cents'>, amountCents: number): number {
  if (rule.late_fee_type === 'none') return 0;
  let fee = rule.late_fee_type === 'flat' ? Math.round(rule.late_fee_value) : Math.round((amountCents * rule.late_fee_value) / 100);
  if (rule.late_fee_cap_cents > 0) fee = Math.min(fee, rule.late_fee_cap_cents);
  return Math.max(0, fee);
}

export const MIN_INSTALLMENT_CENTS = 500;
export const MAX_TOTAL_CENTS = 100_000_000;

/** Same rules the RPC enforces, as field-level messages. Empty object = valid. */
export function validatePlanInput(
  input: PlanInput & { customer_name: string; customer_email: string; customer_phone: string },
  today = todayIso(),
): Record<string, string> {
  const e: Record<string, string> = {};
  if (!input.customer_name.trim()) e.customer_name = 'Enter the customer name.';
  if (!input.customer_email.trim() && !input.customer_phone.trim()) e.contact = 'Add an email or phone number so we can send the plan.';
  if (input.customer_email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.customer_email.trim())) e.customer_email = 'Enter a valid email address.';
  if (!(input.total_cents > 0)) e.total = 'Enter the total amount.';
  else if (input.total_cents > MAX_TOTAL_CENTS) e.total = 'That total is too large.';
  if (input.deposit_cents < 0 || input.deposit_cents >= input.total_cents) e.deposit = 'The deposit must be less than the total.';
  if (!Number.isInteger(input.installment_count) || input.installment_count < 1 || input.installment_count > 24) e.count = 'Choose 1 to 24 installments.';
  if (!input.first_due_date || input.first_due_date < today) e.first_due_date = 'The first due date cannot be in the past.';
  if (input.deposit_cents === 0 && !input.auto_charge) e.auto_charge = 'Without a deposit, auto-charge must be on so a card is saved.';

  const sched = !e.total && !e.deposit && !e.count ? buildSchedule(input, today).filter((s) => s.kind === 'installment') : [];
  const min = sched.length ? Math.min(...sched.map((s) => s.amount_cents)) : 0;
  if (sched.length && min < MIN_INSTALLMENT_CENTS) e.count = `Each installment must be at least ${formatMoney(MIN_INSTALLMENT_CENTS)}. Use fewer installments.`;
  if (input.late_fee_type === 'percent' && (input.late_fee_value <= 0 || input.late_fee_value > 25)) e.late_fee = 'Enter a percentage between 0 and 25.';
  if (input.late_fee_type === 'flat') {
    if (input.late_fee_value <= 0) e.late_fee = 'Enter the late fee amount.';
    else if (min > 0 && input.late_fee_value > min * 0.25) e.late_fee = `A flat fee can be at most ${formatMoney(Math.floor(min * 0.25))} (25% of the smallest installment).`;
  }
  if (input.grace_days < 0 || input.grace_days > 30) e.grace_days = 'Grace period must be 0 to 30 days.';
  return e;
}

// ---------------------------------------------------------------- display helpers

export const OPEN_STATUSES: InstallmentRow['status'][] = ['scheduled', 'processing', 'requires_action', 'failed'];
const isOpen = (i: Pick<InstallmentRow, 'status'>) => OPEN_STATUSES.includes(i.status);

export function installmentDue(i: Pick<InstallmentRow, 'amount_cents' | 'late_fee_cents'>): number {
  return i.amount_cents + i.late_fee_cents;
}

export function planProgress(items: InstallmentRow[]): { paidCents: number; totalCents: number; pct: number; next: InstallmentRow | null } {
  const live = items.filter((i) => i.status !== 'canceled' && i.status !== 'waived');
  const total = live.reduce((s, i) => s + i.amount_cents, 0);
  const paid = live.filter((i) => i.status === 'paid').reduce((s, i) => s + i.amount_cents, 0);
  const next = items.filter(isOpen).sort((a, b) => a.due_date.localeCompare(b.due_date) || a.seq - b.seq)[0] ?? null;
  return { paidCents: paid, totalCents: total, pct: total === 0 ? 0 : Math.round((paid / total) * 100), next };
}

export function isInstallmentOverdue(i: InstallmentRow, today = todayIso()): boolean {
  return i.status !== 'processing' && isOpen(i) && i.due_date < today;
}

export function planHasOverdue(items: InstallmentRow[], today = todayIso()): boolean {
  return items.some((i) => isInstallmentOverdue(i, today));
}

export function dueLabel(i: InstallmentRow, today = todayIso()): { label: string; tone: PlanTone } {
  if (i.status === 'paid') return { label: i.paid_at ? `Paid ${i.paid_at.slice(0, 10)}` : 'Paid', tone: 'success' };
  if (!isOpen(i)) return { label: INSTALLMENT_STATUS_META[i.status].label, tone: 'neutral' };
  const d = daysBetween(today, i.due_date);
  if (d < 0) return { label: `${-d} day${d === -1 ? '' : 's'} overdue`, tone: 'danger' };
  if (d === 0) return { label: 'Due today', tone: 'warning' };
  return { label: d === 1 ? 'Due tomorrow' : `Due in ${d} days`, tone: 'neutral' };
}

export type PlanTab = 'all' | 'approval' | 'active' | 'overdue' | 'completed' | 'canceled';

export function matchesPlanTab(plan: PlanRow, tab: PlanTab, today = todayIso()): boolean {
  const items = plan.payment_plan_installments ?? [];
  switch (tab) {
    case 'approval': return plan.status === 'draft' || plan.status === 'pending_authorization';
    case 'active': return plan.status === 'active' || plan.status === 'paused';
    case 'overdue': return (plan.status === 'active' || plan.status === 'paused') && planHasOverdue(items, today);
    case 'completed': return plan.status === 'completed';
    case 'canceled': return plan.status === 'canceled';
    default: return true;
  }
}

/** Filter + sort: plans with overdue money first, then those awaiting approval, then newest. */
export function filterPlans(plans: PlanRow[], tab: PlanTab, query: string, today = todayIso()): PlanRow[] {
  const q = query.trim().toLowerCase();
  const rank = (p: PlanRow) => (matchesPlanTab(p, 'overdue', today) ? 0 : matchesPlanTab(p, 'approval', today) ? 1 : 2);
  return plans
    .filter((p) => matchesPlanTab(p, tab, today))
    .filter((p) => !q || [p.customer_name, p.customer_email, p.customer_phone].some((v) => (v ?? '').toLowerCase().includes(q)))
    .sort((a, b) => rank(a) - rank(b) || b.created_at.localeCompare(a.created_at));
}

export const EVENT_LABELS: Record<string, string> = {
  plan_created: 'Plan created',
  authorization_sent: 'Approval link sent to customer',
  customer_approved: 'Customer approved the plan',
  payment_succeeded: 'Payment received',
  payment_failed: 'Payment failed',
  payment_requires_action: 'Customer must confirm a payment',
  late_fee_assessed: 'Late fee applied',
  late_fee_waived: 'Late fee waived',
  offline_payment_recorded: 'Offline payment recorded',
  plan_completed: 'Plan completed',
  plan_pause: 'Plan paused',
  plan_resume: 'Plan resumed',
  plan_cancel: 'Plan canceled',
};
