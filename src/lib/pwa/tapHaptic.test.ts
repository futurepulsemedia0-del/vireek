import { afterEach, describe, expect, it, vi } from 'vitest';

const isNativeMock = vi.hoisted(() => vi.fn(() => false));
const hapticMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/native/platform', () => ({ isNative: isNativeMock }));
vi.mock('@/lib/native/haptics', () => ({ haptic: hapticMock }));

import { tapHaptic } from './tapHaptic';

function mockMatchMedia(reduced: boolean) {
  window.matchMedia = vi.fn().mockReturnValue({ matches: reduced }) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'vibrate');
  Reflect.deleteProperty(window, 'matchMedia');
  isNativeMock.mockReturnValue(false);
  hapticMock.mockClear();
});

describe('tapHaptic', () => {
  it('vibrates briefly on the web when supported', () => {
    const vibrate = vi.fn();
    Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true });
    mockMatchMedia(false);
    tapHaptic();
    expect(vibrate).toHaveBeenCalledWith(8);
  });

  it('does nothing when the user prefers reduced motion', () => {
    const vibrate = vi.fn();
    Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true });
    mockMatchMedia(true);
    tapHaptic();
    expect(vibrate).not.toHaveBeenCalled();
  });

  it('uses native haptics inside the app shell', () => {
    isNativeMock.mockReturnValue(true);
    const vibrate = vi.fn();
    Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true });
    tapHaptic();
    expect(hapticMock).toHaveBeenCalledWith('info');
    expect(vibrate).not.toHaveBeenCalled();
  });

  it('is a silent no-op without the Vibration API (iOS Safari)', () => {
    expect(() => tapHaptic()).not.toThrow();
  });
});
