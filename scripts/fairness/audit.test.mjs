// node --experimental-strip-types --no-warnings --test scripts/fairness/audit.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  assertAllowedDimension, evaluate, newcombeDiff, normalCdf, normalizeCells, normalizeCustomerType,
  normalizeLanguage, regionFromPrefix, welchDiff, wilson, zTwoSided,
} from '../../supabase/functions/_shared/fairness/audit.ts';
import { fetchOverview, parseArgs, renderMarkdown, run } from './audit.mjs';

/** Builds a cell whose reviewed calls have the given mean and sd. */
function cell(dimension, group, { calls = 100, reviewed = calls, accounts = 5, mean = 80, sd = 10, low = 0, missed = 0, critical = 0 } = {}) {
  return {
    dimension, group, calls, reviewed, accounts,
    score_sum: reviewed * mean,
    score_sumsq: Math.max(reviewed - 1, 0) * sd * sd + reviewed * mean * mean,
    low_score: low, missed_booking: missed, critical,
  };
}
const flat = (report, dim) => report.dimensions.find((d) => d.dimension === dim).groups;

describe('statistics', () => {
  it('normal quantiles and Wilson interval match reference values', () => {
    assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-6);
    assert.ok(Math.abs(zTwoSided(0.05) - 1.95996) < 1e-3);
    const w = wilson(50, 100, 1.96);
    assert.ok(Math.abs(w.low - 0.4038) < 1e-3 && Math.abs(w.high - 0.5962) < 1e-3);
  });
  it('Newcombe and Welch intervals contain the point estimate and are symmetric-ish in sign', () => {
    const n = newcombeDiff(30, 100, 10, 100, 1.96);
    assert.ok(n.low < n.gap && n.gap < n.high && n.low > 0);
    const w = welchDiff(8000, 650000, 100, 8500, 740000, 100, 1.96);
    assert.ok(w.low < w.gap && w.gap < w.high && Math.abs(w.m1 - 80) < 1e-9);
  });
  it('tolerates empty and negative-variance rounding input', () => {
    assert.deepEqual(wilson(0, 0, 1.96), { p: 0, low: 0, high: 0 });
    const w = welchDiff(100, 99.9999, 2, 100, 100, 2, 1.96);
    assert.ok(Number.isFinite(w.low) && Number.isFinite(w.high));
  });
});

describe('protected attributes', () => {
  it('rejects protected and unknown dimensions, accepts the three allowed ones', () => {
    for (const ok of ['language', 'region', 'customer_type']) assert.doesNotThrow(() => assertAllowedDimension(ok));
    for (const bad of ['gender', 'Race', 'national_origin', 'age', 'user_age', 'ethnicity', 'accent', 'surname', 'zodiac']) {
      assert.throws(() => assertAllowedDimension(bad), bad);
    }
  });
  it('evaluate() throws if a cell carries a protected dimension', () => {
    assert.throws(() => evaluate([cell('gender', 'f')]), /not allowed/);
  });
});

describe('normalisation', () => {
  it('normalises language, customer type and region prefixes', () => {
    assert.equal(normalizeLanguage('es-MX'), 'es');
    assert.equal(normalizeLanguage('PT_br'), 'pt');
    assert.equal(normalizeLanguage(''), 'undetected');
    assert.equal(normalizeLanguage(null), 'undetected');
    assert.equal(normalizeCustomerType('Commercial'), 'commercial');
    assert.equal(normalizeCustomerType('vip'), 'unlinked');
    assert.equal(regionFromPrefix('442'), '+44 GB');
    assert.equal(regionFromPrefix('155'), '+1 North America (NANP)');
    assert.equal(regionFromPrefix('351'), '+351 PT');
    assert.equal(regionFromPrefix('999'), 'other (unmapped code)');
    assert.equal(regionFromPrefix('unknown'), 'unknown (no E.164 number)');
  });
  it('merges prefixes of one region, adds counts, and takes MAX accounts (never inflates)', () => {
    const cells = normalizeCells([
      cell('region', '442', { calls: 40, reviewed: 40, accounts: 3 }),
      cell('region', '447', { calls: 60, reviewed: 50, accounts: 4 }),
    ]);
    assert.equal(cells.length, 1);
    assert.equal(cells[0].group, '+44 GB');
    assert.equal(cells[0].calls, 100);
    assert.equal(cells[0].reviewed, 90);
    assert.equal(cells[0].accounts, 4);
  });
  it('coerces string numbers from the database', () => {
    const [c] = normalizeCells([{ dimension: 'language', group: 'en', calls: '12', reviewed: '10', accounts: '3', score_sum: '800', score_sumsq: '65000', low_score: '1', missed_booking: '0', critical: '0' }]);
    assert.equal(c.calls, 12);
    assert.equal(c.score_sum, 800);
  });
});

