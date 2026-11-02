import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, sanitizeSettings } from './settings';
import { DEFAULT_SHORTCUTS } from './shortcuts';

describe('sanitizeSettings', () => {
  it('returns defaults for non-objects', () => {
    for (const v of [null, undefined, 'x', 5, [], true]) expect(sanitizeSettings(v)).toEqual(DEFAULT_SETTINGS);
  });
  it('migrates legacy stored data (no new keys)', () => {
    const s = sanitizeSettings({ textSize: 1.2, highContrast: true, lineHeight: 1.8 });
    expect(s.textSize).toBe(1.2);
    expect(s.highContrast).toBe(true);
    expect(s.colorBlind).toBe('none');
    expect(s.shortcuts).toEqual(DEFAULT_SHORTCUTS);
  });
  it('clamps out-of-range and rejects non-finite numbers', () => {
    const s = sanitizeSettings({ textSize: 99, contentScale: -5, lineHeight: NaN, letterSpacing: Infinity, ttsRate: 50, ttsVolume: -1 });
    expect(s.textSize).toBe(1.5);
    expect(s.contentScale).toBe(0.9);
    expect(s.lineHeight).toBe(DEFAULT_SETTINGS.lineHeight);
    expect(s.letterSpacing).toBe(DEFAULT_SETTINGS.letterSpacing);
    expect(s.ttsRate).toBe(2);
    expect(s.ttsVolume).toBe(0);
  });
  it('rejects wrong types, unknown keys, invalid colorBlind, and __proto__ injection', () => {
    const evil = JSON.parse('{"__proto__":{"polluted":true},"hideImages":"yes","colorBlind":"rainbow","extra":1,"ttsVoiceURI":5}');
    const s = sanitizeSettings(evil);
    expect(s.hideImages).toBe(false);
    expect(s.colorBlind).toBe('none');
    expect(s.ttsVoiceURI).toBe('');
    expect('extra' in s).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBe(undefined);
  });
  it('accepts every color-blind mode', () => {
    for (const m of ['protanopia', 'deuteranopia', 'tritanopia'] as const) expect(sanitizeSettings({ colorBlind: m }).colorBlind).toBe(m);
  });
  it('does not share the shortcuts object with DEFAULT_SETTINGS', () => {
    const s = sanitizeSettings({});
    s.shortcuts.openCenter = 'Alt+KeyZ';
    expect(DEFAULT_SETTINGS.shortcuts.openCenter).toBe('Alt+Shift+KeyA');
  });
});
