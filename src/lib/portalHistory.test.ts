import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpc = vi.fn();
vi.mock('@/lib/supabase', () => ({ supabase: { rpc: (...args: unknown[]) => rpc(...args) } }));

import {
  fetchPortalHistory,
  filterInvoices,
  formatHistoryDate,
  groupServicesByYear,
  invoiceDisplayStatus,
  isInvoiceOverdue,
  isValidPortalToken,
  membershipPriceLabel,
  nextServiceDue,
  normalizeHistory,
  parseHistoryDate,
  warrantyStatus,
  type HistoryInvoice,
  type HistoryService,
} from './portalHistory';

const TOKEN = '3f2b8c1e-9a4d-4e7b-8c55-1a2b3c4d5e6f';
const NOW = new Date(2026, 9, 8, 15, 30); // Oct 8 2026, local

const inv = (over: Partial<HistoryInvoice>): HistoryInvoice => ({
  id: 'i1',
  invoice_number: 'INV-0001',
  invoice_token: 'tok',
  status: 'sent',
  total_cents: 10000,
  due_date: null,
  sent_at: null,
  paid_at: null,
  created_at: '2026-09-01T00:00:00Z',
  ...over,
});

const svc = (id: string, completed_at: string | null, created_at = '2020-01-01T12:00:00'): HistoryService => ({
  id,
  service_type: 'Tune-up',
  scheduled_datetime: null,
  completed_at,
  job_status: 'completed',
  invoice_amount: null,
  invoice_status: 'not_sent',
  created_at,
  equipment: [],
});

beforeEach(() => rpc.mockReset());

describe('isValidPortalToken', () => {
  it('accepts uuids and rejects everything else', () => {
    expect(isValidPortalToken(TOKEN)).toBe(true);
    expect(isValidPortalToken(TOKEN.toUpperCase())).toBe(true);
    expect(isValidPortalToken('not-a-uuid')).toBe(false);
    expect(isValidPortalToken('')).toBe(false);
    expect(isValidPortalToken(undefined)).toBe(false);
    expect(isValidPortalToken(`${TOKEN}; drop table customers`)).toBe(false);
  });
});

