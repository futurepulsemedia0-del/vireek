import { describe, it, expect } from 'vitest';
import {
  centsToDollarsInput,
  currentPeriod,
  dollarsToCents,
  formatPrice,
  needsUpgrade,
  parseManifestInput,
  scopesAddedBy,
  spendForPeriod,
  type MarketplaceLedgerEntry,
} from './agentMarketplace';

const entry = (over: Partial<MarketplaceLedgerEntry>): MarketplaceLedgerEntry => ({
  id: 'x', install_id: 'i1', agent_id: 'a1', entry_type: 'usage', amount_cents: 100,
  platform_fee_cents: 20, publisher_payout_cents: 80, period: '2027-02', description: null, created_at: '', ...over,
});

describe('agentMarketplace helpers', () => {
  it('formats prices', () => {
    expect(formatPrice({ pricing_model: 'free', price_cents: 0 })).toBe('Free');
    expect(formatPrice({ pricing_model: 'per_run', price_cents: 25 })).toBe('$0.25 / run');
    expect(formatPrice({ pricing_model: 'monthly', price_cents: 4900 })).toBe('$49.00 / month');
  });

  it('builds a UTC period key', () => {
    expect(currentPeriod(new Date('2027-02-09T12:00:00Z'))).toBe('2027-02');
    expect(currentPeriod(new Date('2027-12-31T23:59:59Z'))).toBe('2027-12');
  });

  it('sums spend per period and install', () => {
    const e = [entry({}), entry({ amount_cents: 50 }), entry({ period: '2027-01' }), entry({ install_id: 'i2' })];
    expect(spendForPeriod(e, '2027-02')).toBe(250);
    expect(spendForPeriod(e, '2027-02', 'i1')).toBe(150);
  });

  it('parses dollar input strictly', () => {
    expect(dollarsToCents('49')).toBe(4900);
    expect(dollarsToCents('0.29')).toBe(29);
    expect(dollarsToCents('1.005')).toBeNull();
    expect(dollarsToCents('-5')).toBeNull();
    expect(dollarsToCents('abc')).toBeNull();
    expect(dollarsToCents('')).toBeNull();
    expect(centsToDollarsInput(4900)).toBe('49');
    expect(centsToDollarsInput(1250)).toBe('12.50');
  });

  it('detects newly requested scopes and upgrades', () => {
    expect(scopesAddedBy(['read:jobs'], ['read:jobs', 'act:send_sms'])).toEqual(['act:send_sms']);
    expect(needsUpgrade({ version_id: 'v1' }, { current_version_id: 'v2' })).toBe(true);
    expect(needsUpgrade({ version_id: 'v1' }, { current_version_id: 'v1' })).toBe(false);
    expect(needsUpgrade({ version_id: 'v1' }, { current_version_id: null })).toBe(false);
  });

  it('validates manifest JSON shape', () => {
    expect(parseManifestInput('nope').ok).toBe(false);
    expect(parseManifestInput('[]').ok).toBe(false);
    expect(parseManifestInput('{"scopes":[],"triggers":["manual"]}').ok).toBe(false);
    expect(parseManifestInput('{"scopes":["read:jobs"],"triggers":["manual"]}').ok).toBe(true);
  });
});
