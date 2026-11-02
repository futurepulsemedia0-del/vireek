import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { TechnicianTodayPage } from './TechnicianTodayPage';

// Vitest globals are off in this project, so RTL's auto-cleanup isn't registered.
afterEach(cleanup);

const mocks = vi.hoisted(() => ({
  fetchTodayJobs: vi.fn(),
  fetchUnreadTotal: vi.fn(),
  navigateToAddress: vi.fn(),
  shareContent: vi.fn(),
}));

vi.mock('@/lib/technicianOS', () => ({
  fetchTodayJobs: mocks.fetchTodayJobs,
  formatTime: () => '9:00 AM',
  STATUS_LABELS: { scheduled: 'Scheduled', en_route: 'En route', in_progress: 'In progress', completed: 'Completed' },
}));
vi.mock('@/lib/jobMessages', () => ({ fetchUnreadTotal: mocks.fetchUnreadTotal }));
vi.mock('@/lib/realtime', () => ({ useRealtimeSubscription: () => 'connected' }));
vi.mock('@/lib/native/badge', () => ({ syncAppBadge: vi.fn() }));
vi.mock('@/lib/native/haptics', () => ({ haptic: vi.fn() }));
vi.mock('@/lib/native/nativeActions', () => ({ navigateToAddress: mocks.navigateToAddress, shareContent: mocks.shareContent }));
vi.mock('@/contexts/UndoContext', () => ({ useUndo: () => ({ offerUndo: vi.fn() }) }));
vi.mock('@/components/tour/ReplayTourMenu', () => ({ ReplayTourMenu: () => null }));
vi.mock('@/components/tour/ContextualTip', () => ({ ContextualTip: ({ children }: { children: ReactNode }) => <>{children}</> }));

const job = (over: Record<string, unknown> = {}) => ({
  id: 'j1',
  customer_name: 'Jane Smith',
  address: '12 Main St',
  service_type: 'AC repair',
  scheduled_datetime: '2026-11-02T09:00:00Z',
  job_status: 'scheduled',
  arrived_at: null,
  started_at: null,
  completed_at: null,
  expected_duration_minutes: 60,
  safety_flag: false,
  ...over,
});

function renderPage() {
  return render(
    <MemoryRouter>
      <TechnicianTodayPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchUnreadTotal.mockResolvedValue(0);
  mocks.shareContent.mockResolvedValue(true);
});

describe('TechnicianTodayPage', () => {
  it('lists today\'s jobs', async () => {
    mocks.fetchTodayJobs.mockResolvedValue([job(), job({ id: 'j2', customer_name: 'Bob Lee' })]);
    renderPage();
    expect(await screen.findByText('Jane Smith')).toBeTruthy();
    expect(screen.getByText('Bob Lee')).toBeTruthy();
  });

  it('shows the empty state', async () => {
    mocks.fetchTodayJobs.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText('No jobs scheduled for today.')).toBeTruthy();
  });

  it('shows an error with Retry instead of a false empty state', async () => {
    mocks.fetchTodayJobs.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce([job()]);
    renderPage();
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('No jobs scheduled for today.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Jane Smith')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('announces unread messages on the Messages link', async () => {
    mocks.fetchTodayJobs.mockResolvedValue([]);
    mocks.fetchUnreadTotal.mockResolvedValue(3);
    renderPage();
    expect(await screen.findByRole('link', { name: 'Messages, 3 unread' })).toBeTruthy();
  });

  it('links to the timesheet and pay screens', async () => {
    mocks.fetchTodayJobs.mockResolvedValue([]);
    renderPage();
    expect((await screen.findByRole('link', { name: 'Timesheet' })).getAttribute('href')).toBe('/tech/timesheet');
    expect(screen.getByRole('link', { name: 'Pay' }).getAttribute('href')).toBe('/tech/pay');
  });

  it('opens the quick-actions sheet and navigates to the job address', async () => {
    mocks.fetchTodayJobs.mockResolvedValue([job()]);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'More actions for Jane Smith' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Navigate' }));
    expect(mocks.navigateToAddress).toHaveBeenCalledWith('12 Main St');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('disables Navigate when the job has no address', async () => {
    mocks.fetchTodayJobs.mockResolvedValue([job({ address: null })]);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'More actions for Jane Smith' }));
    expect((within(screen.getByRole('dialog')).getByRole('button', { name: 'Navigate' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
