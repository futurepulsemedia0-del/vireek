import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

const summary = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('@/lib/leakRepair', async (orig) => ({
  ...(await orig<typeof import('@/lib/leakRepair')>()),
  fetchLeakSummary: summary.fn,
}));

import { LeakCasesCard } from '@/components/overview/LeakCasesCard';
import { StatusBadge, UrgencyBadge } from '@/components/leak/leakUi';

const NOW = new Date('2026-10-18T12:00:00Z');

describe('UrgencyBadge / StatusBadge', () => {
  it('labels overdue, due-soon and on-track with text, not just colour', () => {
    const base = { status: 'open' as const, next_action: 'initial_verification' as const };
    const { rerender } = render(
      <UrgencyBadge c={{ ...base, next_action_due_at: '2026-10-15' }} now={NOW} />,
    );
    expect(screen.getByText(/Overdue 3d/)).toBeTruthy();
    rerender(<UrgencyBadge c={{ ...base, next_action_due_at: '2026-10-18' }} now={NOW} />);
    expect(screen.getByText('Due today')).toBeTruthy();
    rerender(<UrgencyBadge c={{ ...base, next_action_due_at: '2026-10-30' }} now={NOW} />);
    expect(screen.getByText('12d left')).toBeTruthy();
  });

  it('renders nothing for finished cases and a readable status', () => {
    const { container } = render(
      <UrgencyBadge
        c={{ status: 'closed', next_action: null, next_action_due_at: null }}
        now={NOW}
      />,
    );
    expect(container.textContent).toBe('');
    render(<StatusBadge status="failed" />);
    expect(screen.getByText('Repair failed')).toBeTruthy();
  });
});

describe('LeakCasesCard (dashboard)', () => {
  const renderCard = () =>
    render(
      <MemoryRouter>
        <LeakCasesCard />
      </MemoryRouter>,
    );

  it('flags overdue cases in the dashboard', async () => {
    summary.fn.mockResolvedValueOnce({ active: 4, overdue: 2, due_soon: 1, failed: 1, chronic: 0 });
    renderCard();
    await waitFor(() => expect(screen.getByText('overdue')).toBeTruthy());
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByRole('link').getAttribute('href')).toBe('/dashboard/refrigerant-leaks');
  });

  it('shows active count when nothing is overdue', async () => {
    summary.fn.mockResolvedValueOnce({ active: 3, overdue: 0, due_soon: 0, failed: 0, chronic: 0 });
    renderCard();
    await waitFor(() => expect(screen.getByText('active')).toBeTruthy());
  });

  it('renders nothing with no active cases or on error', async () => {
    summary.fn.mockResolvedValueOnce({ active: 0, overdue: 0, due_soon: 0, failed: 0, chronic: 0 });
    const a = renderCard();
    await waitFor(() => expect(a.container.querySelector('a')).toBeNull());
    summary.fn.mockRejectedValueOnce(new Error('boom'));
    const b = renderCard();
    await waitFor(() => expect(b.container.querySelector('.animate-pulse')).toBeNull());
    expect(b.container.querySelector('a')).toBeNull();
  });
});
