import { describe, it, expect } from 'vitest';
import rawConfig from '../../../config/nexus-thresholds.json';
import {
  buildTracker,
  coverageGap,
  evaluateRow,
  jurisdictionKey,
  parseNexusConfig,
  parseRevenueReport,
  pickWindow,
  summarize,
  trackerToCsv,
  NEXUS_CSV_HEADER,
  type JurisdictionConfig,
  type NexusConfig,
  type RevenueRow,
} from './nexusTracker';

const z = { grossCents: 0, taxCents: 0, n: 0 };
function row(over: Partial<RevenueRow> & { r12?: Partial<typeof z>; cy?: Partial<typeof z>; py?: Partial<typeof z> } = {}): RevenueRow {
  const { r12, cy, py, ...rest } = over;
  return {
    country: 'US', state: 'CA', currency: 'usd', unresolved: false,
    windows: { rolling_12m: { ...z, ...r12 }, calendar_year: { ...z, ...cy }, prior_calendar_year: { ...z, ...py } },
    ...rest,
  };
}
function cfg(over: Partial<JurisdictionConfig> = {}): JurisdictionConfig {
  return {
    name: 'Test', kind: 'us_state', currency: 'usd', revenueThresholdCents: 1_000_00, transactionThreshold: null,
    window: 'rolling_12m', basis: 'gross', comparison: 'gte', effectiveFrom: null, sourceUrl: null, reviewedBy: null, reviewedOn: null, ...over,
  };
}

describe('shipped config/nexus-thresholds.json', () => {
  const { config, problems } = parseNexusConfig(rawConfig);
  it('is valid and contains NO invented threshold values', () => {
    expect(problems).toEqual([]);
    expect(Object.keys(config.jurisdictions).length).toBeGreaterThanOrEqual(51);
    for (const j of Object.values(config.jurisdictions)) {
      expect(j.revenueThresholdCents).toBeNull();
      expect(j.transactionThreshold).toBeNull();
      expect(j.window).toBeNull();
    }
  });
  it('is marked unreviewed with the COUNSEL/VERIFY tags', () => {
    expect(config.reviewStatus).toMatch(/UNREVIEWED/);
    expect(config.reviewStatus).toMatch(/\[COUNSEL\]\[VERIFY\]/);
  });
  it('reports every row as not_configured (never below) while thresholds are empty', () => {
    const out = buildTracker({ asOf: '2030-01-01', generatedAt: '', coverage: { billingInvoicesSeen: 1, ledgerInvoices: 1, firstPaidAt: null, lastPaidAt: null }, rows: [row({ r12: { grossCents: 999_999_999, n: 5000 } })] }, config);
    expect(out.every((r) => r.status === 'not_configured')).toBe(true);
  });
});

describe('jurisdictionKey', () => {
  it('maps US states, other countries and unattributable revenue', () => {
    expect(jurisdictionKey('US', 'CA')).toBe('US-CA');
    expect(jurisdictionKey('GB', null)).toBe('GB');
    expect(jurisdictionKey('US', null)).toBe('US-UNKNOWN');
    expect(jurisdictionKey(null, null)).toBe('UNKNOWN');
  });
});

describe('evaluateRow status', () => {
  const ratio = 0.8;
  it('below / approaching / exceeded around the threshold (gte)', () => {
    expect(evaluateRow(row({ r12: { grossCents: 79_999 } }), cfg(), ratio).status).toBe('below');
    expect(evaluateRow(row({ r12: { grossCents: 80_000 } }), cfg(), ratio).status).toBe('approaching');
    expect(evaluateRow(row({ r12: { grossCents: 99_999 } }), cfg(), ratio).status).toBe('approaching');
    expect(evaluateRow(row({ r12: { grossCents: 100_000 } }), cfg(), ratio).status).toBe('exceeded');
  });
  it('comparison gt does not flag equality as exceeded; null comparison is conservative (gte)', () => {
    expect(evaluateRow(row({ r12: { grossCents: 100_000 } }), cfg({ comparison: 'gt' }), ratio).status).toBe('approaching');
    expect(evaluateRow(row({ r12: { grossCents: 100_001 } }), cfg({ comparison: 'gt' }), ratio).status).toBe('exceeded');
    expect(evaluateRow(row({ r12: { grossCents: 100_000 } }), cfg({ comparison: null }), ratio).status).toBe('exceeded');
  });
  it('transaction threshold alone, and the worst of revenue/transactions wins', () => {
    const c = cfg({ revenueThresholdCents: null, transactionThreshold: 200 });
    expect(evaluateRow(row({ r12: { n: 199 } }), c, ratio).status).toBe('approaching');
    expect(evaluateRow(row({ r12: { n: 200 } }), c, ratio).status).toBe('exceeded');
    const both = cfg({ transactionThreshold: 10 });
    expect(evaluateRow(row({ r12: { grossCents: 1, n: 10 } }), both, ratio).status).toBe('exceeded');
  });
  it('net_of_tax basis subtracts tax and never goes negative', () => {
    const r = evaluateRow(row({ r12: { grossCents: 110_000, taxCents: 20_000 } }), cfg({ basis: 'net_of_tax' }), ratio);
    expect(r.revenueCents).toBe(90_000);
    expect(r.status).toBe('approaching');
    expect(evaluateRow(row({ r12: { grossCents: 100, taxCents: 500 } }), cfg({ basis: 'net_of_tax' }), ratio).revenueCents).toBe(0);
  });
  it('a threshold without a window, or with neither threshold, is not_configured (never defaulted)', () => {
    expect(evaluateRow(row({ r12: { grossCents: 9e9 } }), cfg({ window: null }), ratio).status).toBe('not_configured');
    expect(evaluateRow(row(), cfg({ revenueThresholdCents: null, transactionThreshold: null }), ratio).status).toBe('not_configured');
    expect(evaluateRow(row(), undefined, ratio).status).toBe('not_configured');
  });
  it('different currency is currency_mismatch, not silently compared', () => {
    const r = evaluateRow(row({ currency: 'eur', r12: { grossCents: 9e9 } }), cfg(), ratio);
    expect(r.status).toBe('currency_mismatch');
    expect(r.revenuePct).toBeNull();
  });
});

