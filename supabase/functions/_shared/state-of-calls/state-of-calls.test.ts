// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { aggregateOrgFacts, percentileCont, type OrgFacts } from './aggregate.ts';
import { DisclosureError, applyDisclosureControl, assertPublishable, canonicalJson, cellsHash, resolveOptions, roundCount } from './disclosure.ts';
import { toCsv, csvText, CSV_COLUMNS } from './csv.ts';
import { assessSufficiency, buildNarrative, verifyNarrative } from './narrative.ts';
import { K_MIN_PUBLIC, cellKey, type PublishedCell, type RawCell } from './schema.ts';
import { generateSyntheticOrgs } from './synthetic.ts';

const raw = (o: Partial<RawCell> = {}): RawCell => ({
  metric_key: 'answer_rate', dim: 'national', dim_value: 'all', period_key: '2026', n_orgs: 40, n_events: 5000,
  pooled_value: 87.4, org_p25: 83.2, org_p50: 87.6, org_p75: 91.1, max_org_share: 0.1, ...o,
});
const zeros = () => Array(12).fill(0);
const org = (o: Partial<OrgFacts> = {}): OrgFacts => ({
  trade: 'hvac', region: 'south', calls: zeros(), missed: zeros(), hours_eligible: zeros(), after_hours: zeros(), emergency: zeros(),
  booked: zeros(), lang_known: zeros(), lang_counts: {}, lead_resp_n: 0, lead_resp_median_min: null, ticket_jobs: 0, ticket_sum: 0, ...o,
});
const pipeline = (seed = 20260101, period = '2026') => applyDisclosureControl(aggregateOrgFacts(generateSyntheticOrgs(seed), period, K_MIN_PUBLIC));

describe('percentileCont matches Postgres percentile_cont', () => {
  it('interpolates linearly', () => {
    expect(percentileCont([90, 80, 90], 0.25)).toBe(85);
    expect(percentileCont([90, 80, 90], 0.5)).toBe(90);
    expect(percentileCont([], 0.5)).toBeNull();
    expect(percentileCont([5], 0.75)).toBe(5);
  });
});

describe('aggregate oracle: known values (same fixture is used by the pgTAP test)', () => {
  it('computes pooled rate, org percentiles and counts', () => {
    const orgs = [
      org({ calls: [...[100], ...Array(11).fill(0)], missed: [10, ...Array(11).fill(0)] }),
      org({ calls: [...[200], ...Array(11).fill(0)], missed: [40, ...Array(11).fill(0)] }),
      org({ calls: [...[300], ...Array(11).fill(0)], missed: [30, ...Array(11).fill(0)] }),
    ];
    const cells = aggregateOrgFacts(orgs, '2026', 10);
    const c = cells.find((x) => x.metric_key === 'answer_rate' && x.dim === 'national')!;
    expect(c.n_orgs).toBe(3);
    expect(c.n_events).toBe(600);
    expect(c.pooled_value).toBeCloseTo((520 / 600) * 100, 9);
    expect(c.org_p25).toBeCloseTo(85, 9);
    expect(c.org_p50).toBeCloseTo(90, 9);
    expect(c.max_org_share).toBeCloseTo(0.5, 9);
  });
  it('language cells count only orgs that contributed to the numerator and group rare languages', () => {
    const mk = (l: Record<string, number>) => org({ lang_known: [100, ...Array(11).fill(0)], lang_counts: l, calls: [100, ...Array(11).fill(0)] });
    const orgs = [...Array(10)].map(() => mk({ english: 90, spanish: 10 })).concat([mk({ english: 100 }), mk({ english: 95, klingon: 5 })]);
    const cells = aggregateOrgFacts(orgs, '2026', 10).filter((c) => c.metric_key === 'language_share');
    expect(cells.map((c) => c.dim_value).sort()).toEqual(['english', 'other', 'spanish']);
    expect(cells.find((c) => c.dim_value === 'other')!.n_orgs).toBe(1);
  });
});

