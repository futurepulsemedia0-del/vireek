import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PowerDialerPage } from './PowerDialerPage';
import type { DialerCampaign, DialerContact, DialerStats } from '@/lib/powerDialer';

const api = vi.hoisted(() => ({
  fetchCampaigns: vi.fn(), fetchStats: vi.fn(), fetchCallerIds: vi.fn(), fetchCampaign: vi.fn(), fetchRecentContacts: vi.fn(),
  claimNext: vi.fn(), completeAttempt: vi.fn(), placeCall: vi.fn(), deferContact: vi.fn(),
  createCampaign: vi.fn(), updateCampaign: vi.fn(), setCampaignStatus: vi.fn(), importContacts: vi.fn(), importFromCrm: vi.fn(),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'owner-1' }, teamMember: null, isOwner: true, permissions: { can_manage_numbers: true, can_view_billing: true } }),
}));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/components/DashboardNav', () => ({ DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/powerDialerApi', () => ({ ...api, WrapUpError: class extends Error { constructor(public seconds: number) { super('wrap'); } } }));

const campaign: DialerCampaign = {
  id: 'c1', name: 'Spring tune-ups', description: null, status: 'active', pacing_mode: 'preview', preview_seconds: 0, wrap_up_seconds: 0,
  max_attempts: 3, retry_minutes: 240, max_calls_per_hour: 60, phone_number_id: 'p1', script: 'Say hello', created_at: '2026-10-01T00:00:00Z',
};
const stats: DialerStats = { campaign_id: 'c1', total_contacts: 10, ready_now: 4, pending: 6, claimed: 0, done: 4, dnc: 0, total_attempts: 8, booked: 2, interested: 1 };
const contact: DialerContact = {
  id: 'k1', campaign_id: 'c1', name: 'Ann Lee', phone_e164: '+15552010001', notes: null, status: 'claimed', attempts: 0,
  last_disposition: null, next_attempt_at: '2026-10-26T00:00:00Z', claim_expires_at: null,
};

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/dashboard/power-dialer" element={<PowerDialerPage />} />
        <Route path="/dashboard/power-dialer/:campaignId" element={<PowerDialerPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(cleanup);

beforeEach(() => {
  Object.values(api).forEach((m) => m.mockReset());
  api.fetchStats.mockResolvedValue({ c1: stats });
  api.fetchCallerIds.mockResolvedValue([]);
  api.fetchRecentContacts.mockResolvedValue([]);
});

describe('PowerDialerPage list', () => {
  it('shows the empty state', async () => {
    api.fetchCampaigns.mockResolvedValue([]);
    renderAt('/dashboard/power-dialer');
    expect(await screen.findByText('No campaigns yet')).toBeTruthy();
  });
  it('shows an error with retry', async () => {
    api.fetchCampaigns.mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce([campaign]);
    renderAt('/dashboard/power-dialer');
    expect(await screen.findByText('Could not load campaigns')).toBeTruthy();
    fireEvent.click(screen.getByText('Try again'));
    expect(await screen.findByText('Spring tune-ups')).toBeTruthy();
  });
  it('lists campaigns with progress', async () => {
    api.fetchCampaigns.mockResolvedValue([campaign]);
    renderAt('/dashboard/power-dialer');
    expect(await screen.findByText('Spring tune-ups')).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: /Spring tune-ups progress/ }).getAttribute('aria-valuenow')).toBe('40');
  });
});

describe('PowerDialerPage console', () => {
  beforeEach(() => {
    api.fetchCampaign.mockResolvedValue(campaign);
    api.claimNext.mockResolvedValueOnce(contact).mockResolvedValue(null);
    api.completeAttempt.mockResolvedValue(undefined);
  });

  it('shows the claimed contact and saves a disposition, then loads the next one', async () => {
    renderAt('/dashboard/power-dialer/c1');
    expect(await screen.findByText('Ann Lee')).toBeTruthy();
    expect(screen.getByText('Say hello')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Booked/ }));
    await waitFor(() => expect(api.completeAttempt).toHaveBeenCalledWith('k1', 'booked', '', null));
    expect(await screen.findByText('No contacts are due right now')).toBeTruthy();
  });

  it('asks for a time before saving a callback', async () => {
    renderAt('/dashboard/power-dialer/c1');
    await screen.findByText('Ann Lee');
    fireEvent.click(screen.getByRole('button', { name: /Call back later/ }));
    expect(await screen.findByLabelText('Call back at')).toBeTruthy();
    expect(api.completeAttempt).not.toHaveBeenCalled();
  });

  it('keyboard shortcut records the outcome', async () => {
    renderAt('/dashboard/power-dialer/c1');
    await screen.findByText('Ann Lee');
    fireEvent.keyDown(window, { key: '4' });
    await waitFor(() => expect(api.completeAttempt).toHaveBeenCalledWith('k1', 'no_answer', '', null));
  });

  it('draft campaigns do not show the console', async () => {
    api.fetchCampaign.mockResolvedValue({ ...campaign, status: 'draft' });
    renderAt('/dashboard/power-dialer/c1');
    expect(await screen.findByText(/This campaign is draft/)).toBeTruthy();
    expect(api.claimNext).not.toHaveBeenCalled();
  });
});