describe('windows', () => {
  const w = row({ r12: { grossCents: 50, n: 1 }, cy: { grossCents: 10, n: 1 }, py: { grossCents: 70, n: 3 } }).windows;
  it('selects the configured window', () => {
    expect(pickWindow(w, 'rolling_12m').grossCents).toBe(50);
    expect(pickWindow(w, 'calendar_year').grossCents).toBe(10);
    expect(pickWindow(w, 'prior_or_current_calendar_year').grossCents).toBe(70);
  });
  it('prior_or_current picks the current year when it is higher', () => {
    const w2 = row({ cy: { grossCents: 90, n: 2 }, py: { grossCents: 70, n: 3 } }).windows;
    expect(pickWindow(w2, 'prior_or_current_calendar_year').grossCents).toBe(90);
  });
});

describe('buildTracker / summarize', () => {
  const config: NexusConfig = { reviewStatus: 'TEST', approachingRatio: 0.8, jurisdictions: { 'US-CA': cfg({ name: 'California' }), 'US-TX': cfg({ name: 'Texas' }) } };
  const report = { asOf: '2030-06-30', generatedAt: '', coverage: { billingInvoicesSeen: 3, ledgerInvoices: 2, firstPaidAt: null, lastPaidAt: null },
    rows: [row({ r12: { grossCents: 100_000, n: 1 } }), row({ country: null, state: null, unresolved: true, r12: { grossCents: 777, n: 1 } })] };
  const out = buildTracker(report, config);
  it('keeps configured jurisdictions with no revenue as zero rows and keeps unattributed revenue', () => {
    expect(out.find((r) => r.key === 'US-TX')).toMatchObject({ status: 'below', revenueCents: 0 });
    expect(out.find((r) => r.key === 'UNKNOWN')).toMatchObject({ status: 'not_configured', grossCents: 777 });
  });
  it('sorts exceeded first and summarizes counts and unattributed revenue', () => {
    expect(out[0]?.key).toBe('US-CA');
    const s = summarize(out, config);
    expect(s).toMatchObject({ exceeded: 1, below: 1, notConfigured: 1, configuredCount: 2 });
    expect(s.unattributedCents).toEqual({ usd: 777 });
  });
  it('reports the ledger/billing gap', () => {
    expect(coverageGap(report.coverage)).toBe(1);
    expect(coverageGap({ ...report.coverage, ledgerInvoices: 9 })).toBe(0);
  });
});

describe('parseRevenueReport', () => {
  it('survives garbage and string numerics (bigint from PostgREST)', () => {
    expect(parseRevenueReport(null).rows).toEqual([]);
    const r = parseRevenueReport({ as_of: '2030-01-01', rows: [{ country: 'US', state: 'NY', currency: 'USD', windows: { rolling_12m: { gross_cents: '12345', tax_cents: 5, n: '2' } } }, 'junk'], coverage: { billing_invoices_seen: '4', ledger_invoices: 3 } });
    expect(r.rows[0]).toMatchObject({ currency: 'usd' });
    expect(r.rows[0]?.windows.rolling_12m).toEqual({ grossCents: 12345, taxCents: 5, n: 2 });
    expect(r.rows[1]?.country).toBeNull();
    expect(r.coverage).toMatchObject({ billingInvoicesSeen: 4, ledgerInvoices: 3 });
  });
});

describe('parseNexusConfig validation', () => {
  it('flags bad keys, non-integer thresholds and a revenue threshold without currency', () => {
    const { problems, config } = parseNexusConfig({ alerting: { approachingRatio: 2 }, jurisdictions: {
      'us-ca': {}, 'US-CA': { revenueThresholdCents: 1.5 }, 'US-NY': { revenueThresholdCents: 100, window: 'rolling_12m' } } });
    expect(problems.join('\n')).toMatch(/approachingRatio/);
    expect(problems.join('\n')).toMatch(/invalid jurisdiction key/);
    expect(problems.join('\n')).toMatch(/positive integer/);
    expect(problems.join('\n')).toMatch(/needs a lower-case ISO 4217 currency/);
    expect(config.approachingRatio).toBe(0.8);
  });
});

describe('trackerToCsv', () => {
  const config: NexusConfig = { reviewStatus: 'UNREVIEWED [COUNSEL][VERIFY]', approachingRatio: 0.8, jurisdictions: {} };
  it('has the documented header and one line per row, money in major units', () => {
    const r = evaluateRow(row({ r12: { grossCents: 12_345, taxCents: 345, n: 2 } }), cfg(), 0.8);
    const lines = trackerToCsv([r], '2030-06-30', config).split('\r\n');
    expect(lines[0]).toBe(NEXUS_CSV_HEADER.join(','));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('123.45');
    expect(lines[1]).toContain('US-CA');
  });
  it('neutralises spreadsheet formulas coming from names', () => {
    const r = { ...evaluateRow(row(), undefined, 0.8), name: '=HYPERLINK("http://x")' };
    expect(trackerToCsv([r], '2030-06-30', config)).toContain(`"'=HYPERLINK(""http://x"")"`);
  });
});
