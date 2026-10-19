import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/native/platform', () => ({ isNative: () => false }));

import {
  INSTALL_COOLDOWN_MS,
  INSTALL_DISMISS_KEY,
  INSTALL_VISITS_KEY,
  __resetInstallPromptForTests,
  dismissInstallPrompt,
  getInstallState,
  initInstallPrompt,
  isIosDevice,
  promptInstall,
  shouldShowInstallBanner,
  subscribeInstallState,
  type InstallState,
} from './installPrompt';

const base: InstallState = { canPrompt: true, installed: false, ios: false, dismissedAt: null, visits: 2 };

function makeInstallEvent(outcome: 'accepted' | 'dismissed') {
  const prompt = vi.fn().mockResolvedValue(undefined);
  const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
    prompt,
    userChoice: Promise.resolve({ outcome, platform: 'web' }),
  });
  return { event, prompt };
}

beforeEach(() => {
  __resetInstallPromptForTests();
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  __resetInstallPromptForTests();
});

describe('isIosDevice', () => {
  it('detects iPhone, iPad and iPadOS desktop-mode', () => {
    expect(isIosDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe(true);
    expect(isIosDevice('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)')).toBe(true);
    expect(isIosDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5)).toBe(true);
  });
  it('rejects Mac and Android', () => {
    expect(isIosDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0)).toBe(false);
    expect(isIosDevice('Mozilla/5.0 (Linux; Android 14; Pixel 8)')).toBe(false);
  });
});

describe('shouldShowInstallBanner', () => {
  const now = 1_000_000_000_000;
  it('shows when installable and eligible', () => {
    expect(shouldShowInstallBanner(base, now)).toBe(true);
  });
  it('shows on iOS even without a native prompt', () => {
    expect(shouldShowInstallBanner({ ...base, canPrompt: false, ios: true }, now)).toBe(true);
  });
  it('hides when already installed', () => {
    expect(shouldShowInstallBanner({ ...base, installed: true }, now)).toBe(false);
  });
  it('hides when nothing can be offered', () => {
    expect(shouldShowInstallBanner({ ...base, canPrompt: false }, now)).toBe(false);
  });
  it('waits for a second visit before nagging', () => {
    expect(shouldShowInstallBanner({ ...base, visits: 1 }, now)).toBe(false);
  });
  it('respects the dismissal cooldown, then shows again', () => {
    expect(shouldShowInstallBanner({ ...base, dismissedAt: now - 1000 }, now)).toBe(false);
    expect(shouldShowInstallBanner({ ...base, dismissedAt: now - INSTALL_COOLDOWN_MS - 1 }, now)).toBe(true);
  });
});

describe('install prompt store', () => {
  it('captures beforeinstallprompt, prevents the mini-infobar and notifies subscribers', () => {
    initInstallPrompt();
    const listener = vi.fn();
    subscribeInstallState(listener);
    const { event } = makeInstallEvent('accepted');
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(getInstallState().canPrompt).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: a second init does not double-register listeners', () => {
    initInstallPrompt();
    initInstallPrompt();
    const listener = vi.fn();
    subscribeInstallState(listener);
    window.dispatchEvent(makeInstallEvent('accepted').event);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('counts one visit per browser session', () => {
    initInstallPrompt();
    expect(getInstallState().visits).toBe(1);
    __resetInstallPromptForTests();
    initInstallPrompt(); // same session
    expect(getInstallState().visits).toBe(1);
    expect(localStorage.getItem(INSTALL_VISITS_KEY)).toBe('1');
  });

  it('promptInstall: accepted → prompt called once, event consumed', async () => {
    initInstallPrompt();
    const { event, prompt } = makeInstallEvent('accepted');
    window.dispatchEvent(event);
    await expect(promptInstall()).resolves.toBe('accepted');
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(getInstallState().canPrompt).toBe(false);
    await expect(promptInstall()).resolves.toBe('unavailable');
  });

  it('promptInstall: dismissed → persists the cooldown', async () => {
    initInstallPrompt();
    window.dispatchEvent(makeInstallEvent('dismissed').event);
    await expect(promptInstall()).resolves.toBe('dismissed');
    expect(getInstallState().dismissedAt).not.toBeNull();
    expect(localStorage.getItem(INSTALL_DISMISS_KEY)).not.toBeNull();
  });

  it('promptInstall without an event is a safe no-op', async () => {
    initInstallPrompt();
    await expect(promptInstall()).resolves.toBe('unavailable');
  });

  it('appinstalled marks the app installed and clears the prompt', () => {
    initInstallPrompt();
    window.dispatchEvent(makeInstallEvent('accepted').event);
    window.dispatchEvent(new Event('appinstalled'));
    expect(getInstallState()).toMatchObject({ installed: true, canPrompt: false });
  });

  it('dismissInstallPrompt stores the timestamp', () => {
    initInstallPrompt();
    dismissInstallPrompt(12345);
    expect(getInstallState().dismissedAt).toBe(12345);
    expect(localStorage.getItem(INSTALL_DISMISS_KEY)).toBe('12345');
  });
});
