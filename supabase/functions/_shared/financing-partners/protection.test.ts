// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  PROTECTION_STATUSES, acknowledgedMatches, checkCommissionEntry, commissionBalance, createProtectionStub, disclosureSha256,
  evaluateProtectionEligibility, isProtectionPartner, parseProtectionWebhook, protectionTransition, validateProviderQuote,
  type CommissionLine, type ProtectionStatus,
} from './protection';
import { getPartner } from './registry';
import { signWebhook } from './signature';

const env = (m: Record<string, string>) => (k: string) => m[k];
const OPEN = { gate: { allowed: true }, hasLiveOffer: false } as const;
const caps = { currencies: ['USD'], minQuoteCents: 10_000, maxQuoteCents: 5_000_000 };
const quote = { status: 'sent', totalCents: 250_000, currency: 'usd' };
const DISC = 'Provider-authored disclosure text that is long enough to pass the minimum length check.';

describe('protectionTransition', () => {
  it('allows the happy path one step at a time', () => {
    expect(protectionTransition('requested', 'quoted')).toBe('apply');
    expect(protectionTransition('quoted', 'accepted')).toBe('apply');
    expect(protectionTransition('accepted', 'active')).toBe('apply');
  });
  it('rejects skipping acceptance and any backwards move', () => {
    expect(protectionTransition('quoted', 'active')).toBe('reject');
    expect(protectionTransition('requested', 'accepted')).toBe('reject');
    expect(protectionTransition('accepted', 'quoted')).toBe('reject');
  });
  it('treats repeats as noop and terminal states as final', () => {
    expect(protectionTransition('quoted', 'quoted')).toBe('noop');
    for (const t of ['active', 'declined', 'expired', 'canceled', 'failed'] as ProtectionStatus[]) {
      for (const to of PROTECTION_STATUSES) if (to !== t) expect(protectionTransition(t, to)).toBe('reject');
    }
  });
  it('expiry only before acceptance; failure only from requested; decline/cancel from any open state', () => {
    expect(protectionTransition('accepted', 'expired')).toBe('reject');
    expect(protectionTransition('quoted', 'failed')).toBe('reject');
    expect(protectionTransition('requested', 'failed')).toBe('apply');
    expect(protectionTransition('accepted', 'declined')).toBe('apply');
    expect(protectionTransition('quoted', 'canceled')).toBe('apply');
  });
});

describe('evaluateProtectionEligibility', () => {
  it('is eligible when gate open, quote sent, amount and currency fit, no live offer', () => {
    expect(evaluateProtectionEligibility({ ...OPEN, quote, partner: caps })).toEqual({ eligible: true });
  });
  it('fails closed on the licensing gate first, with its reason', () => {
    expect(evaluateProtectionEligibility({ gate: { allowed: false, reason: 'region_blocked' }, hasLiveOffer: false, quote, partner: caps }))
      .toEqual({ eligible: false, reason: 'gate_closed', detail: 'region_blocked' });
  });
  it('rejects missing/ineligible quotes, unsupported currency, limits and duplicates', () => {
    const r = (o: object) => evaluateProtectionEligibility({ ...OPEN, quote, partner: caps, ...o } as never);
    expect(r({ quote: null })).toMatchObject({ reason: 'quote_not_found' });
    expect(r({ quote: { ...quote, status: 'draft' } })).toMatchObject({ reason: 'quote_status' });
    expect(r({ partner: null })).toMatchObject({ reason: 'no_partner' });
    expect(r({ quote: { ...quote, currency: 'EUR' } })).toMatchObject({ reason: 'currency_unsupported' });
    expect(r({ quote: { ...quote, totalCents: 9_999 } })).toMatchObject({ reason: 'below_minimum', detail: 10_000 });
    expect(r({ quote: { ...quote, totalCents: 5_000_001 } })).toMatchObject({ reason: 'above_maximum' });
    expect(r({ quote: { ...quote, totalCents: 0 } })).toMatchObject({ reason: 'below_minimum' });
    expect(r({ hasLiveOffer: true })).toMatchObject({ reason: 'live_offer_exists' });
  });
});

describe('validateProviderQuote (provider data only)', () => {
  const good = { partnerReference: 'p_1', priceCents: 12_900, currency: 'usd', termMonths: 12, planLabel: ' Basic ', disclosureText: DISC };
  it('normalises a complete provider quote', () => {
    expect(validateProviderQuote(good)).toMatchObject({ currency: 'USD', planLabel: 'Basic', priceCents: 12_900 });
  });
  it('refuses to create an offer without provider disclosure, price, term or plan', () => {
    expect(validateProviderQuote({ ...good, disclosureText: '' })).toBeNull();
    expect(validateProviderQuote({ ...good, disclosureText: 'too short' })).toBeNull();
    expect(validateProviderQuote({ ...good, priceCents: 0 })).toBeNull();
    expect(validateProviderQuote({ ...good, priceCents: 10.5 })).toBeNull();
    expect(validateProviderQuote({ ...good, termMonths: 0 })).toBeNull();
    expect(validateProviderQuote({ ...good, planLabel: '' })).toBeNull();
    expect(validateProviderQuote({ ...good, currency: 'US' })).toBeNull();
    expect(validateProviderQuote({ ...good, disclosureText: 'x'.repeat(8001) })).toBeNull();
    expect(validateProviderQuote(null)).toBeNull();
  });
});

