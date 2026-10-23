import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ProjectProgressPage } from './ProjectProgressPage';
import * as api from '@/lib/projectSchedulerApi';

vi.mock('@/components/Header', () => ({ Header: () => <header /> }));
vi.mock('@/components/Footer', () => ({ Footer: () => <footer /> }));
vi.mock('@/lib/projectSchedulerApi', async (orig) => ({ ...(await orig<typeof api>()), fetchPublicProgress: vi.fn() }));

const TOKEN = '11111111-1111-1111-1111-111111111111';
const mount = () => render(<MemoryRouter initialEntries={[`/project/${TOKEN}`]}><Routes><Route path="/project/:token" element={<ProjectProgressPage />} /></Routes></MemoryRouter>);

const payload = (showDates: boolean): api.PublicProgress => api.toPublicProgress({
  business_name: 'Acme HVAC', show_dates: showDates,
  project: { name: 'Full system replacement', project_type: 'hvac', status: 'active', start_date: showDates ? '2027-03-01' : null, target_end_date: showDates ? '2027-04-01' : null },
  phases: [
    { id: 'a', name: 'Site survey', sort_order: 0, weight: 1, status: 'completed', planned_start: showDates ? '2027-03-01' : null, planned_end: showDates ? '2027-03-03' : null, actual_start: null, actual_end: null },
    { id: 'b', name: 'Install', sort_order: 1, weight: 1, status: 'not_started', planned_start: showDates ? '2027-03-04' : null, planned_end: showDates ? '2027-03-10' : null, actual_start: null, actual_end: null },
  ],
  milestones: [{ id: 'm1', phase_id: 'b', title: 'Rough-in complete', kind: 'task', status: 'pending', due_date: null, sort_order: 0 }],
});

describe('ProjectProgressPage', () => {
  beforeEach(() => vi.mocked(api.fetchPublicProgress).mockReset());

  it('shows a loading state, then the project', async () => {
    vi.mocked(api.fetchPublicProgress).mockResolvedValue({ kind: 'ok', data: payload(true) });
    mount();
    expect(screen.getByLabelText('Loading project progress')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Full system replacement' })).toBeInTheDocument();
    expect(screen.getByText('Acme HVAC')).toBeInTheDocument();
    expect(screen.getByText('Rough-in complete')).toBeInTheDocument();
    expect(screen.getByText('Up next')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Overall progress' })).toHaveAttribute('aria-valuenow', '50');
  });

  it('hides every date when the contractor turned dates off', async () => {
    vi.mocked(api.fetchPublicProgress).mockResolvedValue({ kind: 'ok', data: payload(false) });
    mount();
    await screen.findByRole('heading', { name: 'Full system replacement' });
    expect(screen.queryByLabelText('Timeline')).not.toBeInTheDocument();
    expect(screen.queryByText(/Estimated completion/)).not.toBeInTheDocument();
  });

  it('explains an unavailable link', async () => {
    vi.mocked(api.fetchPublicProgress).mockResolvedValue({ kind: 'not_found' });
    mount();
    expect(await screen.findByText('This progress link isn’t available')).toBeInTheDocument();
  });

  it('offers a retry after a network error', async () => {
    vi.mocked(api.fetchPublicProgress).mockResolvedValueOnce({ kind: 'error' }).mockResolvedValueOnce({ kind: 'ok', data: payload(true) });
    mount();
    const retry = await screen.findByRole('button', { name: 'Try again' });
    retry.click();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Full system replacement' })).toBeInTheDocument());
  });
});
