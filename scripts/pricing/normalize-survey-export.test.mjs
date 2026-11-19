// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, normalizeNumber, normalizeTable, parseMapping } from './normalize-survey-export.mjs';
import { buildReport, loadSurvey } from './van-westendorp.mjs';

const MAP = 'Q1=too_cheap,Q2=cheap,Q3=expensive,Q4=too_expensive';
const sink = () => {
  const buf = { out: '', err: '' };
  return { buf, io: { out: (s) => (buf.out += s), err: (s) => (buf.err += s) } };
};

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'vw-norm-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('parseMapping', () => {
  it('parses valid pairs including optional targets', () => {
    expect(parseMapping(`${MAP},Respondent ID=respondent_id,Group=segment`)).toHaveLength(6);
  });

  it('rejects empty, malformed, unknown, duplicate and incomplete mappings', () => {
    expect(() => parseMapping('')).toThrow(/--map is required/);
    expect(() => parseMapping(undefined)).toThrow(/--map is required/);
    expect(() => parseMapping('Q1')).toThrow(/Bad --map entry/);
    expect(() => parseMapping(`${MAP},X=email`)).toThrow(/Unknown target "email"/);
    expect(() => parseMapping(`${MAP},Q9=cheap`)).toThrow(/mapped twice: cheap/);
    expect(() => parseMapping(`${MAP},Q1=segment`)).toThrow(/Source column mapped twice: Q1/);
    expect(() => parseMapping('Q1=too_cheap,Q2=cheap')).toThrow(/expensive, too_expensive/);
  });
});

describe('normalizeNumber', () => {
  const comma = { decimal: 'comma', thousands: 'dot' };

  it('converts decimal comma with dot thousands', () => {
    expect(normalizeNumber('1.234,50', comma)).toEqual({ value: '1234.50', status: 'changed' });
    expect(normalizeNumber('12,5', comma)).toEqual({ value: '12.5', status: 'changed' });
    expect(normalizeNumber('1.234', comma)).toEqual({ value: '1234', status: 'changed' });
    expect(normalizeNumber('12', comma)).toEqual({ value: '12', status: 'unchanged' });
  });

  it('refuses to guess when the cell does not match the declared format', () => {
    // "1.5" under thousands=dot is neither a valid grouped integer nor a comma decimal
    expect(normalizeNumber('1.5', comma)).toEqual({ value: '1.5', status: 'unparsed' });
    expect(normalizeNumber('1.23', comma)).toEqual({ value: '1.23', status: 'unparsed' });
    expect(normalizeNumber('12.345.67', comma)).toEqual({ value: '12.345.67', status: 'unparsed' });
    expect(normalizeNumber('abc', comma)).toEqual({ value: 'abc', status: 'unparsed' });
    expect(normalizeNumber('1e3', { decimal: 'dot' })).toEqual({ value: '1e3', status: 'unparsed' });
    expect(normalizeNumber('1,5', { decimal: 'dot' })).toEqual({ value: '1,5', status: 'unparsed' });
  });

  it('handles dot decimals with and without thousands marks', () => {
    expect(normalizeNumber('12.5', { decimal: 'dot' })).toEqual({ value: '12.5', status: 'unchanged' });
    expect(normalizeNumber('1,234.5', { decimal: 'dot', thousands: 'comma' })).toEqual({ value: '1234.5', status: 'changed' });
    expect(normalizeNumber("1'234", { decimal: 'dot', thousands: 'apostrophe' })).toEqual({ value: '1234', status: 'changed' });
    expect(normalizeNumber('1 234,5', { decimal: 'comma', thousands: 'space' })).toEqual({ value: '1234.5', status: 'changed' });
    expect(normalizeNumber('1\u00A0234', { decimal: 'comma', thousands: 'space' })).toEqual({ value: '1234', status: 'changed' });
    expect(normalizeNumber('1 234', { decimal: 'comma' })).toEqual({ value: '1 234', status: 'unparsed' });
  });

  it('strips only the declared currency tokens and keeps the sign', () => {
    const opts = { decimal: 'comma', thousands: 'dot', strip: ['EUR', '€'] };
    expect(normalizeNumber('EUR 12,5', opts).value).toBe('12.5');
    expect(normalizeNumber('12,5 €', opts).value).toBe('12.5');
    expect(normalizeNumber('-€5', opts).value).toBe('-5');
    expect(normalizeNumber('$12', opts).status).toBe('unparsed');
  });

  it('passes empty cells through for the analysis to report as missing', () => {
    expect(normalizeNumber('', comma)).toEqual({ value: '', status: 'unchanged' });
    expect(normalizeNumber('   ', comma).status).toBe('unchanged');
  });
});

