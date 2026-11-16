import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { NorthStarTreeCard } from '@/components/staff/growth/NorthStarTreeCard';
import { parseNorthStar } from '@/lib/growth/northStar';

const fetchNorthStar = vi.hoisted(() => vi.fn());
vi.mock('@/lib/growth/growthApi', () => ({ fetchNorthStar }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const monday = (daysAgo: number) => {
  const d = new Date(); d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) - daysAgo);
  return d.toISOString().slice(0, 10);
};

describe('NorthStarTreeCard', () => {
  it('shows the error state with a retry that reloads', async () => {
    fetchNorthStar.mockRejectedValueOnce(new Error('forbidden'));
    render(<NorthStarTreeCard />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    fetchNorthStar.mockResolvedValueOnce(parseNorthStar({ weeks: [] }));
    screen.getByRole('button', { name: /retry/i }).click();
    await waitFor(() => expect(fetchNorthStar).toHaveBeenCalledTimes(2));
  });

  it('shows an empty state (no invented numbers) when there is no complete week', async () => {
    fetchNorthStar.mockResolvedValueOnce(parseNorthStar({ weeks: [] }));
    render(<NorthStarTreeCard />);
    expect(await screen.findByText(/No complete call-week yet/i)).toBeTruthy();
    expect(screen.queryByRole('group', { name: /metric tree/i })).toBeNull();
  });

  it('renders the tree and weekly table from counts', async () => {
    fetchNorthStar.mockResolvedValueOnce(parseNorthStar({
      weeks: [{ week_start: monday(7), calls_n: 100, booked_calls_n: 40, jobs_n: 40, kept_n: 25, resolved_n: 30, pending_n: 10, accounts_with_calls_n: 5, active_accounts_n: 4, paid_cents: 1000 }],
      data_quality: { calls_qualifying_90d: 100, calls_all_sources_90d: 120 },
    }));
    render(<NorthStarTreeCard />);
    expect(await screen.findByRole('group', { name: /metric tree/i })).toBeTruthy();
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getByText(/10 booked jobs are not resolved yet/i)).toBeTruthy();
  });
});
