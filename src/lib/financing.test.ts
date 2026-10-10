import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/lib/supabase', () => ({ supabase: { rpc } }));

import {
  estimateMonthlyPaymentCents,
  fetchPublicFinancingOffer,
  formatFinancingAmount,
  getPublicFinancingPhase,
  getPublicFinancingSteps,
  isPublicFinancingPhaseFinal,
  isSafeApplicationUrl,
  type FinancingOfferStatus,
  type PublicFinancingOffer,
} from './financing';

const TOKEN = '3f2b8c1e-9a4d-4e57-8f0a-1c2d3e4f5a6b';

const OFFER: PublicFinancingOffer = {
  business_name: 'Cool Air HVAC',
  service_type: 'AC Repair',
  customer_first_name: 'Dana',
  status: 'sent',
  requested_amount_cents: 120000,
  approved_amount_cents: null,
  apr_bps: null,
  term_months: null,
  application_url: 'https://pay.example.com/apply/abc',
  created_at: '2026-10-08T10:00:00Z',
  updated_at: '2026-10-08T10:00:00Z',
};

describe('getPublicFinancingPhase', () => {
  const cases: [FinancingOfferStatus, string][] = [
    ['created', 'preparing'],
    ['sent', 'ready'],
    ['clicked', 'ready'],
    ['applied', 'in_review'],
    ['approved', 'approved'],
    ['loan_confirmed', 'confirmed'],
    ['funded', 'confirmed'],
    ['declined', 'declined'],
    ['expired', 'closed'],
    ['canceled', 'closed'],
  ];
  it.each(cases)('maps %s to %s', (status, phase) => {
    expect(getPublicFinancingPhase(status)).toBe(phase);
  });

  it('treats only confirmed, declined and closed as final', () => {
    expect(isPublicFinancingPhaseFinal('confirmed')).toBe(true);
    expect(isPublicFinancingPhaseFinal('declined')).toBe(true);
    expect(isPublicFinancingPhaseFinal('closed')).toBe(true);
    expect(isPublicFinancingPhaseFinal('preparing')).toBe(false);
    expect(isPublicFinancingPhaseFinal('ready')).toBe(false);
    expect(isPublicFinancingPhaseFinal('in_review')).toBe(false);
    expect(isPublicFinancingPhaseFinal('approved')).toBe(false);
  });
});

describe('getPublicFinancingSteps', () => {
  it('advances one step at a time', () => {
    expect(getPublicFinancingSteps('ready')).toEqual(['done', 'current', 'todo', 'todo']);
    expect(getPublicFinancingSteps('in_review')).toEqual(['done', 'done', 'current', 'todo']);
    expect(getPublicFinancingSteps('approved')).toEqual(['done', 'done', 'done', 'current']);
    expect(getPublicFinancingSteps('confirmed')).toEqual(['done', 'done', 'done', 'done']);
  });
  it('marks the decision step failed when declined and hides the tracker when closed', () => {
    expect(getPublicFinancingSteps('declined')).toEqual(['done', 'done', 'failed', 'todo']);
    expect(getPublicFinancingSteps('closed')).toEqual([]);
  });
});

describe('isSafeApplicationUrl', () => {
  it('accepts https only', () => {
    expect(isSafeApplicationUrl('https://pay.example.com/apply/abc')).toBe(true);
    expect(isSafeApplicationUrl('http://pay.example.com/apply/abc')).toBe(false);
    expect(isSafeApplicationUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeApplicationUrl('not a url')).toBe(false);
    expect(isSafeApplicationUrl('')).toBe(false);
    expect(isSafeApplicationUrl(null)).toBe(false);
    expect(isSafeApplicationUrl(undefined)).toBe(false);
  });
});

describe('estimateMonthlyPaymentCents', () => {
  it('amortises with interest', () => {
    // $1,000 at 12% APR over 12 months is about $88.85 / month.
    expect(estimateMonthlyPaymentCents(100000, 1200, 12)).toBe(8885);
  });
  it('splits evenly at 0% APR', () => {
    expect(estimateMonthlyPaymentCents(120000, 0, 12)).toBe(10000);
  });
  it('returns null for missing or invalid inputs', () => {
    expect(estimateMonthlyPaymentCents(100000, null, 12)).toBeNull();
    expect(estimateMonthlyPaymentCents(100000, 1200, null)).toBeNull();
    expect(estimateMonthlyPaymentCents(0, 1200, 12)).toBeNull();
    expect(estimateMonthlyPaymentCents(-5, 1200, 12)).toBeNull();
    expect(estimateMonthlyPaymentCents(100000, -1, 12)).toBeNull();
    expect(estimateMonthlyPaymentCents(100000, 1200, 0)).toBeNull();
    expect(estimateMonthlyPaymentCents(100000, 1200, 12.5)).toBeNull();
    expect(estimateMonthlyPaymentCents(Number.NaN, 1200, 12)).toBeNull();
  });
});

describe('formatFinancingAmount', () => {
  it('formats cents as US dollars', () => {
    expect(formatFinancingAmount(120000)).toBe('$1,200.00');
    expect(formatFinancingAmount(8885)).toBe('$88.85');
  });
});

describe('fetchPublicFinancingOffer', () => {
  beforeEach(() => {
    rpc.mockReset();
  });

  it('does not call the server for a malformed token', async () => {
    expect(await fetchPublicFinancingOffer('nope')).toEqual({ state: 'not_found' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('returns the offer for a valid token', async () => {
    rpc.mockResolvedValue({ data: OFFER, error: null });
    const result = await fetchPublicFinancingOffer(TOKEN);
    expect(rpc).toHaveBeenCalledWith('get_public_financing_offer', { p_token: TOKEN });
    expect(result).toEqual({ state: 'ok', offer: OFFER });
  });

  it('returns not_found when the server has no matching offer', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    expect(await fetchPublicFinancingOffer(TOKEN)).toEqual({ state: 'not_found' });
  });

  it('returns error when the request fails', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    expect(await fetchPublicFinancingOffer(TOKEN)).toEqual({ state: 'error' });
  });
});
