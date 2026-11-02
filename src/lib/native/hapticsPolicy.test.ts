import { describe, expect, it } from 'vitest';
import { parseHapticsSetting, shouldFireHaptic, type HapticContext } from './hapticsPolicy';

const base: HapticContext = { native: true, enabled: true, reducedMotion: false, now: 1000, lastFiredAt: null };

describe('shouldFireHaptic', () => {
  it('is a no-op on the web', () => expect(shouldFireHaptic('success', { ...base, native: false })).toBe(false));
  it('respects the user setting', () => expect(shouldFireHaptic('success', { ...base, enabled: false })).toBe(false));
  it('drops decorative haptics under reduced motion', () => expect(shouldFireHaptic('selection', { ...base, reducedMotion: true })).toBe(false));
  it('keeps warnings and errors under reduced motion', () => expect(shouldFireHaptic('error', { ...base, reducedMotion: true })).toBe(true));
  it('rate-limits bursts', () => {
    expect(shouldFireHaptic('selection', { ...base, lastFiredAt: 950 })).toBe(false);
    expect(shouldFireHaptic('selection', { ...base, lastFiredAt: 900 })).toBe(true);
  });
  it('defaults the setting to on', () => {
    expect(parseHapticsSetting(null)).toBe(true);
    expect(parseHapticsSetting('0')).toBe(false);
  });
});