describe('suppression (minimum samples)', () => {
  const base = [cell('language', 'en', { calls: 500, accounts: 20 })];
  it('suppresses groups under the reviewed minimum and hides their counts', () => {
    const r = evaluate([...base, cell('language', 'fr', { calls: 29, accounts: 5 })]);
    const fr = flat(r, 'language').find((g) => g.group === 'fr');
    assert.equal(fr.suppressed, true);
    assert.equal(fr.calls, null);
    assert.equal(fr.reviewed, null);
    assert.equal(fr.metrics.length, 0);
    assert.match(fr.suppression_reason, /fewer than 30 reviewed/);
  });
  it('a group with exactly the minimum is evaluated', () => {
    const r = evaluate([...base, cell('language', 'fr', { calls: 30, accounts: 5 })]);
    assert.equal(flat(r, 'language').find((g) => g.group === 'fr').suppressed, false);
  });
  it('suppresses groups backed by too few accounts even with many calls', () => {
    const r = evaluate([...base, cell('language', 'fr', { calls: 400, accounts: 2 })]);
    const fr = flat(r, 'language').find((g) => g.group === 'fr');
    assert.equal(fr.suppressed, true);
    assert.match(fr.suppression_reason, /fewer than 3 accounts/);
  });
  it('suppresses when the comparison population is too small (single group)', () => {
    const r = evaluate([cell('language', 'en', { calls: 200 })]);
    assert.equal(flat(r, 'language')[0].suppressed, true);
    assert.match(flat(r, 'language')[0].suppression_reason, /comparison population/);
  });
  it('options override the defaults', () => {
    const r = evaluate([...base, cell('language', 'fr', { calls: 29, accounts: 5 })], { minReviewed: 20 });
    assert.equal(flat(r, 'language').find((g) => g.group === 'fr').suppressed, false);
  });
  it('handles empty input', () => {
    const r = evaluate([]);
    assert.equal(r.summary.groups_total, 0);
    assert.equal(r.comparisons_tested, 0);
  });
});

describe('disparity detection', () => {
  it('flags a large, significant, adverse score gap and nothing for an identical group', () => {
    const r = evaluate([
      cell('language', 'en', { calls: 800, mean: 85, sd: 8 }),
      cell('language', 'es', { calls: 200, mean: 70, sd: 8 }),
    ]);
    const es = flat(r, 'language').find((g) => g.group === 'es');
    const mean = es.metrics.find((m) => m.key === 'mean_score');
    assert.equal(mean.status, 'gap_adverse');
    assert.ok(mean.gap < -10 && mean.ci_high < 0);
    const same = evaluate([
      cell('customer_type', 'residential', { calls: 500, mean: 80, sd: 10 }),
      cell('customer_type', 'commercial', { calls: 500, mean: 80, sd: 10 }),
    ]);
    assert.equal(same.summary.adverse_gaps, 0);
    assert.equal(same.summary.favorable_gaps, 0);
  });
  it('treats a higher score as favorable, a higher error rate as adverse', () => {
    const r = evaluate([
      cell('customer_type', 'residential', { calls: 900, mean: 80, sd: 8, critical: 9 }),
      cell('customer_type', 'commercial', { calls: 100, mean: 92, sd: 8, critical: 30 }),
    ]);
    const com = flat(r, 'customer_type').find((g) => g.group === 'commercial');
    assert.equal(com.metrics.find((m) => m.key === 'mean_score').status, 'gap_favorable');
    assert.equal(com.metrics.find((m) => m.key === 'critical_finding_rate').status, 'gap_adverse');
  });
  it('does not flag a statistically significant but immaterial gap', () => {
    const r = evaluate([
      cell('language', 'en', { calls: 20000, mean: 80, sd: 8 }),
      cell('language', 'de', { calls: 20000, mean: 78.5, sd: 8 }),
    ]);
    const de = flat(r, 'language').find((g) => g.group === 'de').metrics.find((m) => m.key === 'mean_score');
    assert.ok(de.ci_high < 0);
    assert.equal(de.status, 'no_material_gap');
  });
  it('does not flag a material gap whose interval spans zero (small samples)', () => {
    const r = evaluate([
      cell('language', 'en', { calls: 400, mean: 80, sd: 25 }),
      cell('language', 'it', { calls: 30, mean: 73, sd: 25 }),
    ]);
    const it_ = flat(r, 'language').find((g) => g.group === 'it').metrics.find((m) => m.key === 'mean_score');
    assert.ok(it_.ci_low < 0 && it_.ci_high > 0);
    assert.equal(it_.status, 'no_material_gap');
  });
  it('flags low review coverage as adverse and marks missing-data buckets', () => {
    const r = evaluate([
      cell('language', 'en', { calls: 1000, reviewed: 950 }),
      cell('language', 'undetected', { calls: 300, reviewed: 150 }),
    ]);
    const u = flat(r, 'language').find((g) => g.group === 'undetected');
    assert.equal(u.missing_data, true);
    assert.equal(u.metrics.find((m) => m.key === 'review_coverage').status, 'gap_adverse');
  });
  it('Bonferroni: more comparisons -> larger critical z', () => {
    const few = evaluate([cell('language', 'en', { calls: 500 }), cell('language', 'fr', { calls: 500 })]);
    const many = evaluate([
      cell('language', 'en', { calls: 500 }), cell('language', 'fr', { calls: 500 }), cell('language', 'de', { calls: 500 }),
      cell('region', '442', { calls: 500 }), cell('region', '155', { calls: 500 }), cell('customer_type', 'commercial', { calls: 500 }),
      cell('customer_type', 'residential', { calls: 500 }),
    ]);
    assert.ok(many.comparisons_tested > few.comparisons_tested);
    assert.ok(many.z_critical > few.z_critical && few.z_critical > 1.96);
  });
});