describe('disclosure acknowledgement', () => {
  it('matches only the exact provider text', async () => {
    const sha = await disclosureSha256(DISC);
    expect(acknowledgedMatches(sha, sha)).toBe(true);
    expect(acknowledgedMatches(sha, await disclosureSha256(DISC + ' '))).toBe(false);
    expect(acknowledgedMatches(null, sha)).toBe(false);
    expect(acknowledgedMatches(sha, 'not-hex')).toBe(false);
  });
});

describe('commission ledger math', () => {
  const L = (kind: CommissionLine['kind'], amountCents: number, currency = 'USD'): CommissionLine => ({ kind, amountCents, currency });
  it('computes net and outstanding per currency', () => {
    expect(commissionBalance([L('accrual', 1000), L('reversal', 200), L('settlement', 300), L('accrual', 50, 'EUR')], 'USD'))
      .toEqual({ accrued: 1000, reversed: 200, settled: 300, net: 800, outstanding: 500 });
  });
  it('rejects non-positive, fractional or malformed entries', () => {
    expect(checkCommissionEntry([], L('accrual', 0))).toBe('invalid_amount');
    expect(checkCommissionEntry([], L('accrual', -5))).toBe('invalid_amount');
    expect(checkCommissionEntry([], L('accrual', 1.5))).toBe('invalid_amount');
    expect(checkCommissionEntry([], L('accrual', 5, 'usd'))).toBe('invalid_amount');
  });
  it('never lets a reversal exceed net accrual or a settlement exceed outstanding', () => {
    const lines = [L('accrual', 1000), L('settlement', 600)];
    expect(checkCommissionEntry(lines, L('reversal', 1000))).toBe('ok');
    expect(checkCommissionEntry(lines, L('reversal', 1001))).toBe('exceeds_balance');
    expect(checkCommissionEntry(lines, L('settlement', 400))).toBe('ok');
    expect(checkCommissionEntry(lines, L('settlement', 401))).toBe('exceeds_balance');
  });
  it('refuses to mix currencies on one entity', () => {
    expect(checkCommissionEntry([L('accrual', 1000)], L('accrual', 10, 'EUR'))).toBe('currency_mismatch');
  });
});

describe('protection stub adapter + webhook parsing', () => {
  it('is unavailable unless explicitly enabled, and never offers financing', () => {
    expect(createProtectionStub(env({})).isConfigured()).toBe(false);
    expect(createProtectionStub(env({ FINANCING_PARTNER_ALLOW_PROTECTION_STUB: 'true' })).isConfigured()).toBe(true);
    expect(getPartner('protection_stub')).toBeNull(); // test env has no flag
  });
  it('is a sandbox provider whose quote passes validation but is labelled as not real', async () => {
    const p = createProtectionStub(env({ FINANCING_PARTNER_ALLOW_PROTECTION_STUB: 'true' }));
    expect(isProtectionPartner(p)).toBe(true);
    expect(p.sandbox).toBe(true);
    const q = validateProviderQuote(await p.requestProtectionQuote({ referenceId: 'abc', amountCents: 50_000, currency: 'USD', description: 'x' }));
    expect(q?.disclosureText).toMatch(/SANDBOX ONLY/);
    expect(q?.partnerReference).toBe('stub_prot_abc');
  });
  it('verifies webhook signatures with its own secret', async () => {
    const p = createProtectionStub(env({ FINANCING_PARTNER_PROTECTION_STUB_WEBHOOK_SECRET: 'test-secret-0123456789abcdef' }));
    const body = JSON.stringify({ id: 'e1', type: 'protection.status', reference: 'r1', status: 'active' });
    const sig = await signWebhook(body, 'test-secret-0123456789abcdef');
    expect(await p.verifyWebhook(body, new Headers({ 'X-Partner-Signature': sig }))).toBe(true);
    expect(await p.verifyWebhook(body + ' ', new Headers({ 'X-Partner-Signature': sig }))).toBe(false);
  });
  it('parses status, quote and commission; rejects malformed or unknown events', () => {
    const base = { id: 'e1', type: 'protection.status', reference: 'r1' };
    expect(parseProtectionWebhook(JSON.stringify({ ...base, status: 'active', commission: { kind: 'accrual', amountCents: 500, currency: 'usd' } })))
      .toMatchObject({ kind: 'protection', status: 'active', commission: { kind: 'accrual', amountCents: 500, currency: 'USD' } });
    expect(parseProtectionWebhook(JSON.stringify({ ...base, status: 'quoted', quote: { priceCents: 100, currency: 'USD', termMonths: 6, planLabel: 'P', disclosureText: DISC } })))
      .toMatchObject({ quote: { partnerReference: 'r1', priceCents: 100 } });
    expect(parseProtectionWebhook(JSON.stringify({ ...base, status: 'quoted', quote: { priceCents: 100 } }))).toBeNull();
    expect(parseProtectionWebhook(JSON.stringify({ ...base, status: 'accepted' }))).toBeNull(); // customer-driven, never partner-reported
    expect(parseProtectionWebhook(JSON.stringify({ ...base, status: 'active', commission: { kind: 'accrual', amountCents: -1, currency: 'USD' } }))).toBeNull();
    expect(parseProtectionWebhook('not json')).toBeNull();
    expect(parseProtectionWebhook(JSON.stringify({ ...base, type: 'financing.status', status: 'active' }))).toBeNull();
  });
});
