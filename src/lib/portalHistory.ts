import { supabase } from '@/lib/supabase';

/**
 * Customer Portal — Full History (/portal/:token/history) — client library.
 *
 * Same security model as `lib/customerPortal.ts`: one narrow SECURITY DEFINER
 * RPC (`get_customer_portal_history`, see
 * supabase/migrations/20270501000000_portal_history.sql) validates the
 * portal token server-side. RLS is never opened to anon.
 */

// ============================================================
// TYPES
// ============================================================

export type HistoryJobStatus = 'scheduled' | 'en_route' | 'in_progress' | 'completed' | 'cancelled' | 'no_show';
export type HistoryInvoiceStatus = 'sent' | 'viewed' | 'paid' | 'void';
export type HistoryMembershipStatus = 'offered' | 'active' | 'cancelled';

export interface HistoryService {
  id: string;
  service_type: string | null;
  scheduled_datetime: string | null;
  completed_at: string | null;
  job_status: HistoryJobStatus;
  invoice_amount: number | null;
  invoice_status: 'not_sent' | 'sent' | 'paid';
  created_at: string;
  equipment: { id: string; label: string }[];
}

export interface HistoryInvoice {
  id: string;
  invoice_number: string | null;
  invoice_token: string;
  status: HistoryInvoiceStatus;
  total_cents: number | null;
  due_date: string | null;
  sent_at: string | null;
  paid_at: string | null;
  created_at: string;
}

export interface HistoryMembership {
  id: string;
  status: HistoryMembershipStatus;
  offered_at: string | null;
  started_at: string | null;
  cancelled_at: string | null;
  plan_name: string | null;
  price_cents: number | null;
  billing_interval: 'monthly' | 'yearly' | null;
  benefits: string[] | null;
}

export interface HistoryEquipment {
  id: string;
  equipment_type: string;
  make: string | null;
  model: string | null;
  status: 'active' | 'replaced' | 'removed';
  install_date: string | null;
  warranty_expires_at: string | null;
  last_service_date: string | null;
  service_interval_months: number | null;
  service_count: number;
}

export interface HistorySummary {
  completed_visits: number;
  total_paid_cents: number;
  outstanding_cents: number;
  outstanding_count: number;
  total_services: number;
  total_invoices: number;
}

export interface PortalHistory {
  customer: { name: string; customer_since: string | null };
  business_name: string | null;
  summary: HistorySummary;
  services: HistoryService[];
  invoices: HistoryInvoice[];
  memberships: HistoryMembership[];
  equipment: HistoryEquipment[];
}

/**
 * Three distinct outcomes on purpose:
 *  - `unavailable`: bad token OR portal disabled (indistinguishable by design,
 *    same as fetchPortalBundle) — retrying will not help.
 *  - `error`: transport/server failure — retrying may help.
 */
export type PortalHistoryResult =
  | { status: 'ok'; data: PortalHistory }
  | { status: 'unavailable' }
  | { status: 'error' };

// ============================================================
// FETCH
// ============================================================

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidPortalToken(token: string | undefined | null): token is string {
  return typeof token === 'string' && UUID_RE.test(token);
}

export function getPortalHistoryLink(token: string): string {
  return `${window.location.origin}/portal/${token}/history`;
}

export function getInvoiceLink(invoiceToken: string): string {
  return `/invoice/${invoiceToken}`;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function asNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Defensive: never trust the wire shape enough to crash the page on `.map`. */
export function normalizeHistory(raw: unknown): PortalHistory | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const customer = (r.customer ?? {}) as Record<string, unknown>;
  const summary = (r.summary ?? {}) as Record<string, unknown>;

  return {
    customer: {
      name: typeof customer.name === 'string' ? customer.name : '',
      customer_since: typeof customer.customer_since === 'string' ? customer.customer_since : null,
    },
    business_name: typeof r.business_name === 'string' ? r.business_name : null,
    summary: {
      completed_visits: asNumber(summary.completed_visits),
      total_paid_cents: asNumber(summary.total_paid_cents),
      outstanding_cents: asNumber(summary.outstanding_cents),
      outstanding_count: asNumber(summary.outstanding_count),
      total_services: asNumber(summary.total_services),
      total_invoices: asNumber(summary.total_invoices),
    },
    services: asArray<HistoryService>(r.services).map((s) => ({ ...s, equipment: asArray(s.equipment) })),
    invoices: asArray<HistoryInvoice>(r.invoices),
    memberships: asArray<HistoryMembership>(r.memberships),
    equipment: asArray<HistoryEquipment>(r.equipment).map((e) => ({ ...e, service_count: asNumber(e.service_count) })),
  };
}

export async function fetchPortalHistory(token: string | undefined): Promise<PortalHistoryResult> {
  // A malformed token can never match; skip the network round-trip entirely.
  if (!isValidPortalToken(token)) return { status: 'unavailable' };
  try {
    const { data, error } = await supabase.rpc('get_customer_portal_history', { p_token: token });
    if (error) return { status: 'error' };
    if (!data) return { status: 'unavailable' };
    const normalized = normalizeHistory(data);
    return normalized ? { status: 'ok', data: normalized } : { status: 'error' };
  } catch {
    return { status: 'error' };
  }
}