describe('suppression', () => {
  it('suppresses cells below k and publishes at exactly k', () => {
    const { cells } = applyDisclosureControl([raw({ n_orgs: K_MIN_PUBLIC - 1 }), raw({ dim: 'trade', dim_value: 'hvac', n_orgs: K_MIN_PUBLIC })]);
    const low = cells.find((c) => c.dim === 'national')!;
    expect(low.suppressed).toBe(true);
    expect(low.suppression_reason).toBe('k_anonymity');
    expect([low.value, low.p25, low.p50, low.p75, low.n_orgs, low.n_events]).toEqual([null, null, null, null, null, null]);
    expect(cells.find((c) => c.dim === 'trade')!.suppressed).toBe(false);
  });
  it('cannot be configured below the public floors', () => {
    expect(resolveOptions({ kMin: 1, dominanceMax: 0.99, minEvents: 1 })).toEqual({ kMin: 10, dominanceMax: 0.35, minEvents: 100 });
    expect(applyDisclosureControl([raw({ n_orgs: 5 })], { kMin: 2 }).cells[0].suppressed).toBe(true);
    expect(resolveOptions({ kMin: 25 }).kMin).toBe(25);
  });
  it('suppresses a dominated cell even when k is satisfied', () => {
    expect(applyDisclosureControl([raw({ max_org_share: 0.36 })]).cells[0].suppression_reason).toBe('dominance');
    expect(applyDisclosureControl([raw({ max_org_share: 0.35 })]).cells[0].suppressed).toBe(false);
  });
  it('suppresses low event volume', () => {
    expect(applyDisclosureControl([raw({ n_events: 99 })]).cells[0].suppression_reason).toBe('low_volume');
  });
  it('re-identification attempt: differencing a partition cannot recover a suppressed trade', () => {
    const rows = [
      raw(),
      raw({ dim: 'trade', dim_value: 'hvac', n_orgs: 20 }),
      raw({ dim: 'trade', dim_value: 'plumbing', n_orgs: 12 }),
      raw({ dim: 'trade', dim_value: 'roofing', n_orgs: 11 }),
      raw({ dim: 'trade', dim_value: 'locksmith', n_orgs: 4 }),
    ];
    const { cells, report } = applyDisclosureControl(rows);
    const trades = cells.filter((c) => c.dim === 'trade');
    expect(trades.filter((c) => c.suppressed).length).toBeGreaterThanOrEqual(2);
    expect(report.suppressed.complementary).toBe(1);
    expect(trades.find((c) => c.dim_value === 'roofing')!.suppression_reason).toBe('complementary'); // fewest orgs among the published
  });
  it('does not add complementary suppression when nothing is hidden', () => {
    const rows = [raw(), raw({ dim: 'trade', dim_value: 'hvac', n_orgs: 20 }), raw({ dim: 'trade', dim_value: 'plumbing', n_orgs: 12 })];
    expect(applyDisclosureControl(rows).report.suppressed.complementary).toBe(0);
  });
});

describe('privacy allowlist', () => {
  it('rejects identifiers and any non-allowlisted field', () => {
    for (const extra of [{ org_id: 'abc' }, { user_id: 'u1' }, { caller_phone: '+15551234567' }, { raw_values: [1, 2] }]) {
      expect(() => applyDisclosureControl([{ ...raw(), ...extra }])).toThrow(DisclosureError);
    }
  });
  it('rejects finer geography, crossed dimensions and malformed keys', () => {
    for (const bad of [
      raw({ dim: 'region', dim_value: 'tx' }), raw({ dim: 'region', dim_value: 'austin' }), raw({ dim: 'trade', dim_value: 'hvac-south' + ' ' }),
      raw({ dim: 'trade', dim_value: 'hvac,=cmd()' }), raw({ dim: 'national', dim_value: 'hvac' }), raw({ metric_key: 'caller_name' }),
      raw({ metric_key: 'lead_first_response_minutes', dim: 'season', dim_value: 'summer' }),
      raw({ max_org_share: 1.2 }), raw({ n_orgs: -1 }), raw({ pooled_value: Number.NaN }), raw({ period_key: '2026-13' }),
    ]) {
      expect(() => applyDisclosureControl([bad])).toThrow(DisclosureError);
    }
  });
  it('rejects duplicate cells and missing fields', () => {
    expect(() => applyDisclosureControl([raw(), raw()])).toThrow(/duplicate/);
    const { n_events: _omit, ...partial } = raw();
    expect(() => applyDisclosureControl([partial])).toThrow(/missing/);
  });
});

