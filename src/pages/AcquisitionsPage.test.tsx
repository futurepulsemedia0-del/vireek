import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const auth = {
  profile: { id: 'owner-1', role: 'owner' } as unknown,
  profileLoading: false,
  loading: false,
  isOwner: true,
  permissions: { can_edit_business_profile: true } as Record<string, boolean>,
  teamMember: null as { account_owner_id: string } | null,
};

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/components/DashboardNav', () => ({ DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/acquisitions/NewAcquisitionDialog', () => ({ NewAcquisitionDialog: () => null }));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));

const fetchPortfolio = vi.fn();
const fetchLinkOptions = vi.fn();
vi.mock('@/lib/acquisitionsApi', async () => {
  const actual = await vi.importActual<typeof import('@/lib/acquisitionsApi')>('@/lib/acquisitionsApi');
  return { ...actual, fetchPortfolio: (...a: unknown[]) => fetchPortfolio(...a), fetchLinkOptions: (...a: unknown[]) => fetchLinkOptions(...a) };
});

import { AcquisitionsPage } from './AcquisitionsPage';

const company = (over: Record<string, unknown> = {}) => ({
  id: 'a1', name: 'Acme Plumbing', status: 'integrating', close_date: '2020-01-01', scope_kind: 'imported', currency: 'USD', purchase_price_cents: null,
  has_live_data: true, kpis: { jobs_count: 120, revenue_cents: 5000000, gross_margin_pct: 41.5, utilization_pct: 62, retention_pct: 72, retention_at_risk: 9 },
  baseline: null, ws_total: 9, ws_done: 3, ws_overdue: 1, ws_blocked: 0, cost_plan_cents: 0, cost_actual_cents: 0, rev_plan_cents: 0, rev_actual_cents: 0, ...over,
});

const renderPage = () => render(<MemoryRouter><AcquisitionsPage /></MemoryRouter>);

describe('AcquisitionsPage', () => {
  beforeEach(() => {
    fetchPortfolio.mockReset();
    fetchLinkOptions.mockReset();
    fetchLinkOptions.mockResolvedValue({ brands: [], locations: [], franchiseLocations: [], members: [], allLinks: {} });
    auth.isOwner = true;
    auth.permissions = { can_edit_business_profile: true };
    auth.teamMember = null;
  });

  it('blocks members without the edit-business-profile permission', () => {
    auth.isOwner = false;
    auth.permissions = {};
    auth.teamMember = { account_owner_id: 'owner-1' };
    renderPage();
    expect(screen.getByText(/don't have access to Acquisitions/i)).toBeTruthy();
    expect(fetchPortfolio).not.toHaveBeenCalled();
  });

  it('shows the empty state when nothing has been acquired yet', async () => {
    fetchPortfolio.mockResolvedValue({ parent: null, companies: [] });
    renderPage();
    expect(await screen.findByText('No acquisitions yet')).toBeTruthy();
  });

  it('lists each company with its health, overdue count and retention risk', async () => {
    fetchPortfolio.mockResolvedValue({ parent: { gross_margin_pct: 35, utilization_pct: 70, retention_pct: 80 }, companies: [company()] });
    renderPage();
    expect(await screen.findByText('Acme Plumbing')).toBeTruthy();
    expect(screen.getByText('1 overdue')).toBeTruthy();
    expect(screen.getByText('Watch')).toBeTruthy();
    expect(screen.getByText('3 of 9 workstreams done')).toBeTruthy();
    expect(screen.getAllByText('41.5%').length).toBeGreaterThan(0);
    const link = screen.getByRole('link', { name: 'Acme Plumbing' });
    expect(link.getAttribute('href')).toBe('/dashboard/acquisitions/a1');
  });

  it('explains a company that has no live numbers yet', async () => {
    fetchPortfolio.mockResolvedValue({ parent: null, companies: [company({ has_live_data: false, kpis: null })] });
    renderPage();
    expect(await screen.findByText(/No live numbers yet/i)).toBeTruthy();
  });

  it('shows an error with a working retry', async () => {
    fetchPortfolio.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ parent: null, companies: [] });
    renderPage();
    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(fetchPortfolio).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('No acquisitions yet')).toBeTruthy();
  });
});