describe('normalizeTable', () => {
  const raw =
    '# SYNTHETIC test export\n' +
    'Name,Email,Respondent ID,Group,Q1,Q2,Q3,Q4\n' +
    'Ann,a@x.test,#1,Small,"10,5","20","30,25","40"\n' +
    'Bob,b@x.test,2,"Big, Inc",5,abc,7,8\n' +
    'Cy,c@x.test,3,Small,1,2,3\n';
  const mapping = parseMapping(`${MAP},Respondent ID=respondent_id,Group=segment`);
  const { csv, summary } = normalizeTable(raw, { mapping, decimal: 'comma', thousands: 'dot' });

  it('drops unmapped columns, so personal data never reaches the analysis file', () => {
    expect(summary.dropped_columns).toEqual(['Name', 'Email']);
    expect(csv).not.toMatch(/a@x\.test|Ann|Bob/);
  });

  it('writes canonical headers, converts prices and preserves comments with a provenance line', () => {
    const lines = csv.trim().split('\n');
    expect(lines[0]).toMatch(/^# normalized by .*decimal=comma, thousands=dot/);
    expect(lines[1]).toBe('# SYNTHETIC test export');
    expect(lines[2]).toBe('respondent_id,segment,too_cheap,cheap,expensive,too_expensive');
    expect(lines[3]).toBe('"#1",Small,10.5,20,30.25,40');
    expect(lines[4]).toBe('2,"Big, Inc",5,abc,7,8');
  });

  it('counts conversions and unparsed cells per column and never drops a row', () => {
    expect(summary.rows).toBe(3);
    expect(summary.columns.too_cheap).toEqual({ changed: 1, unparsed: 0 });
    expect(summary.columns.cheap).toEqual({ changed: 0, unparsed: 1 });
    expect(summary.columns.expensive).toEqual({ changed: 1, unparsed: 0 });
  });

  it('keeps short rows as malformed instead of silently repairing them', () => {
    expect(summary.malformed_rows).toBe(1);
  });

  it('produces a file the analysis loads, reporting each problem by its own reason', () => {
    const s = loadSurvey(csv);
    expect(s.synthetic).toBe(true);
    expect(s.records.map((r) => r.id)).toEqual(['#1']);
    expect(s.exclusions.map((e) => e.reason)).toEqual(['non_numeric', 'malformed_row']);
    expect(s.records[0]).toMatchObject({ segment: 'Small', tooCheap: 10.5, expensive: 30.25 });
    expect(buildReport(csv).source.valid).toBe(1);
  });

  it('rejects a missing source column and invalid settings', () => {
    expect(() => normalizeTable(raw, { mapping: parseMapping(MAP.replace('Q4', 'Q9')), decimal: 'dot' })).toThrow(/Source column not found: Q9/);
    expect(() => normalizeTable(raw, { mapping, decimal: 'semicolon' })).toThrow(/--decimal/);
    expect(() => normalizeTable(raw, { mapping })).toThrow(/--decimal/);
    expect(() => normalizeTable(raw, { mapping, decimal: 'dot', thousands: 'dot' })).toThrow(/cannot be the same/);
    expect(() => normalizeTable(raw, { mapping, decimal: 'dot', thousands: 'tab' })).toThrow(/--thousands/);
    expect(() => normalizeTable(raw, { mapping, decimal: 'dot', strip: ['1'] })).toThrow(/--strip token/);
    expect(() => normalizeTable(raw, { mapping, decimal: 'dot', strip: ['kr.'] })).toThrow(/--strip token/);
    expect(() => normalizeTable('', { mapping, decimal: 'dot' })).toThrow(/no header/);
  });
});

describe('CLI main()', () => {
  const file = () => {
    const f = path.join(tmp, 'export.csv');
    writeFileSync(f, 'Q1,Q2,Q3,Q4\n"1,5","2,5","3,5","4,5"\n');
    return f;
  };

  it('prints help and returns 0', () => {
    const { buf, io } = sink();
    expect(main(['-h'], io)).toBe(0);
    expect(buf.out).toMatch(/Usage:/);
  });

  it('writes CSV to stdout and the summary to stderr', () => {
    const { buf, io } = sink();
    expect(main([file(), '--map', MAP, '--decimal', 'comma'], io)).toBe(0);
    expect(buf.out).toMatch(/too_cheap,cheap,expensive,too_expensive\n1\.5,2\.5,3\.5,4\.5\n/);
    expect(buf.err).toMatch(/rows: 1/);
    expect(buf.err).toMatch(/too_cheap: converted 1, left unparsed 0/);
  });

  it('writes --out, refuses to overwrite without --force and never overwrites the input', () => {
    const f = file();
    const out = path.join(tmp, 'clean.csv');
    expect(main([f, '--map', MAP, '--decimal', 'comma', '--out', out], sink().io)).toBe(0);
    expect(readFileSync(out, 'utf8')).toMatch(/^# normalized by/);

    const again = sink();
    expect(main([f, '--map', MAP, '--decimal', 'comma', '--out', out], again.io)).toBe(1);
    expect(again.buf.err).toMatch(/already exists/);
    expect(main([f, '--map', MAP, '--decimal', 'comma', '--out', out, '--force'], sink().io)).toBe(0);

    const same = sink();
    expect(main([f, '--map', MAP, '--decimal', 'comma', '--out', f, '--force'], same.io)).toBe(1);
    expect(same.buf.err).toMatch(/must not be the input/);
    expect(readFileSync(f, 'utf8')).toMatch(/^Q1,Q2,Q3,Q4/);
  });

  it('fails cleanly on missing flags, missing file and bad mapping', () => {
    for (const args of [
      [],
      [file()],
      [file(), '--map', MAP],
      [file(), '--map', 'Q1=too_cheap', '--decimal', 'dot'],
      [path.join(tmp, 'nope.csv'), '--map', MAP, '--decimal', 'dot'],
      [file(), '--map', MAP, '--decimal', 'dot', '--nope'],
    ]) {
      const { buf, io } = sink();
      expect(main(args, io)).toBe(1);
      expect(buf.err).toMatch(/Error:/);
      expect(buf.err).not.toMatch(/\n\s+at /);
      expect(buf.out).toBe('');
    }
  });
});
