import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, o?: { defaultValue?: string }) => o?.defaultValue ?? key }),
}));
vi.mock('@/lib/pwa/tapHaptic', () => ({ tapHaptic: vi.fn() }));

import { tapHaptic } from '@/lib/pwa/tapHaptic';
import { MobileBottomNav } from './MobileBottomNav';

function setup(path = '/dashboard', props: Partial<{ onMore: () => void; moreOpen: boolean }> = {}) {
  const onMore = props.onMore ?? vi.fn();
  render(
    <MemoryRouter initialEntries={[path]}>
      <MobileBottomNav onMore={onMore} moreOpen={props.moreOpen ?? false} />
    </MemoryRouter>,
  );
  return { onMore };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('MobileBottomNav', () => {
  it('renders the four destinations plus More', () => {
    setup();
    expect(screen.getByRole('navigation', { name: 'Mobile navigation' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute('href', '/dashboard');
    expect(screen.getByRole('link', { name: 'Jobs' })).toHaveAttribute('href', '/dashboard/jobs');
    expect(screen.getByRole('link', { name: 'Calls' })).toHaveAttribute('href', '/dashboard/calls');
    expect(screen.getByRole('link', { name: 'Inbox' })).toHaveAttribute('href', '/dashboard/inbox');
    expect(screen.getByRole('button', { name: 'More' })).toBeInTheDocument();
  });

  it('marks only the current tab with aria-current (nested routes included)', () => {
    setup('/dashboard/calls/42');
    expect(screen.getByRole('link', { name: 'Calls' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Jobs' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current');
  });

  it('highlights no tab on pages that live under More', () => {
    setup('/dashboard/settings');
    expect(screen.queryByRole('link', { current: 'page' })).toBeNull();
  });

  it('More opens the drawer, gives haptic feedback and reflects expanded state', () => {
    const { onMore } = setup('/dashboard', { moreOpen: true });
    const more = screen.getByRole('button', { name: 'More' });
    expect(more).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(more);
    expect(onMore).toHaveBeenCalledTimes(1);
    expect(tapHaptic).toHaveBeenCalledTimes(1);
  });

  it('gives haptic feedback when a tab is tapped', () => {
    setup();
    fireEvent.click(screen.getByRole('link', { name: 'Jobs' }));
    expect(tapHaptic).toHaveBeenCalledTimes(1);
  });

  it('uses 48px, tap-optimised targets', () => {
    setup();
    for (const el of [...screen.getAllByRole('link'), screen.getByRole('button', { name: 'More' })]) {
      expect(el.className).toContain('min-h-12');
      expect(el.className).toContain('touch-manipulation');
    }
  });

  it('is hidden on desktop and print, and pads for the home-indicator safe area', () => {
    setup();
    const nav = screen.getByRole('navigation', { name: 'Mobile navigation' });
    expect(nav.className).toContain('lg:hidden');
    expect(nav.className).toContain('print:hidden');
    expect(nav.className).toContain('pb-[env(safe-area-inset-bottom)]');
  });

  it('toggles data-bottom-nav on <html> while mounted', () => {
    const { unmount } = render(
      <MemoryRouter>
        <MobileBottomNav onMore={() => undefined} moreOpen={false} />
      </MemoryRouter>,
    );
    expect(document.documentElement.hasAttribute('data-bottom-nav')).toBe(true);
    unmount();
    expect(document.documentElement.hasAttribute('data-bottom-nav')).toBe(false);
  });
});
