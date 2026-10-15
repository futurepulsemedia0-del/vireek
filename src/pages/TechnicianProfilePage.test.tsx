import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { MyTechnicianProfile } from '@/lib/technicianProfile';

const api = vi.hoisted(() => ({
  fetchMyTechnicianProfile: vi.fn(),
  saveMyAvailability: vi.fn(),
  saveMyPreferences: vi.fn(),
}));
const toast = vi.hoisted(() => vi.fn());

vi.mock('@/lib/technicianProfileApi', () => api);
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast }) }));

import { TechnicianProfilePage } from './TechnicianProfilePage';

const iso = (offsetDays: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const profile = (over: Partial<MyTechnicianProfile> = {}): MyTechnicianProfile => ({
  member: {
    id: 'm1',
    member_name: 'Sam Rivera',
    member_email: 'sam@example.com',
    member_phone: null,
    skills: ['HVAC'],
    languages: ['English'],
    service_area: null,
    max_jobs_per_day: 6,
    dispatch_enabled: true,
  },
  credentials: [
    { id: 'c1', credential_type: 'epa_608', credential_name: 'EPA 608', issuing_authority: null, credential_number: null, issued_at: null, expires_at: iso(-3), status: 'active' },
    { id: 'c2', credential_type: 'nate', credential_name: 'NATE', issuing_authority: null, credential_number: null, issued_at: null, expires_at: iso(400), status: 'active' },
  ],
  preferences: { notify_credential_expiry: true, credential_alert_days: 30, notify_job_assigned: true, notify_schedule_change: true },
  ...over,
});

const renderPage = () => render(<MemoryRouter><TechnicianProfilePage /></MemoryRouter>);

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  api.saveMyAvailability.mockResolvedValue(undefined);
  api.saveMyPreferences.mockResolvedValue(undefined);
});

describe('TechnicianProfilePage', () => {
  it('shows an error with retry, then the profile', async () => {
    api.fetchMyTechnicianProfile.mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce(profile());
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /retry/i }));
    expect(await screen.findByText('Sam Rivera')).toBeInTheDocument();
  });

  it('shows the not-linked empty state when there is no team member', async () => {
    api.fetchMyTechnicianProfile.mockResolvedValue(null);
    renderPage();
    expect(await screen.findByText('No technician profile linked')).toBeInTheDocument();
  });

  it('lists credentials most urgent first with an expiry alert', async () => {
    api.fetchMyTechnicianProfile.mockResolvedValue(profile());
    renderPage();
    expect(await screen.findByText('Expired 3 days ago')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('1 expired');
    const names = screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(names[0]).toContain('EPA 608');
  });

  it('shows an empty state when there are no credentials', async () => {
    api.fetchMyTechnicianProfile.mockResolvedValue(profile({ credentials: [] }));
    renderPage();
    expect(await screen.findByText('No credentials on file')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('saves availability only when changed', async () => {
    api.fetchMyTechnicianProfile.mockResolvedValue(profile());
    renderPage();
    const save = await screen.findByRole('button', { name: /save availability/i });
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /increase max jobs/i }));
    fireEvent.click(screen.getByRole('switch', { name: /available for dispatch/i }));
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(api.saveMyAvailability).toHaveBeenCalledWith({ dispatchEnabled: false, maxJobsPerDay: 7 }));
    await waitFor(() => expect(save).toBeDisabled());
  });

  it('reports a failed notification save and keeps the form dirty', async () => {
    api.fetchMyTechnicianProfile.mockResolvedValue(profile());
    api.saveMyPreferences.mockRejectedValueOnce(new Error('rls'));
    renderPage();
    const save = await screen.findByRole('button', { name: /save notification settings/i });
    fireEvent.click(screen.getByRole('switch', { name: /schedule changes/i }));
    fireEvent.change(screen.getByLabelText(/warn me/i), { target: { value: '90' } });
    fireEvent.click(save);
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringMatching(/could not save/i), 'error'));
    expect(api.saveMyPreferences).toHaveBeenCalledWith(expect.objectContaining({ notify_schedule_change: false, credential_alert_days: 90 }));
    expect(save).toBeEnabled();
  });
});
