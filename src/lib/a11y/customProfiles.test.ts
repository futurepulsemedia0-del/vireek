import { describe, expect, it } from 'vitest';
import {
  MAX_CUSTOM_PROFILES, MAX_PROFILE_NAME, addCustomProfile, applyCustomProfile, detectActiveCustom, loadCustomProfiles,
  normalizeProfileName, removeCustomProfile, sanitizeProfileList, saveCustomProfiles, snapshotSettings, type CustomProfile,
} from './customProfiles';
import { DEFAULT_SETTINGS } from './settings';

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(initial));
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    key: (i: number) => Array.from(m.keys())[i] ?? null,
    removeItem: (k: string) => { m.delete(k); },
    setItem: (k: string, v: string) => { m.set(k, v); },
  };
}
const mk = (name: string, s = DEFAULT_SETTINGS, id = name): CustomProfile => {
  const r = addCustomProfile([], name, s, 1, id);
  if (!r.ok) throw new Error('setup');
  return r.profile;
};

describe('normalizeProfileName', () => {
  it('trims, collapses whitespace, strips control/bidi characters and caps length', () => {
    expect(normalizeProfileName('  My   profile \u202e ')).toBe('My profile');
    expect(normalizeProfileName('a'.repeat(100))).toHaveLength(MAX_PROFILE_NAME);
    expect(normalizeProfileName('   ')).toBe('');
  });
});

describe('snapshot and apply', () => {
  it('a profile never stores or overwrites personal speech and shortcut preferences', () => {
    const saved = { ...DEFAULT_SETTINGS, highContrast: true, ttsRate: 1.9, ttsVoiceURI: 'x', shortcuts: { ...DEFAULT_SETTINGS.shortcuts, openCenter: 'Alt+KeyZ' } };
    const p = mk('A', saved);
    expect(p.settings.highContrast).toBe(true);
    expect(p.settings.ttsRate).toBe(DEFAULT_SETTINGS.ttsRate);
    expect(p.settings.ttsVoiceURI).toBe('');
    const current = { ...DEFAULT_SETTINGS, ttsRate: 0.7, ttsVoiceURI: 'mine', shortcuts: { ...DEFAULT_SETTINGS.shortcuts, openCenter: 'Alt+KeyQ' } };
    const out = applyCustomProfile(current, p);
    expect(out.highContrast).toBe(true);
    expect(out.ttsRate).toBe(0.7);
    expect(out.ttsVoiceURI).toBe('mine');
    expect(out.shortcuts.openCenter).toBe('Alt+KeyQ');
  });
  it('applying replaces appearance settings that the profile leaves at default', () => {
    const p = mk('Calm', { ...DEFAULT_SETTINGS, lowSaturation: true });
    const out = applyCustomProfile({ ...DEFAULT_SETTINGS, grayscale: true }, p);
    expect(out.grayscale).toBe(false);
    expect(out.lowSaturation).toBe(true);
  });
  it('snapshot clamps out-of-range values', () => {
    expect(snapshotSettings({ ...DEFAULT_SETTINGS, textSize: 99 }).textSize).toBe(1.5);
  });
});

describe('detectActiveCustom', () => {
  it('finds the matching profile and ignores personal preference differences', () => {
    const a = mk('A', { ...DEFAULT_SETTINGS, highContrast: true });
    const b = mk('B', { ...DEFAULT_SETTINGS, grayscale: true });
    expect(detectActiveCustom({ ...DEFAULT_SETTINGS, grayscale: true, ttsRate: 1.4 }, [a, b])).toBe('B');
    expect(detectActiveCustom({ ...DEFAULT_SETTINGS, grayscale: true, highContrast: true }, [a, b])).toBe(null);
  });
});

describe('add / remove', () => {
  it('rejects an empty name and enforces the limit', () => {
    expect(addCustomProfile([], '  ', DEFAULT_SETTINGS, 1, 'x')).toEqual({ ok: false, reason: 'name' });
    let list: CustomProfile[] = [];
    for (let i = 0; i < MAX_CUSTOM_PROFILES; i++) {
      const r = addCustomProfile(list, `P${i}`, DEFAULT_SETTINGS, i, `id${i}`);
      expect(r.ok).toBe(true);
      if (r.ok) list = r.profiles;
    }
    expect(addCustomProfile(list, 'One more', DEFAULT_SETTINGS, 99, 'z')).toEqual({ ok: false, reason: 'limit' });
  });
  it('saving an existing name (case-insensitive) updates it in place, even when the list is full', () => {
    let list: CustomProfile[] = [];
    for (let i = 0; i < MAX_CUSTOM_PROFILES; i++) {
      const r = addCustomProfile(list, `P${i}`, DEFAULT_SETTINGS, i, `id${i}`);
      if (r.ok) list = r.profiles;
    }
    const r = addCustomProfile(list, 'p3', { ...DEFAULT_SETTINGS, grayscale: true }, 50, 'new');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.replaced).toBe(true);
      expect(r.profiles).toHaveLength(MAX_CUSTOM_PROFILES);
      expect(r.profile.id).toBe('id3');
      expect(r.profile.settings.grayscale).toBe(true);
    }
  });
  it('remove deletes only the requested profile', () => {
    const list = [mk('A'), mk('B')];
    expect(removeCustomProfile(list, 'A').map((p) => p.id)).toEqual(['B']);
  });
});

describe('storage', () => {
  it('round-trips through storage', () => {
    const st = memoryStorage();
    const list = [mk('A', { ...DEFAULT_SETTINGS, focusColor: 'blue' })];
    expect(saveCustomProfiles(list, st)).toBe(true);
    const back = loadCustomProfiles(st);
    expect(back).toHaveLength(1);
    expect(back[0].settings.focusColor).toBe('blue');
  });
  it('survives corrupt, hostile or oversized stored data', () => {
    expect(loadCustomProfiles(memoryStorage({ 'vk-a11y-custom-profiles-v1': '{not json' }))).toEqual([]);
    expect(loadCustomProfiles(null)).toEqual([]);
    const evil = [
      { id: 'a', name: '<img src=x onerror=1>', createdAt: 1, settings: { textSize: 999, focusColor: 'pink' } },
      { id: 'a', name: 'dup id', settings: {} },
      { id: '', name: 'no id', settings: {} },
      { id: 'b', name: '   ', settings: {} },
      null, 5, 'x',
    ];
    const out = sanitizeProfileList(evil);
    expect(out).toHaveLength(1);
    expect(out[0].settings.textSize).toBe(1.5);
    expect(out[0].settings.focusColor).toBe('default');
    expect(sanitizeProfileList(Array.from({ length: 50 }, (_, i) => ({ id: `i${i}`, name: `n${i}`, settings: {} })))).toHaveLength(MAX_CUSTOM_PROFILES);
  });
  it('reports a failed save instead of throwing', () => {
    const bad = { ...memoryStorage(), setItem: () => { throw new Error('quota'); } } as Storage;
    expect(saveCustomProfiles([mk('A')], bad)).toBe(false);
    expect(saveCustomProfiles([mk('A')], null)).toBe(false);
  });
});