// ============================================================
// DATE / MONEY HELPERS
// ============================================================

/**
 * Date-only strings ("2026-10-08", Postgres `date`) are parsed as LOCAL dates.
 * `new Date('2026-10-08')` is UTC midnight and renders as the previous day for
 * every viewer west of UTC — wrong for due dates and warranty dates.
 */
export function parseHistoryDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatHistoryDate(value: string | null | undefined, fallback = '—'): string {
  const d = parseHistoryDate(value);
  if (!d) return fallback;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function serviceDate(s: Pick<HistoryService, 'completed_at' | 'scheduled_datetime' | 'created_at'>): string {
  return s.completed_at ?? s.scheduled_datetime ?? s.created_at;
}

// ============================================================
// INVOICES
// ============================================================

export type InvoiceDisplayStatus = 'paid' | 'due' | 'overdue' | 'void';
export type InvoiceFilter = 'all' | 'outstanding' | 'paid';

export function isInvoiceOverdue(inv: Pick<HistoryInvoice, 'status' | 'due_date'>, now: Date = new Date()): boolean {
  if (inv.status !== 'sent' && inv.status !== 'viewed') return false;
  const due = parseHistoryDate(inv.due_date);
  if (!due) return false;
  // Due dates are inclusive: an invoice due today is not overdue until tomorrow.
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return due.getTime() < startOfToday.getTime();
}

export function invoiceDisplayStatus(inv: HistoryInvoice, now: Date = new Date()): InvoiceDisplayStatus {
  if (inv.status === 'paid') return 'paid';
  if (inv.status === 'void') return 'void';
  return isInvoiceOverdue(inv, now) ? 'overdue' : 'due';
}

export const INVOICE_DISPLAY_LABELS: Record<InvoiceDisplayStatus, string> = {
  paid: 'Paid',
  due: 'Payment due',
  overdue: 'Overdue',
  void: 'Void',
};

export function filterInvoices(invoices: HistoryInvoice[], filter: InvoiceFilter): HistoryInvoice[] {
  if (filter === 'paid') return invoices.filter((i) => i.status === 'paid');
  if (filter === 'outstanding') return invoices.filter((i) => i.status === 'sent' || i.status === 'viewed');
  return invoices;
}

// ============================================================
// SERVICES
// ============================================================

export const HISTORY_JOB_STATUS_LABELS: Record<HistoryJobStatus, string> = {
  scheduled: 'Scheduled',
  en_route: 'Technician en route',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
  no_show: 'Missed visit',
};

/** Preserves input order (server already sorts newest-first); groups by calendar year. */
export function groupServicesByYear(services: HistoryService[]): { year: string; items: HistoryService[] }[] {
  const groups: { year: string; items: HistoryService[] }[] = [];
  for (const s of services) {
    const d = parseHistoryDate(serviceDate(s));
    const year = d ? String(d.getFullYear()) : 'Undated';
    const last = groups[groups.length - 1];
    if (last && last.year === year) last.items.push(s);
    else groups.push({ year, items: [s] });
  }
  return groups;
}

// ============================================================
// EQUIPMENT
// ============================================================

/** last_service_date + interval; null when there is nothing to base it on. */
export function nextServiceDue(eq: Pick<HistoryEquipment, 'last_service_date' | 'install_date' | 'service_interval_months' | 'status'>): Date | null {
  if (eq.status !== 'active' || !eq.service_interval_months || eq.service_interval_months <= 0) return null;
  const base = parseHistoryDate(eq.last_service_date) ?? parseHistoryDate(eq.install_date);
  if (!base) return null;
  const due = new Date(base.getFullYear(), base.getMonth() + eq.service_interval_months, base.getDate());
  return due;
}

export function warrantyStatus(
  expiresAt: string | null,
  now: Date = new Date(),
): { label: string; tone: 'ok' | 'warn' | 'expired' } {
  const exp = parseHistoryDate(expiresAt);
  if (!exp) return { label: 'No warranty on file', tone: 'ok' };
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((exp.getTime() - startOfToday.getTime()) / 86400000);
  if (days < 0) return { label: `Expired ${formatHistoryDate(expiresAt)}`, tone: 'expired' };
  if (days <= 60) return { label: `Expires ${formatHistoryDate(expiresAt)}`, tone: 'warn' };
  return { label: `Covered until ${formatHistoryDate(expiresAt)}`, tone: 'ok' };
}

export function equipmentTitle(eq: Pick<HistoryEquipment, 'make' | 'model' | 'equipment_type'>): string {
  return [eq.make, eq.model].filter(Boolean).join(' ') || eq.equipment_type;
}

// ============================================================
// MEMBERSHIP
// ============================================================

export const MEMBERSHIP_STATUS_LABELS: Record<HistoryMembershipStatus, string> = {
  active: 'Active',
  offered: 'Offered',
  cancelled: 'Cancelled',
};

export function membershipPriceLabel(m: Pick<HistoryMembership, 'price_cents' | 'billing_interval'>): string | null {
  if (m.price_cents === null || m.price_cents === undefined) return null;
  const amount = (m.price_cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  if (m.billing_interval === 'monthly') return `${amount} / month`;
  if (m.billing_interval === 'yearly') return `${amount} / year`;
  return amount;
}
