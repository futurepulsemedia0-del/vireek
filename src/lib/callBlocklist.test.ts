import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import {
  evaluateBlock,
  formatPhone,
  isAnonymousCaller,
  normalizePhone,
  parseNumberList,
  toE164,
  validateRule,
} from './callBlocklist';
import type { BlockContext, BlockInput, BlockRule } from './callBlocklist';

const NOW = new Date('2026-10-08T12:00:00Z');
const OWN = '+15125550100';

const rule = (over: Partial<BlockRule> & Pick<BlockRule, 'kind'>): BlockRule => ({ id: `r_${over.kind}`, name: over.kind, enabled: true, config: {}, ...over });
const input = (over: Partial<BlockInput> = {}): BlockInput => ({ callerNumber: '+15125559999', dialedNumber: OWN, now: NOW, recentCalls: [], ...over });
const ctx = (over: Partial<BlockContext> = {}): BlockContext => ({ blocklist: new Map(), rules: [], overrides: [], ...over });

describe('phone normalization', () => {
  it('matches the server-side DNC key format', () => {
    expect(normalizePhone('(512) 555-0123')).toBe('+15125550123');
    expect(normalizePhone('1-512-555-0123')).toBe('+15125550123');
    expect(normalizePhone('+44 20 7946 0958')).toBe('+44 20 7946 0958');
  });

  it('validates to strict E.164 or null', () => {
    expect(toE164('(512) 555-0123')).toBe('+15125550123');
    expect(toE164('+44 20 7946 0958')).toBe('+442079460958');
    expect(toE164('12345')).toBeNull();
    expect(toE164('hello')).toBeNull();
  });

  it('formats US numbers for display and leaves others alone', () => {
    expect(formatPhone('+15125550123')).toBe('(512) 555-0123');
    expect(formatPhone('+442079460958')).toBe('+442079460958');
  });

  it('detects hidden caller ID', () => {
    expect(isAnonymousCaller(null)).toBe(true);
    expect(isAnonymousCaller('')).toBe(true);
    expect(isAnonymousCaller('Anonymous')).toBe(true);
    expect(isAnonymousCaller('+266696687')).toBe(true);
    expect(isAnonymousCaller('+15125550123')).toBe(false);
  });
});

describe('evaluateBlock', () => {
  it('allows when nothing applies', () => {
    expect(evaluateBlock(input(), ctx()).blocked).toBe(false);
  });

  it('blocks a number on the blocklist and reports its category', () => {
    const d = evaluateBlock(input(), ctx({ blocklist: new Map([['+15125559999', 'robocall']]) }));
    expect(d.blocked).toBe(true);
    expect(d.reason).toBe('blocklist');
    expect(d.category).toBe('robocall');
  });

  it('lets an active override beat the blocklist, but not an expired or used-up one', () => {
    const list = new Map([['+15125559999', 'spam' as const]]);
    const active = { id: 'o1', phone: '+15125559999', expiresAt: '2026-10-09T00:00:00Z', usesRemaining: 1 };
    expect(evaluateBlock(input(), ctx({ blocklist: list, overrides: [active] })).reason).toBe('override');
    expect(evaluateBlock(input(), ctx({ blocklist: list, overrides: [{ ...active, expiresAt: '2026-10-07T00:00:00Z' }] })).blocked).toBe(true);
    expect(evaluateBlock(input(), ctx({ blocklist: list, overrides: [{ ...active, usesRemaining: 0 }] })).blocked).toBe(true);
  });

  it('blocks by prefix and ignores disabled rules', () => {
    const r = rule({ kind: 'prefix', config: { prefix: '+1900' } });
    expect(evaluateBlock(input({ callerNumber: '+19005551234' }), ctx({ rules: [r] })).blocked).toBe(true);
    expect(evaluateBlock(input({ callerNumber: '+19005551234' }), ctx({ rules: [{ ...r, enabled: false }] })).blocked).toBe(false);
    expect(evaluateBlock(input(), ctx({ rules: [r] })).blocked).toBe(false);
  });

  it('blocks hidden caller ID only when the anonymous rule is on', () => {
    expect(evaluateBlock(input({ callerNumber: null }), ctx()).blocked).toBe(false);
    expect(evaluateBlock(input({ callerNumber: null }), ctx({ rules: [rule({ kind: 'anonymous' })] })).blocked).toBe(true);
  });

  it('detects neighbor spoofing but never your own number or a different exchange', () => {
    const r = rule({ kind: 'neighbor_spoof' });
    expect(evaluateBlock(input({ callerNumber: '+15125550177' }), ctx({ rules: [r] })).blocked).toBe(true);
    expect(evaluateBlock(input({ callerNumber: OWN }), ctx({ rules: [r] })).blocked).toBe(false);
    expect(evaluateBlock(input({ callerNumber: '+15125660177' }), ctx({ rules: [r] })).blocked).toBe(false);
  });

  it('blocks repeat hang-ups inside the window only', () => {
    const r = rule({ kind: 'repeat_short_calls', config: { minCalls: 3, maxSeconds: 15, windowHours: 24 } });
    const call = (hoursAgo: number, secs: number) => ({ phone: '+15125559999', durationSeconds: secs, at: new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString() });
    expect(evaluateBlock(input({ recentCalls: [call(1, 3), call(2, 5), call(3, 8)] }), ctx({ rules: [r] })).blocked).toBe(true);
    expect(evaluateBlock(input({ recentCalls: [call(1, 3), call(2, 5), call(30, 8)] }), ctx({ rules: [r] })).blocked).toBe(false);
    expect(evaluateBlock(input({ recentCalls: [call(1, 3), call(2, 5), call(3, 90)] }), ctx({ rules: [r] })).blocked).toBe(false);
  });
});

describe('validateRule', () => {
  it('requires a name, a valid prefix and sane thresholds', () => {
    expect(validateRule({ name: ' ', kind: 'anonymous', config: {} })).toHaveLength(1);
    expect(validateRule({ name: 'x', kind: 'prefix', config: { prefix: '1900' } })).toHaveLength(1);
    expect(validateRule({ name: 'x', kind: 'prefix', config: { prefix: '+1900' } })).toHaveLength(0);
    expect(validateRule({ name: 'x', kind: 'repeat_short_calls', config: { minCalls: 1, maxSeconds: 500, windowHours: 24 } })).toHaveLength(2);
  });
});

describe('parseNumberList', () => {
  it('parses numbers with notes, skips a header, dedupes and reports bad lines', () => {
    const text = 'phone,note\n(512) 555-0101,Roofing spam\n512-555-0101\n+44 20 7946 0958\nabc\n12345\n\n"5125550102";"Warranty scam"';
    const r = parseNumberList(text);
    expect(r.valid.map((v) => v.phone)).toEqual(['+15125550101', '+442079460958', '+15125550102']);
    expect(r.valid[0].note).toBe('Roofing spam');
    expect(r.valid[2].note).toBe('Warranty scam');
    expect(r.duplicates).toBe(1);
    expect(r.invalid).toHaveLength(2);
    expect(r.truncated).toBe(false);
  });

  it('caps the import size', () => {
    const text = Array.from({ length: 12 }, (_, i) => `+1512555${String(1000 + i)}`).join('\n');
    const r = parseNumberList(text, 10);
    expect(r.valid).toHaveLength(10);
    expect(r.truncated).toBe(true);
  });

  it('handles an empty file and a BOM', () => {
    expect(parseNumberList('').valid).toHaveLength(0);
    expect(parseNumberList('\uFEFF+15125550101').valid).toHaveLength(1);
  });
});
