import { describe, expect, it } from 'vitest';
import { matchesPoFormat, validatePoRegex, MAX_PO_REGEX_LENGTH } from './safeRegex';

describe('validatePoRegex', () => {
  it('accepts simple portable patterns', () => {
    for (const p of ['^PO-[0-9]{4}$', '^\\d{6,8}$', '^(PO|WO)-[A-Z0-9]+$', 'ABC']) expect(validatePoRegex(p), p).toEqual({ ok: true });
  });
  it('rejects the unsafe or non-portable shapes', () => {
    expect(validatePoRegex('(?i)abc')).toEqual({ ok: false, issue: 'unsupported_syntax' });
    expect(validatePoRegex('(a)\\1')).toEqual({ ok: false, issue: 'unsupported_syntax' });
    expect(validatePoRegex('[[:alpha:]]+')).toEqual({ ok: false, issue: 'unsupported_syntax' });
    expect(validatePoRegex('(a+)+$')).toEqual({ ok: false, issue: 'nested_quantifier' });
    expect(validatePoRegex('(a*)*')).toEqual({ ok: false, issue: 'nested_quantifier' });
    expect(validatePoRegex('(a|b+){2,}')).toEqual({ ok: false, issue: 'nested_quantifier' });
    expect(validatePoRegex('[')).toEqual({ ok: false, issue: 'invalid' });
    expect(validatePoRegex('  ')).toEqual({ ok: false, issue: 'empty' });
    expect(validatePoRegex('a'.repeat(MAX_PO_REGEX_LENGTH + 1))).toEqual({ ok: false, issue: 'too_long' });
  });
  it('a malicious pattern + long input returns instantly without hanging', () => {
    const t = Date.now();
    expect(matchesPoFormat('a'.repeat(50_000) + '!', '(a+)+$')).toBeNull();
    expect(Date.now() - t).toBeLessThan(200);
  });
});

describe('matchesPoFormat', () => {
  it('searches unanchored like Postgres ~', () => {
    expect(matchesPoFormat('xxPO-1234yy', 'PO-[0-9]{4}')).toBe(true);
    expect(matchesPoFormat('PO-12', '^PO-[0-9]{4}$')).toBe(false);
  });
});