describe('markdown report', () => {
  const report = evaluate([
    cell('language', 'en', { calls: 800, mean: 85, sd: 8 }),
    cell('language', 'es', { calls: 200, mean: 70, sd: 8 }),
    cell('language', 'fr', { calls: 5 }),
  ]);
  const md = renderMarkdown(report, { generated_at: '2029-03-05T00:00:00Z', days: 90, low_score_below: 60 });
  it('contains method, flags, suppression and caveats, and never prints undefined/NaN', () => {
    assert.match(md, /REVIEW \(adverse\)/);
    assert.match(md, /suppressed: fewer than 30 reviewed calls/);
    assert.match(md, /## Caveats/);
    assert.match(md, /Reviewer sign-off/);
    assert.doesNotMatch(md, /undefined|NaN/);
  });
  it('never exposes counts of a suppressed group', () => {
    const line = md.split('\n').find((l) => l.startsWith('| fr '));
    assert.ok(line && !/\b5\b/.test(line.replace('30', '')));
  });
});

describe('CLI', () => {
  it('parses arguments and rejects bad ones', () => {
    assert.equal(parseArgs(['--input', 'x.json']).days, 90);
    assert.equal(parseArgs(['--supabase', '--days', '30', '--min-reviewed', '50']).minReviewed, 50);
    assert.throws(() => parseArgs([]), /exactly one/);
    assert.throws(() => parseArgs(['--input', 'a', '--supabase']), /exactly one/);
    assert.throws(() => parseArgs(['--input', 'a', '--days', '0']), /positive integer/);
    assert.throws(() => parseArgs(['--input', 'a', '--days', '999']), /365/);
    assert.throws(() => parseArgs(['--input', 'a', '--format', 'xml']), /md or json/);
    assert.throws(() => parseArgs(['--input', 'a', '--gender', 'f']), /Unknown argument/);
  });
  it('runs offline from a file, writes the report and honours --fail-on-adverse', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fairness-'));
    const input = join(dir, 'cells.json');
    writeFileSync(input, JSON.stringify({ generated_at: '2029-03-05T00:00:00Z', days: 90, low_score_below: 60, cells: [
      cell('language', 'en', { calls: 800, mean: 85, sd: 8 }), cell('language', 'es', { calls: 200, mean: 70, sd: 8 }),
    ] }));
    const out = join(dir, 'nested', 'report.md');
    const logs = [];
    assert.equal(await run(['--input', input, '--out', out], { log: (m) => logs.push(m) }), 0);
    assert.match(readFileSync(out, 'utf8'), /Fairness audit report/);
    assert.equal(await run(['--input', input, '--out', out, '--fail-on-adverse'], { log: () => {} }), 2);
    assert.equal(await run(['--input', input, '--format', 'json'], { log: (m) => logs.push(m) }), 0);
    assert.ok(JSON.parse(logs.at(-1)).report.summary.adverse_gaps >= 1);
  });
  it('rejects malformed input files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fairness-'));
    const input = join(dir, 'bad.json');
    writeFileSync(input, '{"nope":1}');
    await assert.rejects(run(['--input', input], { log: () => {} }), /array of cells/);
  });
  it('fetchOverview needs env, requires https, sends the key as a header only, and never echoes it on failure', async () => {
    await assert.rejects(fetchOverview({ days: 90, lowScore: 60 }, {}), /must be set/);
    await assert.rejects(fetchOverview({ days: 90, lowScore: 60 }, { SUPABASE_URL: 'http://evil.example', SUPABASE_SERVICE_ROLE_KEY: 'k' }), /https/);
    let seen;
    const ok = await fetchOverview({ days: 30, lowScore: 55 }, { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'sekret' }, async (url, init) => {
      seen = { url: String(url), init };
      return { ok: true, json: async () => ({ cells: [] }) };
    });
    assert.deepEqual(ok, { cells: [] });
    assert.equal(seen.url, 'https://x.supabase.co/rest/v1/rpc/staff_fairness_overview');
    assert.equal(seen.init.headers.authorization, 'Bearer sekret');
    assert.deepEqual(JSON.parse(seen.init.body), { p_days: 30, p_low_score: 55 });
    await assert.rejects(
      fetchOverview({ days: 1, lowScore: 1 }, { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'sekret' }, async () => ({ ok: false, status: 403, text: async () => 'sekret' })),
      (e) => /HTTP 403/.test(e.message) && !/sekret/.test(e.message),
    );
  });
});
