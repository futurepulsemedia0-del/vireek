// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { MAX_NAMES, normalizeName, parseCandidates, parseCsv, validateName } from './input.mjs';

describe('validateName', () => {
  it('accepts 4-8 letters and rejects everything else', () => {
    expect(validateName('vireek')).toBeNull();
    expect(validateName('abcd')).toBeNull();
    expect(validateName('abcdefgh')).toBeNull();
    expect(validateName('abc')).toContain('shorter');
    expect(validateName('abcdefghi')).toContain('longer');
    expect(validateName('my name')).toContain('letters a-z only');
    expect(validateName('abc123')).toContain('letters a-z only');
    expect(validateName('')).toBe('empty');
  });
});

describe('normalizeName', () => {
  it('folds accents and case, and reports the change', () => {
    expect(normalizeName('  Café ')).toEqual({ original: 'Café', name: 'cafe', changed: true });
    expect(normalizeName('Vireek').changed).toBe(false);
  });
});

describe('parseCsv', () => {
  it('handles quotes, doubled quotes, CRLF and BOM', () => {
    expect(parseCsv('\uFEFFa,"b,1","c ""q"""\r\nx,y,z\r\n')).toEqual([
      ['a', 'b,1', 'c "q"'],
      ['x', 'y', 'z'],
    ]);
  });
});

describe('parseCandidates', () => {
  it('reads a JSON array, {names} and {name} objects', () => {
    expect(parseCandidates('["Vireek","nexora"]').accepted.map((a) => a.name)).toEqual(['vireek', 'nexora']);
    expect(parseCandidates('{"names":["lumen"]}').accepted[0].name).toBe('lumen');
    expect(parseCandidates('[{"name":"orbit"}]').accepted[0].name).toBe('orbit');
  });

  it('reads CSV with and without a header, and plain lines', () => {
    expect(parseCandidates('name,notes\nvireek,x\nlumen,y', 'csv').accepted).toHaveLength(2);
    expect(parseCandidates('vireek\nlumen\n', 'csv').accepted).toHaveLength(2);
    expect(parseCandidates('id,Name\n1,orbit', 'csv').accepted[0].name).toBe('orbit');
  });

  it('rejects bad names with reasons and keeps going', () => {
    const r = parseCandidates('["ok name","abc","toolongname","fine","x1y2z3",42]');
    expect(r.accepted.map((a) => a.name)).toEqual(['fine']);
    expect(r.rejected).toHaveLength(5);
    expect(r.rejected.map((x) => x.reason).join('|')).toContain('not a string');
  });

  it('drops case-insensitive duplicates and reports them', () => {
    const r = parseCandidates('["Lumen","lumen","LUMEN"]');
    expect(r.accepted).toHaveLength(1);
    expect(r.duplicates).toEqual(['lumen', 'lumen']);
  });

  it('flags accent normalisation', () => {
    const r = parseCandidates('["Café"]');
    expect(r.accepted[0]).toEqual({ name: 'cafe', original: 'Café', normalized: true });
  });

  it('throws on invalid JSON, wrong shape and oversized input', () => {
    expect(() => parseCandidates('{oops', 'json')).toThrow('not valid JSON');
    expect(() => parseCandidates('{"a":1}', 'json')).toThrow('array');
    const big = JSON.stringify(Array.from({ length: MAX_NAMES + 1 }, (_, i) => `name${'abcdefghij'[i % 10]}`));
    expect(() => parseCandidates(big)).toThrow('Too many');
  });
});
