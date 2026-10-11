import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { parseWorkspace } from '@/lib/quoteWorkspace';
import { QuoteDetailPage } from './QuoteDetailPage';

const QUOTE_ID = '11111111-1111-4111-8111-111111111111';

const { auth, api } = vi.hoisted(() => ({
  auth: {
    accountOwnerId: 'owner-1' as string | null,
    permissions: { can_view_billing: true },
    loading: false,
    profileLoading: false,
  },
  api: {
    fetchQuoteWorkspace: vi.fn(),
    scheduleQuoteFollowUps: vi.fn(),
    completeQuoteFollowUp: vi.fn(),
    convertQuoteToJob: vi.fn(),
  },
}));

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/components/DashboardNav', () => ({
  DashboardLayout: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/lib/quoteWorkspaceApi', () => api);

function rawWorkspace(quote: Record<string, unknown> = {}, rest: Record<string, unknown> = {}) {
  return {
    quote: {
      id: QUOTE_ID,
      user_id: 'owner-1',
      customer_name: 'Dana Whitfield',
      status: 'sent',
      quote_token: '22222222-2222-4222-8222-222222222222',
      tax_percent: 0,
      deposit_percent: 0,
      view_count: 2,
      created_at: '2026-09-30T12:00:00.000Z',
      updated_at: '2026-10-01T12:00:00.000Z',
      sent_at: '2026-10-01T12:00:00.000Z',
      line_items: [{ description: 'Water heater install', quantity: 1, unit_price_cents: 120_000 }],
      options: [],
      ...quote,
    },
    versions: [],
    events: [],
    followups: [],
    job: null,
    lead: null,
    ...rest,
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/dashboard/quotes/${QUOTE_ID}`]}>
      <Routes>
        <Route path="/dashboard/quotes/:id" element={<QuoteDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function mockLoad(raw: ReturnType<typeof rawWorkspace>) {
  const data = parseWorkspace(raw);
  api.fetchQuoteWorkspace.mockResolvedValue({ ok: true, data });
}

describe('QuoteDetailPage', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    auth.accountOwnerId = 'owner-1';
    auth.permissions = { can_view_billing: true };
    auth.loading = false;
    auth.profileLoading = false;
  });

  it('blocks users without billing access and never requests the quote', async () => {
    auth.permissions = { can_view_billing: false };
    renderPage();
    expect(await screen.findByText(/don.t have access to quote details/i)).toBeInTheDocument();
    expect(api.fetchQuoteWorkspace).not.toHaveBeenCalled();
  });

  it('shows a loading state first, then the quote', async () => {
    mockLoad(rawWorkspace());
    renderPage();
    expect(screen.getByRole('status', { name: /loading quote/i })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { level: 1, name: 'Dana Whitfield' })).toBeInTheDocument();
    expect(screen.getByText('Water heater install')).toBeInTheDocument();
    expect(api.fetchQuoteWorkspace).toHaveBeenCalledWith(QUOTE_ID);
  });

  it('refuses to render a quote that belongs to another account', async () => {
    mockLoad(rawWorkspace({ user_id: 'someone-else' }));
    renderPage();
    expect(await screen.findByText('Quote not found')).toBeInTheDocument();
    expect(screen.queryByText('Dana Whitfield')).not.toBeInTheDocument();
  });

  it('shows not-found when the server returns nothing', async () => {
    api.fetchQuoteWorkspace.mockResolvedValue({ ok: false, reason: 'not_found' });
    renderPage();
    expect(await screen.findByText('Quote not found')).toBeInTheDocument();
  });

  it('shows a retry action when loading fails, and retries', async () => {
    api.fetchQuoteWorkspace.mockResolvedValueOnce({ ok: false, reason: 'failed' });
    renderPage();
    const retry = await screen.findByRole('button', { name: /try again/i });
    mockLoad(rawWorkspace());
    fireEvent.click(retry);
    expect(await screen.findByRole('heading', { level: 1, name: 'Dana Whitfield' })).toBeInTheDocument();
  });

  it('marks the option the customer chose and shows the version diff', async () => {
    const snap = (price: number) => ({
      customer_name: 'Dana Whitfield',
      line_items: [{ description: 'Repair', quantity: 1, unit_price_cents: price }],
      options: [],
      tax_percent: 0,
    });
    mockLoad(
      rawWorkspace(
        {
          status: 'accepted',
          selected_option_id: 'opt-b',
          accepted_total_cents: 50_000,
          options: [
            { id: 'opt-a', tier: 'good', name: 'Essential fix', line_items: [{ description: 'Patch', quantity: 1, unit_price_cents: 20_000 }] },
            { id: 'opt-b', tier: 'better', name: 'Full repair', recommended: true, line_items: [{ description: 'Repair', quantity: 1, unit_price_cents: 50_000 }] },
          ],
          recommended_option_id: 'opt-b',
        },
        {
          versions: [
            { id: 'v2', version_number: 2, snapshot: snap(55_000), total_cents: 55_000, created_at: '2026-10-02T12:00:00.000Z' },
            { id: 'v1', version_number: 1, snapshot: snap(50_000), total_cents: 50_000, created_at: '2026-09-30T12:00:00.000Z' },
          ],
        },
      ),
    );
    renderPage();
    expect(await screen.findByText('Chosen')).toBeInTheDocument();
    expect(screen.getByText('Full repair')).toBeInTheDocument();
    expect(screen.getAllByText(/\+\$50\.00/).length).toBeGreaterThan(0);
  });

  it('converts an accepted quote to a job once, ignoring a double click', async () => {
    mockLoad(rawWorkspace({ status: 'accepted', accepted_total_cents: 120_000 }));
    let release: (v: unknown) => void = () => undefined;
    api.convertQuoteToJob.mockReturnValue(new Promise((resolve) => { release = resolve; }));

    renderPage();
    const button = await screen.findByRole('button', { name: 'Convert to job' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(api.convertQuoteToJob).toHaveBeenCalledTimes(1);
    expect(api.convertQuoteToJob).toHaveBeenCalledWith(QUOTE_ID, { scheduledAt: null, address: null });

    mockLoad(rawWorkspace({ status: 'accepted' }, { job: { id: 'job-1', job_status: 'scheduled', created_at: '2026-10-07T12:00:00.000Z' } }));
    release({ ok: true, jobId: 'job-1' });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Convert to job' })).not.toBeInTheDocument());
    expect(screen.getByRole('link', { name: /open jobs board/i })).toBeInTheDocument();
  });

  it('does not offer conversion for a quote that is not accepted', async () => {
    mockLoad(rawWorkspace({ status: 'sent' }));
    renderPage();
    await screen.findByRole('heading', { level: 1, name: 'Dana Whitfield' });
    expect(screen.queryByRole('button', { name: 'Convert to job' })).not.toBeInTheDocument();
    expect(screen.getByText(/available as soon as the customer accepts/i)).toBeInTheDocument();
  });

  it('creates a follow-up plan for a sent quote', async () => {
    mockLoad(rawWorkspace({ status: 'sent', valid_until: null }));
    api.scheduleQuoteFollowUps.mockResolvedValue({ ok: true });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /create plan/i }));
    await waitFor(() => expect(api.scheduleQuoteFollowUps).toHaveBeenCalledTimes(1));
    const [quoteId, steps] = api.scheduleQuoteFollowUps.mock.calls[0];
    expect(quoteId).toBe(QUOTE_ID);
    expect(steps).toHaveLength(4);
  });
});
