import { describe, expect, it } from 'vitest';
import {
  csvCell,
  csvFileName,
  dormancyDistribution,
  formatCents,
  instrumentsToCsv,
  summarizeLiability,
  validateSettings,
  type DormancyRow,
  type InstrumentRow,
  type LiabilitySummaryRow,
} from './storedValueLiability';

const OWNER = '00000000-0000-0000-0000-0000000000a1';

const summary = (over: Partial<LiabilitySummaryRow>): LiabilitySummaryRow => ({
  account_owner_id: OWNER,
  instrument_kind: 'gift_card',
  currency: 'usd',
  instrument_count: 0,
  outstanding_cents: 0,
  expired_count: 0,
  expired_cents: 0,
  past_review_count: 0,
  past_review_cents: 0,
  unreconciled_count: 0,
  oldest_activity_at: null,
  ...over,
});

const FIXTURE: LiabilitySummaryRow[] = [
  summary({ instrument_kind: 'gift_card', instrument_count: 3, outstanding_cents: 30000, expired_count: 1, expired_cents: 5000, past_review_count: 1, past_review_cents: 5000 }),
  summary({ instrument_kind: 'store_credit', instrument_count: 2, outstanding_cents: 12000, unreconciled_count: 1 }),
  summary({ instrument_kind: 'loyalty_points', instrument_count: 10, outstanding_cents: 8000 }),
  summary({ instrument_kind: 'gift_card', currency: 'cad', instrument_count: 1, outstanding_cents: 2500 }),
];

describe('summarizeLiability', () => {
  it('excludes loyalty points unless opted in', () => {
    const t = summarizeLiability(FIXTURE, false).find((x) => x.currency === 'usd')!;
    expect(t.outstandingCents).toBe(42000);
    expect(t.instrumentCount).toBe(5);
    expect(t.unreconciledCount).toBe(1);
  });

  it('includes loyalty points when opted in', () => {
    const t = summarizeLiability(FIXTURE, true).find((x) => x.currency === 'usd')!;
    expect(t.outstandingCents).toBe(50000);
  });

  it('never mixes currencies and sorts by outstanding desc', () => {
    const t = summarizeLiability(FIXTURE, false);
    expect(t.map((x) => x.currency)).toEqual(['usd', 'cad']);
    expect(t[1].outstandingCents).toBe(2500);
  });

  it('returns an empty list for no rows', () => {
    expect(summarizeLiability([], true)).toEqual([]);
  });
});

describe('dormancyDistribution', () => {
  const rows: DormancyRow[] = [
    { account_owner_id: OWNER, instrument_kind: 'gift_card', currency: 'usd', inactivity_bucket: '0_180', instrument_count: 2, balance_cents: 10000 },
    { account_owner_id: OWNER, instrument_kind: 'gift_card', currency: 'usd', inactivity_bucket: '731_plus', instrument_count: 1, balance_cents: 2000 },
    { account_owner_id: OWNER, instrument_kind: 'loyalty_points', currency: 'usd', inactivity_bucket: '0_180', instrument_count: 4, balance_cents: 900 },
  ];

  it('always returns all four buckets in fixed order', () => {
    const d = dormancyDistribution(rows, 'USD', false);
    expect(d.map((x) => x.bucket)).toEqual(['0_180', '181_365', '366_730', '731_plus']);
    expect(d[1]).toEqual({ bucket: '181_365', count: 0, cents: 0 });
  });

  it('honours the loyalty opt-in', () => {
    expect(dormancyDistribution(rows, 'usd', false)[0].cents).toBe(10000);
    expect(dormancyDistribution(rows, 'usd', true)[0].cents).toBe(10900);
  });
});

describe('validateSettings', () => {
  it('accepts blanks as "not set"', () => {
    expect(validateSettings({ state_code: '', review_period_months: '' })).toEqual({ error: null, value: { state_code: null, review_period_months: null } });
  });
  it('normalises the state code to upper case', () => {
    expect(validateSettings({ state_code: ' ca ', review_period_months: '24' }).value).toEqual({ state_code: 'CA', review_period_months: 24 });
  });
  it('rejects bad states and periods', () => {
    expect(validateSettings({ state_code: 'CAL', review_period_months: '' }).error).toBe('invalidState');
    expect(validateSettings({ state_code: '', review_period_months: '0' }).error).toBe('invalidPeriod');
    expect(validateSettings({ state_code: '', review_period_months: '121' }).error).toBe('invalidPeriod');
    expect(validateSettings({ state_code: '', review_period_months: '1e2' }).error).toBe('invalidPeriod');
    expect(validateSettings({ state_code: '', review_period_months: '-5' }).error).toBe('invalidPeriod');
  });
});

describe('CSV export', () => {
  const row = (over: Partial<InstrumentRow>): InstrumentRow => ({
    account_owner_id: OWNER,
    instrument_id: 'gc-1',
    instrument_kind: 'gift_card',
    balance_cents: 12345,
    currency: 'usd',
    issued_at: '2026-01-02T00:00:00.000Z',
    expires_at: null,
    last_activity_at: '2026-02-03T00:00:00.000Z',
    reference_suffix: 'AB12',
    ledger_reconciled: true,
    is_expired: false,
    days_inactive: 100,
    inactivity_bucket: '0_180',
    review_period_months: null,
    past_review_period: false,
    ...over,
  });

  it('neutralises formula injection', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('-2')).toBe("'-2");
    expect(csvCell(-2)).toBe('-2'); // real numbers stay numbers
  });

  it('quotes commas, quotes and newlines; maps null to empty', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('l1\nl2')).toBe('"l1\nl2"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(false)).toBe('false');
  });

  it('writes header + rows with BOM and CRLF and formats money', () => {
    const csv = instrumentsToCsv([row({})], false);
    expect(csv.startsWith('\uFEFFkind,reference_last4,currency,balance,')).toBe(true);
    const lines = csv.trimEnd().split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[1].startsWith('gift_card,AB12,usd,123.45,')).toBe(true);
  });

  it('skips loyalty rows unless opted in and never exports codes or emails', () => {
    const rows = [row({}), row({ instrument_kind: 'loyalty_points', reference_suffix: 'ZZ99' })];
    expect(instrumentsToCsv(rows, false)).not.toContain('ZZ99');
    expect(instrumentsToCsv(rows, true)).toContain('ZZ99');
    expect(instrumentsToCsv(rows, true)).not.toMatch(/@/);
  });

  it('builds a dated file name', () => {
    expect(csvFileName(new Date('2026-11-17T10:00:00Z'))).toBe('stored-value-2026-11-17.csv');
  });
});

describe('formatCents', () => {
  it('formats and falls back on a bad currency code', () => {
    expect(formatCents(12345, 'usd', 'en-US')).toBe('$123.45');
    expect(formatCents(100, 'not-a-currency', 'en-US')).toBe('1.00 NOT-A-CURRENCY');
  });
});
