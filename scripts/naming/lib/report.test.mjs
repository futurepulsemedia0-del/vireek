// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runScreen } from '../screen.mjs';
import { parseCsv } from './input.mjs';
import { normalizeAffixConfig } from './linguistic.mjs';
import { normalizeBrandList } from './lookalike.mjs';
import { RDAP_STATUS } from './rdap.mjs';
import {
  CSV_COLUMNS,
  DEFAULT_WEIGHTS,
  csvCell,
  domainSignal,
  parseWeights,
  toCsv,
  toMarkdown,
  weightedTotal,
  writeOutputs,
} from './report.mjs';

let realFetch;
beforeEach(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('real network is blocked in tests');
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const STATUS_BY_TLD = { com: RDAP_STATUS.REGISTERED, ai: RDAP_STATUS.NO_RECORD, io: RDAP_STATUS.ERROR, co: RDAP_STATUS.REGISTERED };
const fakeClient = {
  lookup: async (label, tld) => ({ domain: `${label}.${tld}`, tld, status: STATUS_BY_TLD[tld], detail: 'mock', source: 'rdap.mock.test', attempts: 1, httpStatus: null }),
};
const brands = normalizeBrandList(['stripe', 'xero']);
const affixes = normalizeAffixConfig({ prefixes: ['nova'], suffixes: ['ora'] });
const weights = parseWeights();

async function sample() {
  const results = await runScreen({ names: ['vireek', 'stripy', 'nexora'], brands, affixes, weights, client: fakeClient });
  const generatedAt = '2026-11-09T00:00:00.000Z';
  return {
    results,
    markdown: toMarkdown({ generatedAt, weights, results, rejected: [{ input: 'ab', reason: 'shorter than 4 letters' }], duplicates: ['lumen'] }),
    csv: toCsv(results),
  };
}

describe('wording rules', () => {
  it('never says a domain or name is obtainable (markdown and CSV)', async () => {
    const { markdown, csv } = await sample();
    for (const text of [markdown, csv]) {
      expect(text).not.toMatch(/availab/i);
      expect(text).not.toMatch(/\bfree/i);
    }
  });

  it('uses only the three allowed domain statuses', async () => {
    const { csv } = await sample();
    const rows = parseCsv(csv);
    const idx = ['domain_com', 'domain_ai', 'domain_io', 'domain_co'].map((c) => rows[0].indexOf(c));
    const allowed = new Set(Object.values(RDAP_STATUS));
    for (const row of rows.slice(1)) for (const i of idx) expect(allowed.has(row[i])).toBe(true);
  });

  it('states that it is a screen, not clearance, and requires an attorney', async () => {
    const { markdown } = await sample();
    expect(markdown).toContain('screen, not clearance');
    expect(markdown).toContain('attorney');
  });
});

describe('manual-check defaults', () => {
  it('defaults every manual CSV cell to NOT DONE and scores the component 0', async () => {
    const { csv } = await sample();
    const rows = parseCsv(csv);
    const header = rows[0];
    const manual = header.filter((c) => c.startsWith('manual_') && c !== 'manual_check_score');
    expect(manual.length).toBeGreaterThanOrEqual(7);
    for (const row of rows.slice(1)) {
      for (const c of manual) expect(row[header.indexOf(c)]).toBe('NOT DONE');
      expect(row[header.indexOf('manual_check_score')]).toBe('0');
    }
  });

  it('caps the weighted total below 100 minus the manual weight', async () => {
    const { results } = await sample();
    for (const r of results) expect(r.total).toBeLessThanOrEqual(100 - weights.manualCheck + 0.1);
  });
});

describe('markdown report content', () => {
  it('contains the databases, Nice classes, social checks and input problems', async () => {
    const { markdown } = await sample();
    for (const needle of ['WIPO Global Brand Database', 'USPTO', 'EUIPO', 'TMview', 'Nice classes: 9 (', '35 (', '36 (', '42 (', '44 (', 'Instagram', 'Rejected `ab`', 'Duplicate ignored: `lumen`', '- [ ]', 'NOT DONE']) {
      expect(markdown).toContain(needle);
    }
  });
  it('flags the lookalike and saturation findings', async () => {
    const { results } = await sample();
    const stripy = results.find((r) => r.name === 'stripy');
    expect(stripy.flags).toContain('LOOKALIKE-HIGH');
    expect(results.find((r) => r.name === 'nexora').flags).toContain('SUFFIX-SATURATED:ora');
  });
});

describe('CSV safety and shape', () => {
  it('quotes properly and neutralises spreadsheet formulas', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell(null)).toBe('');
  });
  it('writes rectangular rows that match the header', async () => {
    const { csv } = await sample();
    const rows = parseCsv(csv);
    expect(rows[0]).toEqual([...CSV_COLUMNS]);
    for (const r of rows) expect(r).toHaveLength(CSV_COLUMNS.length);
    expect(rows).toHaveLength(4);
  });
});

describe('scoring', () => {
  it('weights default to 100 in total and can be overridden and normalised', () => {
    expect(Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
    const w = parseWeights('pronounceability=50,internationalFit=0,lookalike=0,domainSignal=0,manualCheck=50');
    expect(w.pronounceability).toBe(50);
    expect(Object.values(w).reduce((a, b) => a + b, 0)).toBeCloseTo(100, 5);
    expect(() => parseWeights('nope=1')).toThrow('Unknown weight');
    expect(() => parseWeights('lookalike=-1')).toThrow('non-negative');
    expect(() => parseWeights('pronounceability=0,internationalFit=0,lookalike=0,domainSignal=0,manualCheck=0')).toThrow('zero');
  });
  it('computes domain signal from definitive results only', () => {
    const d = (tld, status) => ({ tld, status });
    expect(domainSignal([d('com', RDAP_STATUS.REGISTERED), d('ai', RDAP_STATUS.NO_RECORD), d('io', RDAP_STATUS.ERROR), d('co', RDAP_STATUS.REGISTERED)])).toEqual({ score: 25, coverage: '3/4', partial: true });
    expect(domainSignal([d('com', RDAP_STATUS.ERROR)]).score).toBeNull();
    expect(domainSignal([d('com', RDAP_STATUS.NO_RECORD)]).score).toBe(100);
  });
  it('combines components with lookalike inverted', () => {
    const parts = { pronounceability: 100, internationalFit: 100, lookalikeRisk: 0, domainSignal: 100, manualCheck: 100 };
    expect(weightedTotal(parts, weights)).toBe(100);
    expect(weightedTotal({ ...parts, lookalikeRisk: 100, manualCheck: 0, domainSignal: null }, weights)).toBe(45);
  });
});

describe('writeOutputs', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'naming-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes both files and refuses to overwrite earlier output', () => {
    const args = { dir: path.join(dir, 'nested'), stamp: 'T1', markdown: '# a\n', csv: 'x\r\n' };
    const { mdPath, csvPath } = writeOutputs(args);
    expect(readFileSync(mdPath, 'utf8')).toBe('# a\n');
    expect(readFileSync(csvPath, 'utf8')).toBe('x\r\n');
    expect(() => writeOutputs({ ...args, markdown: 'changed' })).toThrow(/EEXIST/);
    expect(readFileSync(mdPath, 'utf8')).toBe('# a\n');
  });
});
