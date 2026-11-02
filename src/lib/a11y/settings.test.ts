import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, sanitizeSettings } from './settings';

describe('sanitizeSettings', () => {
  it('returns defaults for non-objects', () => {
    for (const v of [null, undefined, 'x', 5, [], true]) expect(sanitizeSettings(v)).toEqual(DEFAULT_SETTINGS);
  });
  it('keeps valid values and migrates legacy stored data (no colorBlind key)', () => {
    const s = sanitizeSettings({ textSize: 1.2, highContrast: true, lineHeight: 1.8 });
    expect(s.textSize).toBe(1.2);
    expect(s.highContrast).toBe(true);
    expect(s.colorBlind).toBe('none');
  });
  it('clamps out-of-range and rejects non-finite numbers', () => {
    const s = sanitizeSettings({ textSize: 99, contentScale: -5, lineHeight: NaN, letterSpacing: Infinity });
    expect(s.textSize).toBe(1.5);
    expect(s.contentScale).toBe(0.9);
    expect(s.lineHeight).toBe(DEFAULT_SETTINGS.lineHeight);
    expect(s.letterSpacing).toBe(DEFAULT_SETTINGS.letterSpacing);
  });
  it('rejects wrong types, unknown keys, invalid colorBlind, and __proto__ injection', () => {
    const evil = JSON.parse('{"__proto__":{"polluted":true},"hideImages":"yes","colorBlind":"rainbow","extra":1}');
    const s = sanitizeSettings(evil);
    expect(s.hideImages).toBe(false);
    expect(s.colorBlind).toBe('none');
    expect('extra' in s).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBe(undefined);
  });
  it('accepts every color-blind mode', () => {
    for (const m of ['protanopia', 'deuteranopia', 'tritanopia'] as const)
      expect(sanitizeSettings({ colorBlind: m }).colorBlind).toBe(m);
  });
});