describe('rounding / coarsening', () => {
  it('rounds percentages to whole points, tickets to $25, counts and org counts', () => {
    const p = applyDisclosureControl([
      raw(),
      raw({ metric_key: 'avg_ticket_usd', dim: 'trade', dim_value: 'hvac', pooled_value: 487.4, org_p25: 410.2, org_p50: 462.6, org_p75: 551.2, n_orgs: 23, n_events: 1234 }),
    ]).cells;
    const a = p.find((c) => c.metric_key === 'answer_rate')!;
    expect([a.value, a.p25, a.p50, a.p75, a.n_orgs, a.n_events]).toEqual([87, 83, 88, 91, 40, 5000]);
    const t = p.find((c) => c.metric_key === 'avg_ticket_usd')!;
    expect([t.value, t.p25, t.p50, t.p75, t.n_orgs, t.n_events]).toEqual([475, 400, 475, 550, 25, 1200]);
    expect(roundCount(104)).toBe(100);
    expect(roundCount(999)).toBe(1000);
    expect(roundCount(1049)).toBe(1000);
  });
  it('never emits percentages above 100 or percentiles out of order', () => {
    const c = applyDisclosureControl([raw({ pooled_value: 100.4, org_p25: 99.7, org_p50: 100.2, org_p75: 100.9 })]).cells[0];
    expect(c.value).toBe(100);
    expect(c.p25! <= c.p50! && c.p50! <= c.p75!).toBe(true);
  });
});

describe('release gate (assertPublishable) catches tampering', () => {
  const good = (): PublishedCell => applyDisclosureControl([raw()]).cells[0];
  it('accepts clean cells', () => { expect(() => assertPublishable([good()])).not.toThrow(); });
  it('rejects a published cell below k', () => { expect(() => assertPublishable([{ ...good(), n_orgs: 3 }])).toThrow(/below k/); });
  it('rejects unrounded values, extra fields and numbers on suppressed cells', () => {
    expect(() => assertPublishable([{ ...good(), value: 87.41 }])).toThrow(/rounded/);
    expect(() => assertPublishable([{ ...good(), org_id: 'x' } as unknown as PublishedCell])).toThrow(/non-allowlisted/);
    expect(() => assertPublishable([{ ...good(), suppressed: true, suppression_reason: 'k_anonymity' }])).toThrow(/carries numbers/);
    expect(() => assertPublishable([{ ...good(), n_events: 10 }])).toThrow(/minimum volume/);
  });
  it('honours a stricter k at the gate', () => { expect(() => assertPublishable([good()], { kMin: 50 })).toThrow(/below k=50/); });
});

describe('reproducibility: same inputs -> same numbers', () => {
  it('produces an identical hash on repeated runs and for any input order', async () => {
    const a = await cellsHash(pipeline().cells);
    const b = await cellsHash(pipeline().cells);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    const orgs = generateSyntheticOrgs(20260101).reverse();
    const c = await cellsHash(applyDisclosureControl(aggregateOrgFacts(orgs, '2026', K_MIN_PUBLIC)).cells);
    expect(c).toBe(a);
  });
  it('changes when the data changes', async () => {
    expect(await cellsHash(pipeline(1).cells)).not.toBe(await cellsHash(pipeline(2).cells));
  });
  it('canonicalJson is key-order independent', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }));
  });
});

describe('synthetic end-to-end pipeline', () => {
  const { cells, report } = pipeline();
  it('publishes headline metrics and withholds the right cells', () => {
    expect(report.published).toBeGreaterThan(20);
    const get = (m: string, d: string, v: string) => cells.find((c) => cellKey(c) === `${m}|${d}|${v}|2026`);
    expect(get('answer_rate', 'national', 'all')!.suppressed).toBe(false);
    expect(get('answer_rate', 'trade', 'locksmith')!.suppression_reason).toBe('k_anonymity');       // 4 orgs
    expect(get('answer_rate', 'trade', 'pest-control')!.suppression_reason).toBe('dominance');      // one huge org
    expect(() => assertPublishable(cells)).not.toThrow();
  });
  it('never publishes exact counts or numbers from suppressed cells', () => {
    for (const c of cells) {
      if (c.suppressed) expect([c.n_orgs, c.n_events, c.value].every((v) => v === null)).toBe(true);
      else { expect(c.n_events! % 10).toBe(0); expect(c.n_orgs! % 5).toBe(0); }
    }
  });
});

