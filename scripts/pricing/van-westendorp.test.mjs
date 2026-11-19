// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DISCLAIMER,
  HARD_MIN_N,
  analyzeGroup,
  bootstrapPoints,
  buildReport,
  computeCurves,
  computePoints,
  csvCell,
  findCrossing,
  loadSurvey,
  main,
  mulberry32,
  parseCsv,
  parsePrice,
  quantile,
  toCurvesCsv,
  toSvg,
  toText,
} from './van-westendorp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'van-westendorp.mjs');
const FIXTURE = path.join(HERE, 'fixtures', 'van-westendorp.synthetic-fake.csv');
const header = 'respondent_id,segment,too_cheap,cheap,expensive,too_expensive\n';

// Four hand-made respondents; every expected number below was derived by hand (see comments).
const TINY = [
  { tooCheap: 10, cheap: 20, expensive: 30, tooExpensive: 40 },
  { tooCheap: 10, cheap: 25, expensive: 35, tooExpensive: 50 },
  { tooCheap: 15, cheap: 30, expensive: 40, tooExpensive: 60 },
  { tooCheap: 20, cheap: 35, expensive: 45, tooExpensive: 70 },
];

const sink = () => {
  const buf = { out: '', err: '' };
  return { buf, io: { out: (s) => (buf.out += s), err: (s) => (buf.err += s) } };
};

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'vw-test-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('parseCsv', () => {
  it('handles BOM, CRLF, quotes, escaped quotes and comments', () => {
    const text = '\uFEFF# a comment\r\na,b\r\n"x,1","he said ""hi"""\r\n\r\n';
    const { rows, comments } = parseCsv(text);
    expect(comments).toEqual(['a comment']);
    expect(rows).toEqual([
      ['a', 'b'],
      ['x,1', 'he said "hi"'],
    ]);
  });

  it('keeps a quoted field with an embedded newline together', () => {
    expect(parseCsv('a\n"l1\nl2"\n').rows).toEqual([['a'], ['l1\nl2']]);
  });

  it('does not treat # inside a row as a comment', () => {
    expect(parseCsv('a,b\n#x,1\n1,#2\n').rows).toEqual([
      ['a', 'b'],
      ['1', '#2'],
    ]);
  });

  it('throws on an unterminated quote', () => {
    expect(() => parseCsv('a\n"oops\n')).toThrow(/Unterminated/);
  });
});

describe('parsePrice', () => {
  it('accepts plain non-negative decimals', () => {
    expect(parsePrice('12')).toEqual({ value: 12 });
    expect(parsePrice(' 12.5 ')).toEqual({ value: 12.5 });
    expect(parsePrice('0')).toEqual({ value: 0 });
    expect(parsePrice('.5')).toEqual({ value: 0.5 });
  });

  it('rejects anything else with a specific reason', () => {
    expect(parsePrice('')).toEqual({ error: 'missing_value' });
    expect(parsePrice(undefined)).toEqual({ error: 'missing_value' });
    expect(parsePrice('-3')).toEqual({ error: 'negative_value' });
    expect(parsePrice('1,5')).toEqual({ error: 'non_numeric' });
    expect(parsePrice('1e3')).toEqual({ error: 'non_numeric' });
    expect(parsePrice('$10')).toEqual({ error: 'non_numeric' });
    expect(parsePrice('NaN')).toEqual({ error: 'non_numeric' });
    expect(parsePrice('99999999999')).toEqual({ error: 'out_of_range' });
  });
});

