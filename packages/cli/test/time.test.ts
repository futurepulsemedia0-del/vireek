import { describe, expect, it } from 'vitest';
import { parseTimestamp } from '../src/time.js';

const NOW = Date.parse('2026-10-26T12:00:00.000Z');

describe('parseTimestamp', () => {
  it('parses relative ages against the supplied clock', () => {
    expect(parseTimestamp('--since', '90m', NOW)).toBe('2026-10-26T10:30:00.000Z');
    expect(parseTimestamp('--since', '24h', NOW)).toBe('2026-10-25T12:00:00.000Z');
    expect(parseTimestamp('--since', '7d', NOW)).toBe('2026-10-19T12:00:00.000Z');
    expect(parseTimestamp('--since', '2W', NOW)).toBe('2026-10-12T12:00:00.000Z');
  });

  it('parses ISO dates as UTC', () => {
    expect(parseTimestamp('--since', '2026-10-01')).toBe('2026-10-01T00:00:00.000Z');
    expect(parseTimestamp('--since', '2026-10-01T09:30:00+02:00')).toBe('2026-10-01T07:30:00.000Z');
  });

  it('rejects garbage with a usage error', () => {
    expect(() => parseTimestamp('--since', 'yesterday-ish')).toThrow(/Invalid --since value/);
  });
});
