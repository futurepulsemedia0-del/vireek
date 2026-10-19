import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, o?: { defaultValue?: string }) => o?.defaultValue ?? key }),
}));
vi.mock('@/lib/native/platform', () => ({ isNative: () => false }));
vi.mock('@/lib/pwa/tapHaptic', () => ({ tapHaptic: vi.fn() }));

import { INSTALL_DISMISS_KEY, INSTALL_VISITS_KEY, __resetInstallPromptForTests, initInstallPrompt } from '@/lib/pwa/installPrompt';
import { PwaInstallBanner } from './PwaInstallBanner';

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1';

/** Seeds one previous visit so this session is the 2nd (eligible), then boots the store like main.tsx does. */
function boot() {
  localStorage.setItem(INSTALL_VISITS_KEY, '1');
  initInstallPrompt();
}

function fireInstallable(outcome: 'accepted' | 'dismissed' = 'accepted') {
  const prompt = vi.fn().mockResolvedValue(undefined);
  const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
    prompt,
    userChoice: Promise.resolve({ outcome, platform: 'web' }),
  });
  act(() => {
    window.dispatchEvent(event);
  });
  return { prompt };
}

beforeEach(() => {
  __resetInstallPromptForTests();
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  __resetInstallPromptForTests();
  Reflect.deleteProperty(navigator, 'userAgent');
  Reflect.deleteProperty(window, 'matchMedia');
});

describe('PwaInstallBanner', () => {
  it('renders nothing when the browser offers no install', () => {
    boot();
    render(<PwaInstallBanner />);
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('shows after beforeinstallprompt and installs on tap', async () => {
    boot();
    render(<PwaInstallBanner />);
    const { prompt } = fireInstallable('accepted');
    expect(screen.getByRole('region', { name: 'Install Vireek' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('region')).toBeNull());
  });

  it('"Not now" hides it and remembers the dismissal', () => {
    boot();
    render(<PwaInstallBanner />);
    fireInstallable();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.queryByRole('region')).toBeNull();
    expect(localStorage.getItem(INSTALL_DISMISS_KEY)).not.toBeNull();
  });

  it('does not show on the very first visit', () => {
    initInstallPrompt(); // visits = 1
    render(<PwaInstallBanner />);
    fireInstallable();
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('iOS: shows manual Add-to-Home-Screen instructions instead of a prompt', () => {
    Object.defineProperty(navigator, 'userAgent', { value: IPHONE_UA, configurable: true });
    boot();
    render(<PwaInstallBanner />);
    expect(screen.queryByText(/Add to Home Screen/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'How to install' }));
    expect(screen.getByText(/Add to Home Screen/)).toBeInTheDocument();
  });

  it('stays hidden when already running as an installed app', () => {
    window.matchMedia = vi.fn().mockImplementation((q: string) => ({
      matches: q.includes('standalone'),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    boot();
    render(<PwaInstallBanner />);
    fireInstallable();
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('uses 48px tap targets and is mobile-only', () => {
    boot();
    render(<PwaInstallBanner />);
    fireInstallable();
    expect(screen.getByRole('button', { name: 'Install' }).className).toContain('min-h-12');
    expect(screen.getByRole('region').className).toContain('lg:hidden');
  });
});