describe('loadSurvey', () => {
  it('throws on missing required columns and names them', () => {
    expect(() => loadSurvey('too_cheap,cheap\n1,2\n')).toThrow(/expensive, too_expensive/);
  });

  it('throws on empty input, duplicate columns and bad segment column', () => {
    expect(() => loadSurvey('')).toThrow(/no header/);
    expect(() => loadSurvey('too_cheap,cheap,cheap,expensive,too_expensive\n')).toThrow(/Duplicate/);
    const ok = 'too_cheap,cheap,expensive,too_expensive\n1,2,3,4\n';
    expect(() => loadSurvey(ok, { segmentColumn: 'region' })).toThrow(/not found/);
    expect(() => loadSurvey(ok, { segmentColumn: 'cheap' })).toThrow(/price column/);
  });

  it('accepts header aliases and spacing/case differences', () => {
    const s = loadSurvey('ID, Too Cheap,Bargain,Getting-Expensive,Too_Expensive\nr1,1,2,3,4\n');
    expect(s.records).toHaveLength(1);
    expect(s.records[0]).toMatchObject({ id: 'r1', tooCheap: 1, cheap: 2, expensive: 3, tooExpensive: 4 });
  });

  it('excludes and counts each invalid row type instead of repairing it', () => {
    const csv =
      header +
      'r1,a,1,2,3,4\n' + // valid
      'r2,a,5,2,3,4\n' + // order_violation
      'r3,a,,2,3,4\n' + // missing_value
      'r4,a,x,2,3,4\n' + // non_numeric
      'r5,a,-1,2,3,4\n' + // negative_value
      'r1,a,1,2,3,4\n' + // duplicate_respondent_id
      'r6,a,1,2,3,4,9\n'; // malformed_row
    const s = loadSurvey(csv);
    expect(s.records.map((r) => r.id)).toEqual(['r1']);
    expect(s.exclusions.map((e) => e.reason)).toEqual([
      'order_violation',
      'missing_value',
      'non_numeric',
      'negative_value',
      'duplicate_respondent_id',
      'malformed_row',
    ]);
    expect(s.totalRows).toBe(7);
  });

  it('allows ties by default and rejects them with strictOrder', () => {
    const csv = 'too_cheap,cheap,expensive,too_expensive\n5,5,9,9\n';
    expect(loadSurvey(csv).records).toHaveLength(1);
    const strict = loadSurvey(csv, { strictOrder: true });
    expect(strict.records).toHaveLength(0);
    expect(strict.exclusions[0].reason).toBe('order_violation');
  });

  it('keeps straight-lining rows by default and excludes them only on request', () => {
    const csv = 'too_cheap,cheap,expensive,too_expensive\n7,7,7,7\n1,2,3,4\n';
    expect(loadSurvey(csv).records).toHaveLength(2);
    const s = loadSurvey(csv, { excludeStraightLining: true });
    expect(s.records).toHaveLength(1);
    expect(s.exclusions.map((e) => e.reason)).toEqual(['straight_lining']);
    // a row with a repeated value that is not identical in all four fields is not straight-lining
    expect(loadSurvey('too_cheap,cheap,expensive,too_expensive\n7,7,7,8\n', { excludeStraightLining: true }).records).toHaveLength(1);
  });

  it('reports straight-lining as its own reason even under strictOrder', () => {
    const csv = 'too_cheap,cheap,expensive,too_expensive\n7,7,7,7\n';
    const s = loadSurvey(csv, { strictOrder: true, excludeStraightLining: true });
    expect(s.exclusions[0].reason).toBe('straight_lining');
  });

  it('detects the synthetic marker only from comments', () => {
    const base = 'too_cheap,cheap,expensive,too_expensive\n1,2,3,4\n';
    expect(loadSurvey(`# SYNTHETIC data\n${base}`).synthetic).toBe(true);
    expect(loadSurvey(`# these are fake rows\n${base}`).synthetic).toBe(true);
    expect(loadSurvey(base).synthetic).toBe(false);
  });

  it('labels blank segments as unspecified and reports no segments without the column', () => {
    const s = loadSurvey(header + 'r1,,1,2,3,4\n');
    expect(s.hasSegments).toBe(true);
    expect(s.records[0].segment).toBe('(unspecified)');
    expect(loadSurvey('too_cheap,cheap,expensive,too_expensive\n1,2,3,4\n').hasSegments).toBe(false);
  });
});

