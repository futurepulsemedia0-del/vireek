import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ supabase: { rpc: rpcMock } }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'user-1' } }) }));

import { TechnicianSchedulePage } from '@/pages/TechnicianSchedulePage';
import {
  clearScheduleCache, dayKey, groupByDay, normalizeJobs, orderStops, readScheduleCache, routeNavUrl,
  stopNavUrl, summarizeDay, weekDays, weekStart, writeScheduleCache, type ScheduleJob,
} from '@/lib/technicianSchedule';

let seq = 0;
function job(over: Partial<ScheduleJob> = {}): ScheduleJob {
  seq += 1;
  return {
    id: `job-${seq}`,
    customer_name: `Customer ${seq}`,
    address: `${seq} Main St`,
    service_type: 'Repair',
    scheduled_datetime: new Date(2026, 9, 5, 9).toISOString(),
    job_status: 'scheduled',
    expected_duration_minutes: 60,
    safety_flag: false,
    latitude: null,
    longitude: null,
    route_sequence: null,
    ...over,
  };
}

describe('week math', () => {
  it('starts the week on Monday (Sunday belongs to the previous Monday)', () => {
    expect(dayKey(weekStart(new Date(2026, 9, 11)))).toBe('2026-10-05'); // Sunday
    expect(dayKey(weekStart(new Date(2026, 9, 5)))).toBe('2026-10-05'); // Monday
    expect(dayKey(weekStart(new Date(2026, 9, 9), 1))).toBe('2026-10-12');
  });

  it('returns 7 distinct consecutive days, also across a DST change', () => {
    const days = weekDays(weekStart(new Date(2026, 10, 1))); // week containing US DST end
    expect(new Set(days.map(dayKey)).size).toBe(7);
  });
});

describe('route order', () => {
  it('orders by route_sequence (nulls last), then time', () => {
    const a = job({ id: 'a', route_sequence: 2, scheduled_datetime: new Date(2026, 9, 5, 8).toISOString() });
    const b = job({ id: 'b', route_sequence: 1, scheduled_datetime: new Date(2026, 9, 5, 14).toISOString() });
    const c = job({ id: 'c', route_sequence: null, scheduled_datetime: new Date(2026, 9, 5, 7).toISOString() });
    expect(orderStops([a, b, c]).map((j) => j.id)).toEqual(['b', 'a', 'c']);
  });

  it('buckets jobs by local day and summarizes remaining work', () => {
    const days = weekDays(weekStart(new Date(2026, 9, 5)));
    const mon = job({ job_status: 'completed' });
    const tue = job({ scheduled_datetime: new Date(2026, 9, 6, 23, 30).toISOString(), expected_duration_minutes: 90 });
    const map = groupByDay([mon, tue], days);
    expect(map.get('2026-10-05')).toHaveLength(1);
    expect(map.get('2026-10-06')).toHaveLength(1);
    expect(summarizeDay([mon, tue])).toEqual({ total: 2, remaining: 1, plannedMinutes: 90 });
  });
});

describe('navigation links', () => {
  it('prefers coordinates, falls back to the address, returns null with neither', () => {
    expect(stopNavUrl({ address: '1 A St', latitude: 40.1, longitude: -74.2 })).toContain(encodeURIComponent('40.1,-74.2'));
    expect(stopNavUrl({ address: '1 A St', latitude: null, longitude: null })).toContain(encodeURIComponent('1 A St'));
    expect(stopNavUrl({ address: null, latitude: null, longitude: null })).toBeNull();
    expect(stopNavUrl({ address: 'x', latitude: null, longitude: null }, 'waze')).toBeNull();
  });

  it('builds a multi-stop route over remaining stops only, capped at 10', () => {
    const done = job({ job_status: 'completed', address: 'Done Rd' });
    const open = Array.from({ length: 12 }, (_, i) => job({ address: `Stop ${i}` }));
    const nav = routeNavUrl([done, ...open])!;
    expect(nav.stops).toBe(10);
    expect(nav.truncated).toBe(true);
    expect(decodeURIComponent(nav.url)).not.toContain('Done Rd');
    expect(routeNavUrl([done])).toBeNull();
  });
});

describe('data hygiene', () => {
  beforeEach(() => localStorage.clear());

  it('drops malformed rows and coerces numerics', () => {
    const rows = normalizeJobs([
      { id: 'ok', scheduled_datetime: '2026-10-05T09:00:00Z', latitude: '40.5', job_status: 'weird' },
      { id: 'bad-date', scheduled_datetime: 'nope' },
      { scheduled_datetime: '2026-10-05T09:00:00Z' },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].latitude).toBe(40.5);
    expect(rows[0].job_status).toBe('scheduled');
  });

  it('caches per user and clears on sign-out', () => {
    const start = weekStart(new Date(2026, 9, 5));
    writeScheduleCache('user-1', start, [job()]);
    expect(readScheduleCache('user-1', start)?.jobs).toHaveLength(1);
    expect(readScheduleCache('user-2', start)).toBeNull();
    clearScheduleCache();
    expect(readScheduleCache('user-1', start)).toBeNull();
  });
});

describe('TechnicianSchedulePage', () => {
  const todayAt = (h: number) => {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate(), h).toISOString();
  };
  const renderPage = () =>
    render(
      <MemoryRouter>
        <TechnicianSchedulePage />
      </MemoryRouter>,
    );

  beforeEach(() => {
    localStorage.clear();
    rpcMock.mockReset();
    Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true });
  });

  it('shows today\'s stops in route order with navigation links', async () => {
    rpcMock.mockResolvedValue({
      data: [
        { ...job({ id: 'late', customer_name: 'Second Stop', route_sequence: 2, scheduled_datetime: todayAt(9) }) },
        { ...job({ id: 'early', customer_name: 'First Stop', route_sequence: 1, scheduled_datetime: todayAt(15) }) },
      ],
      error: null,
    });
    renderPage();
    const cards = await screen.findAllByTestId('stop-card');
    expect(cards[0]).toHaveTextContent('First Stop');
    expect(cards[1]).toHaveTextContent('Second Stop');
    expect(screen.getByRole('link', { name: /navigate full route/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Navigate to First Stop' })).toHaveAttribute('href', expect.stringContaining('google.com/maps'));
  });

  it('shows the empty state when the week has no jobs', async () => {
    rpcMock.mockResolvedValue({ data: [], error: null });
    renderPage();
    expect(await screen.findByText('No jobs this week')).toBeInTheDocument();
  });

  it('shows an error state and retries', async () => {
    rpcMock.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ data: [], error: null });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('No jobs this week')).toBeInTheDocument();
  });

  it('works offline from the saved copy without calling the server', async () => {
    writeScheduleCache('user-1', weekStart(new Date()), [
      job({ customer_name: 'Saved Customer', scheduled_datetime: todayAt(10) }),
    ]);
    Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true });
    renderPage();
    expect(await screen.findByText('Saved Customer')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/offline/i);
    expect(rpcMock).not.toHaveBeenCalled();
  });
});
