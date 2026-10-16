import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { buildReleases } from '@/lib/whatsNew';
import { WhatsNewFeed } from './WhatsNewFeed';

const ctx = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('@/contexts/WhatsNewContext', () => ({ useWhatsNew: () => ctx.value }));

const releases = buildReleases([
  {
    date: 'September 5, 2026',
    entries: [
      { type: 'new', title: 'Dispatch Calendar', body: 'See your week.' },
      { type: 'fixed', title: 'Invite typo fix', body: 'Typo.' },
    ],
  },
  { date: 'September 6, 2026', entries: [{ type: 'improved', title: 'Team invite tracking', body: 'Resend smarter.' }] },
]);

interface Mocks {
  markRead: ReturnType<typeof vi.fn>;
  markAllRead: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
}

function setState(over: Record<string, unknown> = {}): Mocks {
  const mocks: Mocks = {
    markRead: vi.fn().mockResolvedValue(undefined),
    markAllRead: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn(),
  };
  ctx.value = { status: 'ready', releases, unreadIds: ['2026-09-06'], unreadCount: 1, ...mocks, ...over };
  return mocks;
}

function renderFeed() {
  return render(
    <MemoryRouter>
      <WhatsNewFeed />
    </MemoryRouter>,
  );
}

describe('WhatsNewFeed', () => {
  beforeEach(() => {
    setState();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists releases newest first and flags only the unread one as New', () => {
    renderFeed();
    const dates = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(dates).toEqual(['September 6, 2026', 'September 5, 2026']);
    expect(screen.getAllByTestId('new-badge')).toHaveLength(1);
  });

  it('filters entries by type', () => {
    renderFeed();
    fireEvent.click(screen.getByRole('button', { name: /^improved/i }));
    expect(screen.getByText('Team invite tracking')).toBeInTheDocument();
    expect(screen.queryByText('Dispatch Calendar')).not.toBeInTheDocument();
  });

  it('shows an empty state with a way back when a filter matches nothing', () => {
    renderFeed();
    fireEvent.click(screen.getByRole('button', { name: /^security/i }));
    expect(screen.getByText('No updates match')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /clear filters/i }));
    expect(screen.getByText('Dispatch Calendar')).toBeInTheDocument();
  });

  it('shows skeletons instead of releases while loading', () => {
    setState({ status: 'loading', unreadIds: [], unreadCount: 0 });
    renderFeed();
    expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument();
  });

  it('keeps the feed usable when read state fails to load, and retries on demand', () => {
    const mocks = setState({ status: 'error', unreadIds: [], unreadCount: 0 });
    renderFeed();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Dispatch Calendar')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(mocks.reload).toHaveBeenCalledTimes(1);
  });

  it('marks everything read from the button', () => {
    const mocks = setState();
    renderFeed();
    fireEvent.click(screen.getByRole('button', { name: /mark all as read/i }));
    expect(mocks.markAllRead).toHaveBeenCalledTimes(1);
  });

  it('auto-marks the unread releases after a short pause but keeps the highlight', () => {
    vi.useFakeTimers();
    const mocks = setState();
    renderFeed();
    expect(mocks.markRead).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(mocks.markRead).toHaveBeenCalledWith(['2026-09-06']);
    expect(screen.getAllByTestId('new-badge')).toHaveLength(1);
  });

  it('says so when there is nothing new', () => {
    setState({ unreadIds: [], unreadCount: 0 });
    renderFeed();
    expect(screen.getByText(/all caught up/i)).toBeInTheDocument();
    expect(screen.queryByTestId('new-badge')).not.toBeInTheDocument();
  });
});