describe('curves and intersections (hand-derived)', () => {
  const curves = computeCurves(TINY);

  it('builds the price grid from every observed value', () => {
    expect(curves.price).toEqual([10, 15, 20, 25, 30, 35, 40, 45, 50, 60, 70]);
  });

  it('computes the cumulative shares', () => {
    // too cheap: share saying <= p is too cheap -> share with threshold >= p
    expect(curves.tooCheap.slice(0, 4)).toEqual([1, 0.5, 0.25, 0]);
    // cheap at p=20 is everyone, at 40 nobody
    expect(curves.cheap[2]).toBe(1);
    expect(curves.cheap[6]).toBe(0);
    expect(curves.notCheap[3]).toBe(0.25);
    // expensive at 30..45 climbs 25% per step
    expect(curves.expensive.slice(4, 8)).toEqual([0.25, 0.5, 0.75, 1]);
    expect(curves.tooExpensive[6]).toBe(0.25);
  });

  it('keeps the monotonicity every PSM curve must have', () => {
    const nonInc = (a) => a.every((v, i) => i === 0 || v <= a[i - 1] + 1e-12);
    const nonDec = (a) => a.every((v, i) => i === 0 || v >= a[i - 1] - 1e-12);
    expect(nonInc(curves.tooCheap) && nonInc(curves.cheap) && nonInc(curves.notExpensive)).toBe(true);
    expect(nonDec(curves.notCheap) && nonDec(curves.expensive) && nonDec(curves.tooExpensive)).toBe(true);
  });

  it('finds PMC, OPP (plateau midpoint), IPP and PME', () => {
    const p = computePoints(curves);
    expect(p.PMC.price).toBeCloseTo(22.5, 9);
    expect(p.PMC.share).toBeCloseTo(0.125, 9);
    expect(p.OPP.price).toBeCloseTo(30, 9); // curves coincide at 0 from 25 to 35
    expect(p.OPP.share).toBeCloseTo(0, 9);
    expect(p.IPP.price).toBeCloseTo(32.5, 9);
    expect(p.IPP.share).toBeCloseTo(0.375, 9);
    expect(p.PME.price).toBeCloseTo(40, 9);
    expect(p.PME.share).toBeCloseTo(0.25, 9);
  });

  it('returns empty curves and null points for no respondents', () => {
    const empty = computeCurves([]);
    expect(empty.price).toEqual([]);
    expect(computePoints(empty)).toEqual({ PMC: null, OPP: null, IPP: null, PME: null });
  });
});

describe('findCrossing', () => {
  it('interpolates linearly between grid points', () => {
    const c = findCrossing([0, 10], [1, 0], [0, 1]);
    expect(c.price).toBeCloseTo(5, 9);
    expect(c.share).toBeCloseTo(0.5, 9);
  });

  it('returns null when the curves never cross or already crossed at the first point', () => {
    expect(findCrossing([0, 10], [1, 0.8], [0, 0.2])).toBeNull();
    expect(findCrossing([0, 10], [0.2, 0], [0.8, 1])).toBeNull();
    expect(findCrossing([], [], [])).toBeNull();
  });
});

describe('bootstrap', () => {
  it('is reproducible for a seed and returns ordered intervals', () => {
    const a = bootstrapPoints(TINY, { iterations: 200, seed: 7 });
    const b = bootstrapPoints(TINY, { iterations: 200, seed: 7 });
    expect(a).toEqual(b);
    for (const iv of Object.values(a.intervals)) {
      if (iv.defined > 0) expect(iv.low).toBeLessThanOrEqual(iv.high);
      expect(iv.defined).toBeLessThanOrEqual(200);
    }
  });

  it('mulberry32 is deterministic and in [0,1)', () => {
    const r1 = mulberry32(1);
    const r2 = mulberry32(1);
    const xs = Array.from({ length: 50 }, () => r1());
    expect(xs).toEqual(Array.from({ length: 50 }, () => r2()));
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  });

  it('quantile interpolates and handles empty input', () => {
    expect(quantile([], 0.5)).toBeNull();
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 4], 0)).toBe(1);
    expect(quantile([1, 2, 3, 4], 1)).toBe(4);
  });
});

describe('analyzeGroup', () => {
  const many = (k) => Array.from({ length: k }, (_, i) => ({ ...TINY[i % 4], segment: 's' }));

  it('refuses to compute below the hard minimum', () => {
    const g = analyzeGroup('tiny', many(HARD_MIN_N - 1));
    expect(g.status).toBe('insufficient_sample');
    expect(g.curves).toBeNull();
    expect(g.points).toBeNull();
  });

  it('warns below the recommended minimum but still computes', () => {
    const g = analyzeGroup('small', many(HARD_MIN_N), { minN: 100 });
    expect(g.status).toBe('ok');
    expect(g.warnings.join(' ')).toMatch(/below the recommended minimum of 100/);
    expect(analyzeGroup('small', many(HARD_MIN_N), { minN: 5 }).warnings).toEqual([]);
  });

  it('reports undefined points and no range instead of inventing one', () => {
    // Everyone gives the same price four times: PMC and PME have no crossing inside the grid.
    const same = Array.from({ length: 12 }, () => ({ tooCheap: 5, cheap: 5, expensive: 5, tooExpensive: 5 }));
    const g = analyzeGroup('same', same, { minN: 1 });
    expect(g.status).toBe('ok');
    expect(g.points.PMC).toBeNull();
    expect(g.points.PME).toBeNull();
    expect(g.range).toBeNull();
    expect(g.warnings.join(' ')).toMatch(/PMC is undefined/);
    expect(g.warnings.join(' ')).toMatch(/PME is undefined/);
  });

  it('flags an inverted acceptable range and withholds it', () => {
    // Valid, tie-heavy answers from two very different respondent types give PMC above PME.
    const a = { tooCheap: 4, cheap: 4, expensive: 5, tooExpensive: 5 };
    const b = { tooCheap: 1, cheap: 3, expensive: 3, tooExpensive: 3 };
    const recs = [...Array(6).fill(a), ...Array(6).fill(b)];
    const g = analyzeGroup('inverted', recs, { minN: 1 });
    expect(g.points.PMC.price).toBeGreaterThan(g.points.PME.price);
    expect(g.range).toBeNull();
    expect(g.warnings.join(' ')).toMatch(/inverted/);
  });
});

