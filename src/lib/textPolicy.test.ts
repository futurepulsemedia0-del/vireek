import { describe, expect, it } from 'vitest';
import { LINE_CLAMP_CLASS, STRESS_STRINGS, TEXT_LINES, graphemeCount, pseudoLocalize, truncateMiddle } from './textPolicy';
import { isolateLtr, stripIsolates } from './bidi';

const len = (s: string) => Array.from(s).length;

describe('truncateMiddle', () => {
  it('keeps short text and ignores invalid limits', () => {
    expect(truncateMiddle('short', 18)).toBe('short');
    expect(truncateMiddle('abcdef', 2)).toBe('abcdef');
  });

  it('shortens long emails/URLs to exactly the limit and keeps the tail', () => {
    const out = truncateMiddle(STRESS_STRINGS.longEmail, 24);
    expect(graphemeCount(out)).toBe(24);
    expect(out.includes('…')).toBe(true);
    expect(out.endsWith(STRESS_STRINGS.longEmail.slice(-5))).toBe(true);
  });

  it.each(Object.entries(STRESS_STRINGS))('never splits a user-perceived character (%s)', (_name, text) => {
    const out = truncateMiddle(text, 15);
    expect(out.includes('\uFFFD')).toBe(false);
    expect(graphemeCount(out)).toBeLessThanOrEqual(15);
  });

  it('does not split emoji families', () => {
    const out = truncateMiddle('👨‍👩‍👧‍👦'.repeat(10), 6);
    expect(out.replace('…', '').replace(/👨‍👩‍👧‍👦/gu, '')).toBe('');
  });
});

describe('policy tables', () => {
  it('every kind maps to a clamp class', () => {
    for (const lines of Object.values(TEXT_LINES)) expect(LINE_CLAMP_CLASS[lines]).toBeTruthy();
  });
});

describe('pseudoLocalize', () => {
  it('keeps {{placeholders}} and adds at least 40% length', () => {
    const src = 'Hello {{name}}, saved {{count}} items';
    const out = pseudoLocalize(src);
    expect(out.includes('{{name}}') && out.includes('{{count}}')).toBe(true);
    expect(len(out)).toBeGreaterThanOrEqual(Math.ceil(len(src) * 1.4));
  });
});

describe('bidi', () => {
  it('isolates and restores a token', () => {
    const t = '+49 30 1234567';
    expect(isolateLtr(t)).not.toBe(t);
    expect(stripIsolates(isolateLtr(t))).toBe(t);
  });
});
