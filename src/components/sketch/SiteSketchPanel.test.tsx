import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const api = vi.hoisted(() => ({ listSiteSketches: vi.fn() }));
vi.mock('@/lib/siteSketchApi', () => api);
const auth = vi.hoisted(() => ({ value: { isOwner: true, permissions: { can_view_all_jobs: true } } }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth.value }));

import { SiteSketchPanel } from './SiteSketchPanel';

const item = {
  id: 's1', title: 'Kitchen + dining', unit: 'imperial' as const, job_id: 'j1', quote_id: null,
  area_mm2: 18_580_608, wall_mm: 18_288, thumb: 'M10 10 L90 10', revision: 1,
  created_at: '2027-01-01T00:00:00Z', updated_at: '2027-01-02T00:00:00Z',
};
const renderPanel = (props = {}) =>
  render(
    <MemoryRouter>
      <SiteSketchPanel jobId="j1" {...props} />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  auth.value = { isOwner: true, permissions: { can_view_all_jobs: true } };
});

describe('SiteSketchPanel', () => {
  it('shows a loading state, then the sketch with area and a link to the editor', async () => {
    api.listSiteSketches.mockResolvedValue([item]);
    renderPanel();
    expect(screen.getByLabelText('Loading sketches')).toBeInTheDocument();
    expect(await screen.findByText('Kitchen + dining')).toBeInTheDocument();
    expect(screen.getByText(/200\.0 sq ft/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Kitchen \+ dining/ })).toHaveAttribute('href', '/dashboard/site-sketches/s1');
    expect(screen.getByRole('link', { name: /New sketch/ })).toHaveAttribute('href', '/dashboard/site-sketches/new?job=j1');
  });

  it('shows the empty state', async () => {
    api.listSiteSketches.mockResolvedValue([]);
    renderPanel();
    expect(await screen.findByText(/No sketches yet/)).toBeInTheDocument();
  });

  it('shows an error with a working retry', async () => {
    api.listSiteSketches.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce([item]);
    renderPanel();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load sketches');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText('Kitchen + dining')).toBeInTheDocument());
  });

  it('hides "New sketch" on a quote for non-managers', async () => {
    auth.value = { isOwner: false, permissions: { can_view_all_jobs: false } };
    api.listSiteSketches.mockResolvedValue([]);
    render(
      <MemoryRouter>
        <SiteSketchPanel quoteId="q1" />
      </MemoryRouter>,
    );
    expect(await screen.findByText('No sketches attached.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /New sketch/ })).toBeNull();
  });
});