describe('fetchPortalHistory', () => {
  it('never hits the network for a malformed token', async () => {
    expect(await fetchPortalHistory('nope')).toEqual({ status: 'unavailable' });
    expect(await fetchPortalHistory(undefined)).toEqual({ status: 'unavailable' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('calls the RPC with the token and returns normalized data', async () => {
    rpc.mockResolvedValue({ data: { customer: { name: 'Ana Lee' }, summary: { completed_visits: '3' } }, error: null });
    const res = await fetchPortalHistory(TOKEN);
    expect(rpc).toHaveBeenCalledWith('get_customer_portal_history', { p_token: TOKEN });
    expect(res.status).toBe('ok');
    if (res.status === 'ok') {
      expect(res.data.summary.completed_visits).toBe(3);
      expect(res.data.services).toEqual([]);
      expect(res.data.invoices).toEqual([]);
      expect(res.data.memberships).toEqual([]);
      expect(res.data.equipment).toEqual([]);
    }
  });

  it('treats null (bad token OR portal disabled) as unavailable', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    expect(await fetchPortalHistory(TOKEN)).toEqual({ status: 'unavailable' });
  });

  it('distinguishes server errors and thrown failures from unavailable', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    expect(await fetchPortalHistory(TOKEN)).toEqual({ status: 'error' });
    rpc.mockRejectedValue(new Error('network down'));
    expect(await fetchPortalHistory(TOKEN)).toEqual({ status: 'error' });
  });
});

describe('normalizeHistory', () => {
  it('returns null for non-objects and tolerates garbage fields', () => {
    expect(normalizeHistory(null)).toBeNull();
    expect(normalizeHistory('x')).toBeNull();
    const n = normalizeHistory({ services: 'oops', invoices: { a: 1 }, summary: { total_paid_cents: 'abc' } });
    expect(n?.services).toEqual([]);
    expect(n?.invoices).toEqual([]);
    expect(n?.summary.total_paid_cents).toBe(0);
  });
});

describe('dates', () => {
  it('parses date-only strings as local dates (no off-by-one)', () => {
    const d = parseHistoryDate('2026-10-08');
    expect(d?.getFullYear()).toBe(2026);
    expect(d?.getMonth()).toBe(9);
    expect(d?.getDate()).toBe(8);
    expect(formatHistoryDate('2026-10-08')).toBe('Oct 8, 2026');
  });

  it('falls back for null and garbage', () => {
    expect(formatHistoryDate(null)).toBe('—');
    expect(formatHistoryDate('garbage', 'n/a')).toBe('n/a');
  });
});

describe('invoice status', () => {
  it('is overdue only after the due date has fully passed', () => {
    expect(isInvoiceOverdue(inv({ due_date: '2026-10-07' }), NOW)).toBe(true);
    expect(isInvoiceOverdue(inv({ due_date: '2026-10-08' }), NOW)).toBe(false);
    expect(isInvoiceOverdue(inv({ due_date: '2026-10-20' }), NOW)).toBe(false);
    expect(isInvoiceOverdue(inv({ due_date: null }), NOW)).toBe(false);
  });

  it('never marks paid or void invoices overdue', () => {
    expect(isInvoiceOverdue(inv({ status: 'paid', due_date: '2020-01-01' }), NOW)).toBe(false);
    expect(isInvoiceOverdue(inv({ status: 'void', due_date: '2020-01-01' }), NOW)).toBe(false);
  });

  it('maps to display statuses', () => {
    expect(invoiceDisplayStatus(inv({ status: 'paid' }), NOW)).toBe('paid');
    expect(invoiceDisplayStatus(inv({ status: 'void' }), NOW)).toBe('void');
    expect(invoiceDisplayStatus(inv({ status: 'viewed', due_date: '2026-10-01' }), NOW)).toBe('overdue');
    expect(invoiceDisplayStatus(inv({ status: 'sent' }), NOW)).toBe('due');
  });

  it('filters', () => {
    const list = [inv({ id: 'a', status: 'sent' }), inv({ id: 'b', status: 'viewed' }), inv({ id: 'c', status: 'paid' }), inv({ id: 'd', status: 'void' })];
    expect(filterInvoices(list, 'all')).toHaveLength(4);
    expect(filterInvoices(list, 'outstanding').map((i) => i.id)).toEqual(['a', 'b']);
    expect(filterInvoices(list, 'paid').map((i) => i.id)).toEqual(['c']);
  });
});

describe('groupServicesByYear', () => {
  it('groups consecutive items by year and preserves order', () => {
    const groups = groupServicesByYear([
      svc('a', '2026-06-01T12:00:00'),
      svc('b', '2026-01-15T12:00:00'),
      svc('c', '2025-11-03T12:00:00'),
    ]);
    expect(groups.map((g) => g.year)).toEqual(['2026', '2025']);
    expect(groups[0].items.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('returns no groups for an empty list', () => {
    expect(groupServicesByYear([])).toEqual([]);
  });
});

describe('equipment', () => {
  it('computes next service from last service, falling back to install date', () => {
    const base = { status: 'active' as const, service_interval_months: 12, install_date: null, last_service_date: null };
    const a = nextServiceDue({ ...base, last_service_date: '2025-10-08' });
    expect(a && [a.getFullYear(), a.getMonth(), a.getDate()]).toEqual([2026, 9, 8]);
    const b = nextServiceDue({ ...base, install_date: '2025-03-01' });
    expect(b && [b.getFullYear(), b.getMonth(), b.getDate()]).toEqual([2026, 2, 1]);
  });

  it('returns null when it cannot or should not be computed', () => {
    const base = { status: 'active' as const, service_interval_months: 12, install_date: null, last_service_date: null };
    expect(nextServiceDue(base)).toBeNull();
    expect(nextServiceDue({ ...base, last_service_date: '2025-01-01', status: 'replaced' })).toBeNull();
    expect(nextServiceDue({ ...base, last_service_date: '2025-01-01', service_interval_months: 0 })).toBeNull();
  });

  it('classifies warranty windows', () => {
    expect(warrantyStatus(null, NOW).tone).toBe('ok');
    expect(warrantyStatus('2026-10-07', NOW).tone).toBe('expired');
    expect(warrantyStatus('2026-10-08', NOW).tone).toBe('warn');
    expect(warrantyStatus('2026-12-01', NOW).tone).toBe('warn');
    expect(warrantyStatus('2027-06-01', NOW).tone).toBe('ok');
  });
});

describe('membershipPriceLabel', () => {
  it('formats price with interval', () => {
    expect(membershipPriceLabel({ price_cents: 19900, billing_interval: 'yearly' })).toBe('$199.00 / year');
    expect(membershipPriceLabel({ price_cents: 1500, billing_interval: 'monthly' })).toBe('$15.00 / month');
    expect(membershipPriceLabel({ price_cents: null, billing_interval: 'yearly' })).toBeNull();
  });
});
