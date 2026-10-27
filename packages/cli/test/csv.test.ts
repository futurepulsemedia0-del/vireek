import { describe, expect, it } from 'vitest';
import { cellToString, csvRecord, escapeCsv } from '../src/csv.js';

describe('csv', () => {
  it('quotes cells containing commas, quotes and newlines (RFC 4180)', () => {
    expect(escapeCsv('plain')).toBe('plain');
    expect(escapeCsv('a,b')).toBe('"a,b"');
    expect(escapeCsv('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsv('line1\nline2')).toBe('"line1\nline2"');
  });

  it('renders null/undefined as empty and nested values as JSON', () => {
    expect(cellToString(null, true)).toBe('');
    expect(cellToString(undefined, true)).toBe('');
    expect(cellToString(['a', 'b'], true)).toBe('["a","b"]');
    expect(cellToString({ k: 1 }, true)).toBe('{"k":1}');
    expect(cellToString(42, true)).toBe('42');
    expect(cellToString(false, true)).toBe('false');
  });

  it('neutralises spreadsheet formulas but leaves plain numbers and phone numbers alone', () => {
    expect(cellToString('=HYPERLINK("http://evil")', true)).toBe(`'=HYPERLINK("http://evil")`);
    expect(cellToString('@SUM(A1)', true)).toBe("'@SUM(A1)");
    expect(cellToString('-2+3', true)).toBe("'-2+3");
    expect(cellToString('+15551234567', true)).toBe('+15551234567');
    expect(cellToString('-12.5', true)).toBe('-12.5');
    expect(cellToString('=1+1', false)).toBe('=1+1');
  });

  it('does not alter real negative numbers', () => {
    expect(cellToString(-5, true)).toBe('-5');
  });

  it('ends records with CRLF', () => {
    expect(csvRecord(['a', 'b,c', null])).toBe('a,"b,c",\r\n');
  });
});