describe('buildReport on the synthetic fixture', () => {
  const text = readFileSync(FIXTURE, 'utf8');
  const report = buildReport(text, { sourceName: '/some/abs/dir/sample.csv', minN: 20, bootstrap: 100 });

  it('is labeled synthetic everywhere it matters', () => {
    expect(text.split('\n')[0]).toMatch(/SYNTHETIC \/ FAKE DATA/);
    expect(report.synthetic).toBe(true);
    expect(report.warnings.some((w) => /SYNTHETIC DATA/.test(w))).toBe(true);
    expect(toText(report)).toMatch(/SYNTHETIC \/ FAKE DATA - FOR TESTING ONLY - NOT EVIDENCE/);
    expect(report.disclaimer).toBe(DISCLAIMER);
  });

  it('counts the planted invalid rows exactly and hides the absolute path', () => {
    expect(report.source.name).toBe('sample.csv');
    expect(report.source.rows).toBe(36);
    expect(report.source.valid).toBe(30);
    expect(report.source.excluded.by_reason).toEqual({
      order_violation: 1,
      missing_value: 1,
      non_numeric: 1,
      negative_value: 1,
      duplicate_respondent_id: 1,
      malformed_row: 1,
    });
  });

  it('analyses overall plus one group per segment, sorted', () => {
    expect(report.groups.map((g) => `${g.kind}:${g.name}:${g.n}`)).toEqual([
      'overall:overall:30',
      'segment:segment_a:15',
      'segment:segment_b:15',
    ]);
    for (const g of report.groups) {
      expect(g.status).toBe('ok');
      expect(g.bootstrap.iterations).toBe(100);
    }
  });

  it('is deterministic for the same input and options', () => {
    const again = buildReport(text, { sourceName: 'sample.csv', minN: 20, bootstrap: 100 });
    expect(again).toEqual(report);
  });

  it('matches an independent calculation of the overall points', () => {
    const o = report.groups[0].points;
    expect([o.PMC.price, o.OPP.price, o.IPP.price, o.PME.price]).toEqual([35, 55, 58, 90]);
    expect(report.groups[0].range).toEqual({ low: 35, high: 90 });
  });

  it('warns when more than 10% of rows are excluded', () => {
    expect(report.warnings.some((w) => /excluded/.test(w))).toBe(true);
  });
});

describe('rendering', () => {
  const report = buildReport(readFileSync(FIXTURE, 'utf8'), { minN: 1 });

  it('writes one CSV row per grid point with a stable header', () => {
    const lines = toCurvesCsv(report).trim().split('\n');
    expect(lines[0]).toBe(
      'group,kind,price,too_cheap,cheap,not_cheap,expensive,not_expensive,too_expensive',
    );
    const expected = report.groups.reduce((s, g) => s + g.curves.price.length, 0);
    expect(lines).toHaveLength(expected + 1);
  });

  it('guards CSV cells against formula injection and quotes specials', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "x"')).toBe('"say ""x"""');
    expect(csvCell('plain')).toBe('plain');
  });

  it('renders an SVG with six curves, four markers, escaped labels and the fake banner', () => {
    const svg = toSvg({ ...report.groups[0], name: 'A <&> "B"' }, { synthetic: true, currency: 'EUR' });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.match(/<polyline/g)).toHaveLength(6);
    expect(svg.match(/<circle/g)).toHaveLength(4);
    expect(svg).toContain('A &lt;&amp;&gt; &quot;B&quot;');
    expect(svg).not.toContain('<&>');
    expect(svg).toContain('SYNTHETIC DATA - NOT EVIDENCE');
    expect(svg).toContain('Price (EUR)');
    expect(toSvg({ curves: null })).toBeNull();
  });

  it('omits the banner for non-synthetic data', () => {
    expect(toSvg(report.groups[0], { synthetic: false })).not.toContain('SYNTHETIC');
  });
});

