import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type ExitMetrics, type SnapshotLite } from '@/lib/exitReadiness';
import {
  annualRevenueCents,
  buildReadinessChecklist,
  diffRuns,
  evidenceScore,
  factNum,
  movedDrivers,
  parseRecon,
  parseRun,
  pickMultipleRow,
  resolveEffectiveMultiples,
  scoreSignals,
  shortHash,
  sizeBandFor,
  validateMultipleRow,
  type FactRow,
  type LineageRun,
  type MultipleRow,
  type RunRow,
} from '@/lib/exitLineage';

const H = 'a'.repeat(64);
const fact = (key: string, value: Record<string, unknown>, count = 1, hash = H): FactRow => ({
  id: `f-${key}`, metric_key: key, label: key, value, as_of: '2028-01-01T00:00:00Z', logic_version: 'exit_ready.v1',
  logic_text: 'x', source_table: 't', source_count: count, content_hash: hash,
});
const runRow = (reconciliation: unknown = []): RunRow => ({ id: 'r1', as_of: '2028-01-01T00:00:00Z', logic_version: 'exit_ready.v1', run_hash: H, created_at: '2028-01-01T00:00:00Z', reconciliation });
const mkRun = (facts: FactRow[], recon: unknown = []): LineageRun => parseRun(runRow(recon), facts);
const recon = (key: string, status: string, extra: Record<string, unknown> = {}) => ({
  key, label: key, leftLabel: 'L', leftCents: 100, rightLabel: 'R', rightCents: 0, diffCents: 100, toleranceCents: 0, status, note: 'n', ...extra,
});

describe('sizeBandFor', () => {
  it.each([
    [0, null], [-5, null], [null, null], [99_999_999, 'under_1m'], [100_000_000, '1m_to_5m'],
    [499_999_999, '1m_to_5m'], [500_000_000, '5m_to_20m'], [1_999_999_999, '5m_to_20m'], [2_000_000_000, 'over_20m'],
  ])('%s -> %s', (cents, band) => expect(sizeBandFor(cents as number | null)).toBe(band));
});

describe('validateMultipleRow', () => {
  const ok = { low: '2', mid: '3', high: '4', source: 'Broker report Q1', sourceDate: '2028-01-01' };
  const today = new Date('2028-06-01');
  it('accepts a complete row', () => expect(validateMultipleRow(ok, today)).toEqual({}));
  it('requires a source and a date', () => {
    const e = validateMultipleRow({ ...ok, source: 'ab', sourceDate: '' }, today);
    expect(e.source).toBeTruthy();
    expect(e.sourceDate).toBeTruthy();
  });
  it('rejects unordered, zero and >20x multiples', () => {
    expect(validateMultipleRow({ ...ok, low: '5', mid: '3' }, today).range).toBeTruthy();
    expect(validateMultipleRow({ ...ok, low: '0' }, today).range).toBeTruthy();
    expect(validateMultipleRow({ ...ok, high: '25' }, today).range).toBeTruthy();
    expect(validateMultipleRow({ ...ok, high: '' }, today).range).toBeTruthy();
  });
  it('rejects a future source date', () => expect(validateMultipleRow({ ...ok, sourceDate: '2030-01-01' }, today).sourceDate).toBeTruthy());
});

describe('resolveEffectiveMultiples', () => {
  const row = (o: Partial<MultipleRow>): MultipleRow => ({
    industryKey: 'hvac', sizeBand: '1m_to_5m', basis: 'sde', low: 2.1, mid: 2.9, high: 3.6, source: 'Advisor memo', sourceDate: '2028-01-15', isIllustrative: true, ...o,
  });
  it('uses the table row for the matching trade and size band, with provenance', () => {
    const r = resolveEffectiveMultiples(DEFAULT_SETTINGS, [row({})], 300_000_000);
    expect(r.settings.sdeMultiple).toEqual({ low: 2.1, mid: 2.9, high: 3.6 });
    expect(r.sde).toMatchObject({ origin: 'table', source: 'Advisor memo', sourceDate: '2028-01-15', illustrative: true });
    expect(r.ebitda.origin).toBe('builtin');
  });
  it('does not use a row for another size band or trade', () => {
    expect(resolveEffectiveMultiples(DEFAULT_SETTINGS, [row({ sizeBand: 'under_1m' })], 300_000_000).sde.origin).toBe('builtin');
    expect(resolveEffectiveMultiples(DEFAULT_SETTINGS, [row({ industryKey: 'roofing' })], 300_000_000).sde.origin).toBe('builtin');
  });
  it('a valid manual override wins over the table', () => {
    const r = resolveEffectiveMultiples({ ...DEFAULT_SETTINGS, sdeMultiple: { low: 1, mid: 2, high: 3 } }, [row({})], 300_000_000);
    expect(r.settings.sdeMultiple).toEqual({ low: 1, mid: 2, high: 3 });
    expect(r.sde).toMatchObject({ origin: 'manual', illustrative: false });
  });
  it('an invalid manual override is ignored', () => {
    const r = resolveEffectiveMultiples({ ...DEFAULT_SETTINGS, sdeMultiple: { low: 5, mid: 2, high: 3 } }, [row({})], 300_000_000);
    expect(r.sde.origin).toBe('table');
  });
  it('without revenue no band is chosen and the built-in placeholder is flagged illustrative', () => {
    const r = resolveEffectiveMultiples(DEFAULT_SETTINGS, [row({})], null);
    expect(r.sizeBand).toBeNull();
    expect(r.sde).toMatchObject({ origin: 'builtin', illustrative: true, sourceDate: null });
    expect(pickMultipleRow([row({})], 'hvac', null, 'sde')).toBeNull();
  });
});

