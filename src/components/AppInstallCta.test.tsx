import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, o?: { defaultValue?: string; store?: string }) =>
      (o?.defaultValue ?? key).replace('{{store}}', o?.store ?? ''),
  }),
}));
vi.mock('@/lib/native/platform', () => ({ isNative: () => false }));
vi.mock('@/lib/pwa/tapHaptic', () => ({ tapHaptic: vi.fn() }));

const stores = vi.hoisted(() => ({ value: [] as { id: string; label: string; href: string }[] }));
vi.mock('@/lib/appLinks', () => ({ getStoreLinks: () => stores.value }));

import { __resetInstallPromptForTests, initInstallPrompt } from '@/lib/pwa/installPrompt';
import { AppInstallCta } from './AppInstallCta';

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1';

function fireInstallable() {
  const prompt = vi.fn().mockResolvedValue(undefined);
  const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
    prompt,
    userChoice: Promise.resolve({ outcome: 'accepted' as const, platform: 'web' }),
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
  stores.value = [];
});

afterEach(() => {
  cleanup();
  __resetInstallPromptForTests();
  Reflect.deleteProperty(navigator, 'userAgent');
  Reflect.deleteProperty(window, 'matchMedia');
});

describe('AppInstallCta', () => {
  it('shows the button and no store links by default', () => {
    initInstallPrompt();
    render(<AppInstallCta />);
    expect(screen.getByRole('button', { name: 'Get the app' })).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('uses the native install prompt when the browser offers one', async () => {
    initInstallPrompt();
    render(<AppInstallCta />);
    const { prompt } = fireInstallable();
    fireEvent.click(screen.getByRole('button', { name: 'Get the app' }));
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('button')).toBeNull());
  });

  it('iOS: toggles Add to Home Screen instructions', () => {
    Object.defineProperty(navigator, 'userAgent', { value: IPHONE_UA, configurable: true });
    initInstallPrompt();
    render(<AppInstallCta />);
    const btn = screen.getByRole('button', { name: 'Get the app' });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/Add to Home Screen/)).toBeInTheDocument();
    fireEvent.click(btn);
    expect(screen.queryByText(/Add to Home Screen/)).toBeNull();
  });

  it('other browsers without a prompt: shows generic instructions', () => {
    initInstallPrompt();
    render(<AppInstallCta />);
    fireEvent.click(screen.getByRole('button', { name: 'Get the app' }));
    expect(screen.getByText(/Install app/)).toBeInTheDocument();
  });

  it('renders nothing when already installed', () => {
    window.matchMedia = vi.fn().mockImplementation((q: string) => ({
      matches: q.includes('standalone'),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    initInstallPrompt();
    const { container } = render(<AppInstallCta />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows store links safely once they are configured', () => {
    stores.value = [{ id: 'ios', label: 'App Store', href: 'https://apps.apple.com/us/app/vireek/id1' }];
    initInstallPrompt();
    render(<AppInstallCta />);
    const link = screen.getByRole('link', { name: 'Download Vireek on App Store' });
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('banner variant is a labelled region with a 48px button', () => {
    initInstallPrompt();
    render(<AppInstallCta variant="banner" />);
    expect(screen.getByRole('region', { name: 'Take Sarah with you' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Install app' }).className).toContain('min-h-12');
  });
});