describe('CLI main()', () => {
  it('prints help and returns 0', () => {
    const { buf, io } = sink();
    expect(main(['--help'], io)).toBe(0);
    expect(buf.out).toMatch(/Usage:/);
  });

  it('rejects missing or extra paths, bad numbers, bad format, unknown flags', () => {
    for (const args of [
      [],
      ['a.csv', 'b.csv'],
      [FIXTURE, '--bootstrap', '20000'],
      [FIXTURE, '--min-n', '0'],
      [FIXTURE, '--seed', '-1'],
      [FIXTURE, '--format', 'xml'],
      [FIXTURE, '--currency', 'EURO'],
      [FIXTURE, '--nope'],
    ]) {
      const { buf, io } = sink();
      expect(main(args, io)).toBe(1);
      expect(buf.err).toMatch(/Error:/);
      expect(buf.out).toBe('');
    }
  });

  it('reports a missing file without a stack trace', () => {
    const { buf, io } = sink();
    expect(main([path.join(tmp, 'nope.csv')], io)).toBe(1);
    expect(buf.err).toMatch(/file not found/);
    expect(buf.err).not.toMatch(/\n\s+at /);
  });

  it('reports malformed input as a clean error', () => {
    const bad = path.join(tmp, 'bad.csv');
    writeFileSync(bad, 'a,b\n1,2\n');
    const { buf, io } = sink();
    expect(main([bad], io)).toBe(1);
    expect(buf.err).toMatch(/Missing required column/);
  });

  it('emits parseable JSON on stdout and files in --out-dir, logging paths on stderr only', () => {
    const outDir = path.join(tmp, 'out');
    const { buf, io } = sink();
    expect(main([FIXTURE, '--format', 'json', '--out-dir', outDir, '--currency', 'eur'], io)).toBe(0);
    const json = JSON.parse(buf.out);
    expect(json.schema).toBe('vireek.pricing.van-westendorp/1');
    expect(json.currency).toBe('EUR');
    expect(readdirSync(outDir).sort()).toEqual([
      'van-westendorp.curves.csv',
      'van-westendorp.overall.svg',
      'van-westendorp.report.json',
      'van-westendorp.segment-01-segment-a.svg',
      'van-westendorp.segment-02-segment-b.svg',
    ]);
    expect(JSON.parse(readFileSync(path.join(outDir, 'van-westendorp.report.json'), 'utf8'))).toEqual(json);
    expect(buf.err.split('\n').filter(Boolean)).toHaveLength(5);
  });

  it('honours --exclude-straight-lining and records it in the report options', () => {
    const f = path.join(tmp, 'sl.csv');
    writeFileSync(f, 'too_cheap,cheap,expensive,too_expensive\n5,5,5,5\n1,2,3,4\n');
    const off = sink();
    expect(main([f, '--format', 'json'], off.io)).toBe(0);
    expect(JSON.parse(off.buf.out).source.valid).toBe(2);
    expect(JSON.parse(off.buf.out).options.exclude_straight_lining).toBe(false);
    const on = sink();
    expect(main([f, '--format', 'json', '--exclude-straight-lining'], on.io)).toBe(0);
    const json = JSON.parse(on.buf.out);
    expect(json.source.valid).toBe(1);
    expect(json.source.excluded.by_reason).toEqual({ straight_lining: 1 });
    expect(json.options.exclude_straight_lining).toBe(true);
  });

  it('honours --segment-column', () => {
    const f = path.join(tmp, 'seg.csv');
    const rows = Array.from({ length: 12 }, (_, i) => `${10 + i},${20 + i},${30 + i},${40 + i},${i % 2 ? 'x' : 'y'}`);
    writeFileSync(f, `too_cheap,cheap,expensive,too_expensive,region\n${rows.join('\n')}\n`);
    const { buf, io } = sink();
    expect(main([f, '--segment-column', 'region', '--format', 'json', '--min-n', '1'], io)).toBe(0);
    expect(JSON.parse(buf.out).groups.map((g) => g.name)).toEqual(['overall', 'x', 'y']);
  });

  it('runs as a real process', () => {
    const r = spawnSync(process.execPath, [SCRIPT, FIXTURE], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/NOT EVIDENCE/);
    const bad = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    expect(bad.status).toBe(1);
  });
});