describe('parsing', () => {
  it('parseRecon drops malformed rows and coerces numerics', () => {
    const out = parseRecon([recon('a', 'match', { leftCents: '250' }), { nope: true }, null, recon('b', 'weird')]);
    expect(out.map((r) => r.key)).toEqual(['a', 'b']);
    expect(out[0].leftCents).toBe(250);
    expect(out[1].status).toBe('unavailable');
    expect(parseRecon('x')).toEqual([]);
  });
  it('factNum reads numbers and numeric strings only', () => {
    const run = mkRun([fact('k', { a: 5, b: '7', c: 'x', d: null })]);
    expect(factNum(run.facts[0], 'a')).toBe(5);
    expect(factNum(run.facts[0], 'b')).toBe(7);
    expect(factNum(run.facts[0], 'c')).toBeNull();
    expect(factNum(run.facts[0], 'd')).toBeNull();
    expect(factNum(undefined, 'a')).toBeNull();
  });
  it('shortHash abbreviates a sha-256', () => expect(shortHash(H)).toBe('aaaaaaaa…aaaa'));
});

describe('scoreSignals', () => {
  it('scores growth between -10% (0) and +15% (100)', () => {
    const s = (cur: number, prev: number) => scoreSignals(mkRun([fact('revenue_invoiced_12m', { subtotalCents: cur }), fact('revenue_invoiced_prior_12m', { subtotalCents: prev })])).find((x) => x.key === 'growth')!;
    expect(s(90, 100).score).toBe(0);
    expect(s(115, 100).score).toBe(100);
    expect(s(100, 100).score).toBeCloseTo(40, 0);
    expect(s(100, 0).score).toBeNull();
  });
  it('needs 20+ calls to score booking rate and 5+ cycles to score renewals', () => {
    const few = scoreSignals(mkRun([fact('call_funnel_12m', { calls: 10, bookingRate: 0.9 }), fact('membership_renewals_12m', { cycles: 3, renewalRate: 0.9 })]));
    expect(few.find((x) => x.key === 'booking_rate')!.score).toBeNull();
    expect(few.find((x) => x.key === 'membership_renewal')!.score).toBeNull();
    const many = scoreSignals(mkRun([fact('call_funnel_12m', { calls: 40, bookingRate: 0.8 }), fact('membership_renewals_12m', { cycles: 9, renewalRate: 0.9 })]));
    expect(many.find((x) => x.key === 'booking_rate')!.score).toBe(100);
    expect(many.find((x) => x.key === 'membership_renewal')!.score).toBe(100);
  });
  it('backlog is informational and never scored', () => {
    const b = scoreSignals(mkRun([fact('jobs_12m', { scheduledOpen: 26, completed: 520 })])).find((x) => x.key === 'backlog')!;
    expect(b.score).toBeNull();
    expect(b.display).toContain('2.6 weeks');
  });
  it('handles no run', () => expect(scoreSignals(null).every((s) => s.score === null)).toBe(true));
});

