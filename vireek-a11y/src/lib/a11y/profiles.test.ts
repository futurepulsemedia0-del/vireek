import { describe, expect, it } from 'vitest';
import { PROFILE_DEFS, buildProfileSettings, detectActiveProfile } from './profiles';
import { DEFAULT_SETTINGS, sanitizeSettings } from './settings';

describe('profiles', () => {
  it('every profile survives sanitize unchanged (all values in range) and is detected as active', () => {
    for (const p of PROFILE_DEFS) {
      const built = buildProfileSettings(DEFAULT_SETTINGS, p);
      expect(sanitizeSettings(built)).toEqual(built);
      expect(detectActiveProfile(built)).toBe(p.id);
    }
  });
  it('profiles replace (not accumulate) but keep personal speech/shortcut preferences', () => {
    const custom = { ...DEFAULT_SETTINGS, hideImages: true, ttsRate: 1.5, ttsVoiceURI: 'v1' };
    const next = buildProfileSettings(custom, PROFILE_DEFS[0]!);
    expect(next.hideImages).toBe(false);
    expect(next.ttsRate).toBe(1.5);
    expect(next.ttsVoiceURI).toBe('v1');
  });
  it('no profile is active when something else deviates', () => {
    expect(detectActiveProfile(DEFAULT_SETTINGS)).toBe(null);
    const s = { ...buildProfileSettings(DEFAULT_SETTINGS, PROFILE_DEFS[1]!), hideImages: true };
    expect(detectActiveProfile(s)).toBe(null);
  });
});
