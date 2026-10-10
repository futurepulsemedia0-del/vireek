import { describe, it, expect } from 'vitest';
import type { FinancingOffer } from '@/lib/financing';
import type { PaymentRequest } from '@/lib/payments';
import { buildEligibility, computeAnalytics, filterOffers, offerPaymentView, offersToCsv, type FinancingJob } from './financingCenter';

const offer = (p: Partial<FinancingOffer>): FinancingOffer => ({
  id: 'o1', job_id: 'j1', provider: 'wisetack', customer_name: 'Ann', customer_email: null, customer_phone: null,
  requested_amount_cents: 100000, approved_amount_cents: null, apr_bps: null, term_months: null, status: 'sent',
  application_url: 'https://x.test', decline_reason: null, created_at: '2026-09-01T00:00:00Z', funded_at: null, ...p,
});
const job = (p: Partial<FinancingJob>): FinancingJob => ({
  id: 'j1', customer_id: null, customer_name: 'Ann', customer_phone: '555', service_type: 'HVAC', job_status: 'completed',
  invoice_amount: 1000, invoice_status: 'sent', quote_id: null, scheduled_datetime: null, created_at: '2026-09-01T00:00:00Z', ...p,
});
const pay = (p: Partial<PaymentRequest>): PaymentRequest => ({
  id: 'p1', job_id: 'j1', customer_name: 'Ann', customer_email: null, customer_phone: null, amount: 1000,
  status: 'sent', payment_link_url: null, reminder_count: 0, paid_at: null, created_at: '2026-09-01T00:00:00Z', ...p,
});

describe('computeAnalytics', () => {
  it('computes funnel, rates and weighted APR', () => {
    const a = computeAnalytics([
      offer({ id: 'a', status: 'funded', approved_amount_cents: 100000, apr_bps: 1000, term_months: 12, funded_at: '2026-09-03T00:00:00Z' }),
      offer({ id: 'b', status: 'declined', decline_reason: 'Low score' }),
      offer({ id: 'c', status: 'sent' }),
    ], new Date('2026-09-10T00:00:00Z'));
    expect(a.offered).toBe(3);
    expect(a.funded).toBe(1);
    expect(a.approvalRate).toBeCloseTo(0.5);
    expect(a.conversionRate).toBeCloseTo(1 / 3);
    expect(a.avgAprBps).toBe(1000);
    expect(a.avgDaysToFund).toBeCloseTo(2);
    expect(a.declineReasons[0]).toEqual({ reason: 'Low score', count: 1 });
  });
  it('returns nulls with no data', () => {
    const a = computeAnalytics([]);
    expect(a.approvalRate).toBeNull();
    expect(a.avgAprBps).toBeNull();
  });
});

describe('buildEligibility', () => {
  const base = { offers: [], payments: [], quotes: [], connected: true };
  it('marks a normal unpaid job eligible', () => {
    expect(buildEligibility({ ...base, jobs: [job({})] })[0].eligible).toBe(true);
  });
  it('blocks small, paid and in-progress jobs', () => {
    expect(buildEligibility({ ...base, jobs: [job({ invoice_amount: 100 })] })[0].blockers).toContain('below_minimum');
    expect(buildEligibility({ ...base, jobs: [job({ invoice_status: 'paid' })] })[0].blockers).toContain('already_paid');
    expect(buildEligibility({ ...base, jobs: [job({})], offers: [offer({})] })[0].blockers).toContain('offer_active');
  });
  it('blocks everything when not connected and skips cancelled jobs', () => {
    expect(buildEligibility({ ...base, connected: false, jobs: [job({})] })[0].blockers).toContain('not_connected');
    expect(buildEligibility({ ...base, jobs: [job({ job_status: 'cancelled' })] })).toHaveLength(0);
  });
  it('warns about an open payment link', () => {
    expect(buildEligibility({ ...base, jobs: [job({})], payments: [pay({})] })[0].warnings).toContain('open_payment_link');
  });
});

describe('helpers', () => {
  it('filters by status and query', () => {
    const list = [offer({ id: 'a', status: 'funded' }), offer({ id: 'b', customer_name: 'Bob', status: 'declined' })];
    expect(filterOffers(list, 'funded', '')).toHaveLength(1);
    expect(filterOffers(list, 'all', 'bob')).toHaveLength(1);
    expect(filterOffers(list, 'closed', '')[0].id).toBe('b');
  });
  it('falls back to payment-link state when financing closed', () => {
    const o = offer({ status: 'declined' });
    expect(offerPaymentView(o, [pay({ status: 'paid' })]).label).toBe('Paid by payment link');
    expect(offerPaymentView(o, []).tone).toBe('danger');
  });
  it('neutralises CSV formula injection', () => {
    expect(offersToCsv([offer({ customer_name: '=SUM(A1)' })])).toContain("'=SUM(A1)");
  });
});