describe('readiness checklist', () => {
  const metrics = (cov: number | null) => ({ margin: { overall: 0.4, coveragePct: cov, byService: [] } }) as unknown as ExitMetrics;
  it('asks for a run when none exists', () => {
    const c = buildReadinessChecklist(null, null);
    expect(c).toHaveLength(1);
    expect(c[0].key).toBe('no_run');
    expect(evidenceScore(c)).toBeNull();
  });
  it('flags a missing ledger, expired credentials and incomplete job costing, each with a fix route', () => {
    const run = mkRun(
      [fact('compliance', { credentialsExpired: 2, documentsExpired: 1, permitsLapsed: 0, rescissionTracked: false })],
      [recon('invoiced_vs_gl_revenue', 'unavailable', { leftCents: 5, rightCents: null, diffCents: null })],
    );
    const c = buildReadinessChecklist(run, metrics(0.5));
    const gaps = c.filter((i) => i.status === 'gap').map((i) => i.key);
    expect(gaps).toEqual(expect.arrayContaining(['no_ledger', 'cred_expired', 'doc_expired', 'job_costing']));
    expect(c.find((i) => i.key === 'no_ledger')!.fixPath).toBe('/dashboard/accounting');
    expect(c.find((i) => i.key === 'rescission')!.status).toBe('unknown');
  });
  it('reports a clean book as ok and scores 100 minus nothing for known-good items', () => {
    const run = mkRun(
      [fact('compliance', { credentialsExpired: 0, documentsExpired: 0, permitsLapsed: 0, rescissionTracked: true }), fact('call_funnel_12m', { calls: 30, bookingRate: 0.7, answerRate: 0.9 })],
      [recon('invoiced_vs_gl_revenue', 'match', { diffCents: 0 }), recon('invoice_paid_vs_job_payments', 'match', { diffCents: 0 })],
    );
    const c = buildReadinessChecklist(run, metrics(0.95));
    expect(c.every((i) => i.status === 'ok')).toBe(true);
    expect(evidenceScore(c)).toBe(100);
  });
  it('scores gaps by severity and floors at 0', () => {
    const mk = (severity: 'critical' | 'important' | 'minor', status: 'gap' | 'unknown') => ({ key: 'k', status, severity, title: '', detail: '', fixPath: null, fixLabel: null });
    expect(evidenceScore([mk('critical', 'gap')])).toBe(75);
    expect(evidenceScore([mk('important', 'gap')])).toBe(88);
    expect(evidenceScore([mk('critical', 'unknown')])).toBe(88);
    expect(evidenceScore(Array.from({ length: 6 }, () => mk('critical', 'gap')))).toBe(0);
  });
  it('shows the dollar difference of a reconciliation gap', () => {
    const run = mkRun([], [recon('invoiced_vs_gl_revenue', 'difference', { diffCents: 123456 })]);
    expect(buildReadinessChecklist(run, null).find((i) => i.key === 'gl_diff')!.detail).toContain('$1,234.56');
  });
});

describe('diffRuns', () => {
  it('detects added, removed, changed and unchanged facts and ignores as-of in the comparison', () => {
    const prev = mkRun([fact('revenue_invoiced_12m', { subtotalCents: 100 }, 2, 'b'.repeat(64)), fact('workforce', { activeShare: 0.5 }), fact('gl_revenue_12m', { revenueCents: 9 })]);
    const cur = mkRun([fact('revenue_invoiced_12m', { subtotalCents: 150 }, 3, 'c'.repeat(64)), fact('workforce', { activeShare: 0.5 }, 1, 'd'.repeat(64)), fact('jobs_12m', { completed: 4 })]);
    const d = Object.fromEntries(diffRuns(prev, cur).map((e) => [e.metricKey, e]));
    expect(d.revenue_invoiced_12m).toMatchObject({ change: 'changed', before: 100, after: 150, relative: 0.5 });
    expect(d.workforce.change).toBe('unchanged');
    expect(d.gl_revenue_12m.change).toBe('removed');
    expect(d.jobs_12m.change).toBe('added');
  });
  it('treats everything as added without a previous run and gives no relative change for a zero baseline', () => {
    const cur = mkRun([fact('revenue_invoiced_12m', { subtotalCents: 5 })]);
    expect(diffRuns(null, cur)[0].change).toBe('added');
    const z = diffRuns(mkRun([fact('revenue_invoiced_12m', { subtotalCents: 0 })]), cur)[0];
    expect(z.relative).toBeNull();
  });
});

describe('movedDrivers', () => {
  const snap = (m: string, s: Record<string, number | null>): SnapshotLite => ({ periodMonth: m, readinessScore: 50, valuePointCents: 1, driverScores: s });
  it('lists drivers that moved at least 3 points, largest first', () => {
    const r = movedDrivers([snap('2028-01-01', { dso: 40, workforce: 60, compliance: 80 }), snap('2028-02-01', { dso: 52.5, workforce: 58, compliance: 70 })]);
    expect(r).toEqual([{ driver: 'dso', delta: 12.5, direction: 'up' }, { driver: 'compliance', delta: -10, direction: 'down' }]);
  });
  it('needs two snapshots and ignores null scores', () => {
    expect(movedDrivers([snap('2028-01-01', { dso: 1 })])).toEqual([]);
    expect(movedDrivers([snap('2028-01-01', { dso: null }), snap('2028-02-01', { dso: 90 })])).toEqual([]);
  });
});

describe('annualRevenueCents', () => {
  const m = (revenueCents: number, ledgerMonths: number) => ({ ledgerMonths, financials: { revenueCents } }) as unknown as ExitMetrics;
  it('scales a short ledger to 12 months and never scales a longer one up', () => {
    expect(annualRevenueCents(m(100_000, 6))).toBe(200_000);
    expect(annualRevenueCents(m(100_000, 12))).toBe(100_000);
    expect(annualRevenueCents(m(100_000, 24))).toBe(100_000);
  });
  it('is null without revenue or ledger months', () => {
    expect(annualRevenueCents(m(0, 12))).toBeNull();
    expect(annualRevenueCents(m(5, 0))).toBeNull();
  });
});
