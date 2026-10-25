import { describe, expect, it } from 'vitest';
import {
  aprLabel, describeControl, describePayError, describeUnavailable, feeSentence, needsReceipt, newIdempotencyKey, offerCostRows,
  offerIsExpired, parseMccList, takeHomeAfterRecovery, termLabel, transferStatusInfo, validateControlPatch, type CapitalOffer, type ControlRow,
} from './pay';

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const control: ControlRow = {
  product: 'earned_wage_access', enabled: false, mode: 'sandbox', partner_name: null, partner_agreement_ref: null, live_approved_at: null,
  killed_at: null, kill_reason: null, fee_bps: 0, min_fee_cents: 299, max_fee_cents: 299, max_single_cents: 50000, max_daily_tenant_cents: 250000,
  max_pct_of_accrued: 50, updated_at: '2027-01-01T00:00:00Z',
};

describe('labels', () => {
  it('formats APR and term', () => {
    expect(aprLabel(2400)).toBe('24.00%');
    expect(aprLabel(1)).toBe('0.01%');
    expect(termLabel(180)).toBe('6 months');
    expect(termLabel(45)).toBe('45 days');
    expect(termLabel(1)).toBe('1 day');
  });
  it('fee sentence', () => {
    expect(feeSentence(10000, 299, usd)).toBe('Fee $2.99 — you receive $97.01.');
    expect(feeSentence(10000, 0, usd)).toBe('No fee.');
  });
  it('status tones', () => {
    expect(transferStatusInfo('paid').tone).toBe('success');
    expect(transferStatusInfo('needs_review').tone).toBe('warning');
    expect(transferStatusInfo('failed').tone).toBe('danger');
  });
});

describe('copy never leaks internals', () => {
  it('maps known codes and falls back safely', () => {
    expect(describePayError('exceeds_available')).toMatch(/more than you can take/);
    expect(describePayError('totally_unknown')).toMatch(/Nothing was sent/);
    expect(describePayError(undefined)).toMatch(/Nothing was sent/);
    expect(describeUnavailable('killed')).toMatch(/paused/);
    expect(describeUnavailable('???')).toMatch(/not available/);
  });
});

describe('money helpers', () => {
  it('take-home after recovery never goes negative', () => {
    expect(takeHomeAfterRecovery(100000, 30000)).toBe(70000);
    expect(takeHomeAfterRecovery(10000, 30000)).toBe(0);
    expect(takeHomeAfterRecovery(10000, -5)).toBe(10000);
  });
  it('idempotency keys are unique and long enough for the server check', () => {
    const a = newIdempotencyKey(); const b = newIdempotencyKey();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(8);
  });
});

describe('cards', () => {
  it('parses MCC lists', () => {
    expect(parseMccList('5251, 5072 5251,x,123')).toEqual({ valid: ['5251', '5072'], invalid: ['x', '123'] });
    expect(parseMccList('')).toEqual({ valid: [], invalid: [] });
  });
  it('receipt needed only above the threshold for non-declined purchases', () => {
    expect(needsReceipt({ amount_cents: 5000, receipt_path: null, status: 'approved' }, 2500)).toBe(true);
    expect(needsReceipt({ amount_cents: 2500, receipt_path: null, status: 'approved' }, 2500)).toBe(false);
    expect(needsReceipt({ amount_cents: 5000, receipt_path: 'x/y', status: 'settled' }, 2500)).toBe(false);
    expect(needsReceipt({ amount_cents: 5000, receipt_path: null, status: 'declined' }, 2500)).toBe(false);
  });
});

describe('capital offers must show full cost', () => {
  const offer: CapitalOffer = {
    id: 'o', application_id: 'a', status: 'open', sandbox: true, offered_amount_cents: 1000000, total_repayment_cents: 1120000, finance_charge_cents: 120000,
    term_days: 180, estimated_apr_bps: 2400, repayment_description: 'x'.repeat(12), terms_url: null, expires_at: new Date(Date.now() + 86400000).toISOString(),
  };
  it('lists amount, total repayment, finance charge, term and APR', () => {
    expect(offerCostRows(offer, usd).map((r) => r.label)).toEqual(['Amount you receive', 'Total you repay', 'Finance charge', 'Term', 'Estimated APR']);
    expect(offerCostRows(offer, usd)[1].value).toBe('$11200.00');
  });
  it('expiry and status', () => {
    expect(offerIsExpired(offer)).toBe(false);
    expect(offerIsExpired({ ...offer, status: 'accepted' })).toBe(true);
    expect(offerIsExpired({ ...offer, expires_at: new Date(Date.now() - 1000).toISOString() })).toBe(true);
  });
});

describe('admin control guards', () => {
  it('describes state', () => {
    expect(describeControl({ enabled: true, mode: 'live', killed_at: null }).label).toBe('LIVE');
    expect(describeControl({ enabled: true, mode: 'sandbox', killed_at: null }).label).toBe('Sandbox');
    expect(describeControl({ enabled: false, mode: 'sandbox', killed_at: null }).label).toBe('Off');
    expect(describeControl({ enabled: false, mode: 'live', killed_at: '2027-01-01' }).label).toBe('KILLED');
  });
  it('requires a reason, a partner ref for live, sane fees', () => {
    expect(validateControlPatch(control, { enabled: true }, 'short')).toMatch(/reason/);
    expect(validateControlPatch(control, { mode: 'live' }, 'go live after review')).toMatch(/agreement reference/);
    expect(validateControlPatch(control, { mode: 'live', partner_agreement_ref: 'MSA-2027-001' }, 'go live after review')).toBeNull();
    expect(validateControlPatch(control, { min_fee_cents: 500 }, 'raise the minimum fee')).toMatch(/Maximum fee/);
    expect(validateControlPatch(control, { fee_bps: 3000 }, 'raise the fee a lot')).toMatch(/0 and 25%/);
    expect(validateControlPatch(control, { enabled: true }, 'enable sandbox testing')).toBeNull();
  });
});