describe('CSV export', () => {
  const { cells } = pipeline();
  const csv = toCsv(cells, { slug: 'sample-2026', title: 'State of Home Service Calls (sample)' });
  it('uses only the fixed column allowlist and one line per cell', () => {
    const lines = csv.trimEnd().split('\r\n');
    expect(lines[0]).toBe(CSV_COLUMNS.join(','));
    expect(lines).toHaveLength(cells.length + 1);
  });
  it('neutralises spreadsheet formula injection and quotes correctly', () => {
    expect(csvText('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvText('+1')).toBe("'+1");
    expect(csvText('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvText('a,b')).toBe('"a,b"');
    expect(csvText('plain')).toBe('plain');
  });
  it('suppressed cells have empty numeric columns', () => {
    const row = csv.split('\r\n').find((l) => l.includes(',trade,locksmith,'))!;
    expect(row).toContain(',true,k_anonymity,,,,,,');
  });
});

describe('narrative: cited numbers only, no invention', () => {
  const { cells } = pipeline();
  it('every number in the narrative is backed by a cited published cell', () => {
    const n = buildNarrative(cells, '2026');
    expect(n.mode).toBe('report');
    expect(n.sections.length).toBeGreaterThan(2);
    expect(verifyNarrative(n, cells)).toEqual({ ok: true, problems: [] });
  });
  it('detects an altered number', () => {
    const n = buildNarrative(cells, '2026');
    n.sections[0].statements[0].text = n.sections[0].statements[0].text.replace(/\d+%/, '99%');
    expect(verifyNarrative(n, cells).ok).toBe(false);
  });
  it('never names suppressed trades or the dominated trade', () => {
    const text = JSON.stringify(buildNarrative(cells, '2026'));
    expect(text).not.toMatch(/locksmith|pest control/);
  });
  it('falls back to a methodology preview, with no findings, when data is insufficient', () => {
    const sparse = applyDisclosureControl([raw({ n_orgs: 4 }), raw({ metric_key: 'missed_call_rate', n_orgs: 4 })]).cells;
    expect(assessSufficiency(sparse, '2026').ok).toBe(false);
    const n = buildNarrative(sparse, '2026');
    expect(n.mode).toBe('methodology_preview');
    expect(n.sections).toHaveLength(1);
    expect(n.sections[0].statements[0].cites).toEqual([]);
    expect(/\d/.test(n.sections[0].statements[0].text)).toBe(false);
  });
});

import { chartCells, esc, renderBarChartSvg, renderSocialCardSvg } from './chart.ts';

describe('embeddable charts and social cards', () => {
  const { cells } = pipeline();
  const input = { title: 'Missed-call rate by trade', edition: 'State of Home Service Calls 2026', url: 'vireek.com/state-of-home-service-calls', synthetic: true };
  it('renders an accessible SVG with attribution, a synthetic watermark and withheld cells', () => {
    const svg = renderBarChartSvg({ ...input, cells: chartCells(cells, 'missed_call_rate', 'trade', '2026') });
    expect(svg).toContain('role="img"');
    expect(svg).toContain('<title id="t">');
    expect(svg).toContain('Source: Vireek');
    expect(svg).toContain('SYNTHETIC SAMPLE');
    expect(svg).toContain('withheld (too few businesses)');
  });
  it('escapes every dynamic string (no markup injection)', () => {
    expect(esc(`<script>alert("x")</script>&'`)).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;');
    const svg = renderSocialCardSvg({ headline: '<img onerror=x>', value: '83%', caption: '"quoted"', edition: 'E', url: 'u', synthetic: false });
    expect(svg).not.toContain('<img');
    expect(svg).not.toContain('SYNTHETIC');
  });
  it('ignores unknown metrics', () => { expect(chartCells(cells, 'caller_name', 'trade', '2026')).toEqual([]); });
});

import { readFileSync } from 'node:fs';
import { METRIC_KEYS, REGIONS, K_MIN_PUBLIC as K } from './schema.ts';

describe('SQL migration stays in sync with the TypeScript allowlist (drift guard)', () => {
  const sql = readFileSync(new URL('../../../migrations/20280415000000_state_of_calls_report.sql', import.meta.url), 'utf8');
  it('metric allowlist in report_cells CHECK equals METRICS', () => {
    const m = /metric_key\s+text NOT NULL CHECK \(metric_key IN \(([^)]*)\)/.exec(sql)!;
    const keys = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
    expect(keys).toEqual([...METRIC_KEYS].sort());
  });
  it('region allowlist and k floor match', () => {
    const m = /dim <> 'region' OR dim_value IN \(([^)]*)\)/.exec(sql)!;
    expect([...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]).sort()).toEqual([...REGIONS].sort());
    expect(sql).toContain(`n_orgs >= ${K}`);
  });
  it('never reads the opt-out benchmark tables', () => {
    const code = sql.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const t of ['benchmark_snapshots', 'regional_demand_snapshots', 'outcome_benchmark_cohorts', 'outcome_benchmark_settings']) expect(code.includes(t)).toBe(false);
  });
});
