import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import en from '@/locales/consent/en.json';

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('@/lib/consent/sync', () => ({ startConsentSync: () => () => undefined, linkConsentToAccount: async () => undefined }));
vi.mock('@/components/consent/PreferenceCenter', () => ({ default: () => <div role="dialog" aria-label="Cookie settings" /> }));
vi.mock('@/i18n/consentNamespace', () => ({
  useConsentT: () => ({
    language: 'en',
    t: (key: string) => key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], en) as string,
  }),
}));

import { ConsentManager } from '@/components/consent/ConsentManager';
import { BANNER_DISMISS_STORAGE_KEY } from '@/lib/consent/bannerTiming';
import { CONSENT_STORAGE_KEY, __resetConsentForTests, openConsentPreferences } from '@/lib/consent/engine';

const mount = (path = '/') => render(<MemoryRouter initialEntries={[path]}><ConsentManager /></MemoryRouter>);
const banner = () => screen.queryByRole('region', { name: /cookie choices/i });
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const setVisibility = (state: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  act(() => { document.dispatchEvent(new Event('visibilitychange')); });
};
const stored = () => JSON.parse(localStorage.getItem(CONSENT_STORAGE_KEY) ?? 'null');

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  __resetConsentForTests();
  setVisibility('visible');
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('cookie banner timing', () => {
  it('is absent at first paint and appears after the delay', async () => {
    mount();
    expect(banner()).toBeNull();
    await advance(2500);
    expect(banner()).toBeNull();
    await advance(700);
    expect(banner()).not.toBeNull();
  });

  it('appears early on the first click', async () => {
    mount();
    await advance(500);
    act(() => { window.dispatchEvent(new Event('pointerdown')); });
    await advance(50);
    expect(banner()).not.toBeNull();
  });

  it('pauses the timer while the tab is hidden', async () => {
    mount();
    await advance(2000);
    setVisibility('hidden');
    await advance(10000);
    expect(banner()).toBeNull();
    setVisibility('visible');
    await advance(900);
    expect(banner()).toBeNull();
    await advance(300);
    expect(banner()).not.toBeNull();
  });

  it('does not steal focus when it appears', async () => {
    mount();
    await advance(3200);
    expect(banner()).not.toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  it('never appears on /wallboard/ routes or with a stored valid decision', async () => {
    mount('/wallboard/tv');
    await advance(5000);
    expect(banner()).toBeNull();
    cleanup();
    __resetConsentForTests();
    localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify({ version: 3, timestamp: new Date().toISOString(), subjectId: 'abcdefgh-1234', choices: { analytics: false, marketing: false }, source: 'reject_all', synced: false }));
    mount();
    await advance(5000);
    expect(banner()).toBeNull();
  });
});

describe('cookie banner decisions', () => {
  const open = async () => { mount(); await advance(3200); };

  it('Accept all and Reject all store the right choices', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: en.banner.accept }));
    expect(stored().choices).toEqual({ analytics: true, marketing: true });
    cleanup(); __resetConsentForTests(); localStorage.clear();
    await open();
    fireEvent.click(screen.getByRole('button', { name: en.banner.reject }));
    expect(stored().choices).toEqual({ analytics: false, marketing: false });
  });

  it('Accept and Reject use identical classes (equal weight)', async () => {
    await open();
    const accept = screen.getByRole('button', { name: en.banner.accept });
    const reject = screen.getByRole('button', { name: en.banner.reject });
    expect(accept.className).toBe(reject.className);
  });

  it('Escape is "no choice yet": nothing stored, dismissal remembered, no return on remount', async () => {
    await open();
    fireEvent.keyDown(banner() as HTMLElement, { key: 'Escape' });
    await advance(400);
    expect(banner()).toBeNull();
    expect(stored()).toBeNull();
    expect(localStorage.getItem(BANNER_DISMISS_STORAGE_KEY)).not.toBeNull();
    cleanup(); __resetConsentForTests();
    mount();
    await advance(5000);
    expect(banner()).toBeNull();
  });

  it('Customize and the footer event open the preference center', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: en.banner.customize }));
    expect(screen.getByRole('dialog', { name: /cookie settings/i })).toBeInTheDocument();
    cleanup(); __resetConsentForTests(); localStorage.clear();
    mount();
    act(() => openConsentPreferences());
    expect(screen.getByRole('dialog', { name: /cookie settings/i })).toBeInTheDocument();
  });
});
