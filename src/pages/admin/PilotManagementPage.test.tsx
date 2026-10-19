import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PilotManagementPage } from '@/pages/admin/PilotManagementPage';
import { toCaseStudy, toFlaggedCall, toPilot, toWeek } from '@/lib/pilotManagement';

vi.mock('@/components/Header', () => ({ Header: () => null }));
vi.mock('@/lib/seo', () => ({ useSEO: () => undefined }));

const toast = vi.fn();
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast }) }));

const api = vi.hoisted(() => ({
  listPilots: vi.fn(), createPilot: vi.fn(), updatePilot: vi.fn(), deletePilot: vi.fn(),
  getPilotTrend: vi.fn(), getFlaggedCalls: vi.fn(), listPilotAudit: vi.fn(), exportCaseStudy: vi.fn(),
}));
vi.mock('@/lib/pilotManagementApi', () => api);

const searchTenants = vi.hoisted(() => vi.fn());
vi.mock('@/lib/featureFlagsApi', () => ({ searchTenants }));

const exportToCsv = vi.hoisted(() => vi.fn());
vi.mock('@/lib/csvExport', () => ({ exportToCsv }));

const download = vi.hoisted(() => vi.fn());
vi.mock('@/lib/pilotManagement', async (orig) => ({ ...(await orig<typeof import('@/lib/pilotManagement')>()), downloadTextFile: download }));

const rawPilot = (over: Record<string, unknown> = {}) => ({
  id: 'p1', tenant_id: 't1', status: 'active', started_on: '2027-05-25', ended_on: null,
  tenant_email: 'acme@example.com', company_name: 'Acme HVAC', plan: 'professional',
  baseline_weekly_calls: 40, baseline_missed_call_pct: 35, baseline_booking_rate_pct: 50, baseline_avg_job_value_cents: 40000, baseline_weekly_revenue_cents: 900000,
  baseline_source: 'self_reported', baseline_notes: null, consent_status: 'not_requested', consent_scope: [], consent_evidence: null, consent_granted_at: null, notes: null,
  live_days: 21, weeks_elapsed: 3, live_weekly_calls: 45.5, live_missed_call_pct: 20, live_booking_rate_pct: 75, live_avg_job_value_cents: 42000,
  live_weekly_revenue_cents: 1200000, live_avg_call_score: 81, total_calls: 136, flagged_calls: 4, recovered_cents: 250000, recovered_count: 5, updated_at: '2027-06-14T10:00:00Z',
  ...over,
});

const weeks = [
  toWeek({ week_index: 1, week_start: '2027-05-25', week_end: '2027-05-31', is_complete: true, total_calls: 20, missed_calls: 4, booking_opportunities: 10, booked: 7, flagged_calls: 1, revenue_cents: 120000, recovered_cents: 40000 }),
  toWeek({ week_index: 2, week_start: '2027-06-01', week_end: '2027-06-07', is_complete: false, total_calls: 0, missed_calls: 0, booking_opportunities: 0, booked: 0, flagged_calls: 0, revenue_cents: 0, recovered_cents: 0 }),
];
const flaggedCall = toFlaggedCall({ call_id: 'abcdef12-0000-0000-0000-000000000000', call_datetime: '2027-06-02T15:00:00Z', call_score: 40, sentiment: 'negative', booking_outcome: 'not_booked', flags: ['low_score', 'price_mismatch'] });

const caseStudyRaw = {
  generated_at: '2027-06-15T09:00:00Z', customer_name: 'Acme HVAC',
  pilot: { status: 'active', started_on: '2027-05-25', ended_on: null, weeks_elapsed: 3, live_days: 21 },
  baseline: { weekly_calls: 40, missed_call_pct: 35, booking_rate_pct: 50, avg_job_value_cents: 40000, weekly_revenue_cents: 900000, source: 'self_reported' },
  live: { weekly_calls: 45.5, missed_call_pct: 20, booking_rate_pct: 75, avg_job_value_cents: 42000, weekly_revenue_cents: 1200000, avg_call_score: 81, total_calls: 136, recovered_cents: 250000, recovered_count: 5 },
  weekly: [{ week_index: 1, week_start: '2027-05-25', week_end: '2027-05-31', is_complete: true, total_calls: 20 }],
  consent: { scope: ['company_name', 'metrics'], granted_at: '2027-06-12T08:00:00Z', evidence: 'Email' },
};

beforeEach(() => {
  vi.clearAllMocks();
  window.scrollTo = vi.fn();
  api.listPilots.mockResolvedValue([toPilot(rawPilot())]);
  api.getPilotTrend.mockResolvedValue(weeks);
  api.getFlaggedCalls.mockResolvedValue([flaggedCall]);
  api.listPilotAudit.mockResolvedValue([{ id: 1, action: 'create', changes: null, created_at: '2027-05-25T09:00:00Z', actor_email: 'staff@vireek.com' }]);
  api.updatePilot.mockResolvedValue(undefined);
  api.createPilot.mockResolvedValue(undefined);
  api.deletePilot.mockResolvedValue(undefined);
  api.exportCaseStudy.mockResolvedValue(toCaseStudy(caseStudyRaw));
  searchTenants.mockResolvedValue([]);
});
afterEach(() => cleanup());

const openDetails = async () => {
  fireEvent.click(await screen.findByRole('button', { name: /trend, flags & export/i }));
  await screen.findByRole('heading', { name: 'Week by week' });
};

describe('PilotManagementPage: list', () => {
  it('shows the summary and baseline vs live for each pilot', async () => {
    render(<PilotManagementPage />);
    expect(await screen.findByRole('heading', { name: 'Acme HVAC' })).toBeInTheDocument();
    expect(screen.getByText('1 of 1')).toBeInTheDocument(); // active pilots
    const table = screen.getByRole('table', { name: /baseline versus live metrics for acme hvac/i });
    const missed = within(table).getByRole('row', { name: /missed calls/i });
    expect(missed).toHaveTextContent('35.0%');
    expect(missed).toHaveTextContent('20.0%');
    expect(missed).toHaveTextContent('15.0 pts');
    expect(missed).toHaveTextContent('Improved');
    expect(screen.getAllByText('$2,500').length).toBeGreaterThan(0); // recovered revenue
  });

  it('shows a loading skeleton first, then the data', async () => {
    let resolve!: (v: unknown) => void;
    api.listPilots.mockReturnValue(new Promise((r) => { resolve = r; }));
    render(<PilotManagementPage />);
    expect(screen.queryByRole('heading', { name: 'Acme HVAC' })).not.toBeInTheDocument();
    resolve([toPilot(rawPilot())]);
    expect(await screen.findByRole('heading', { name: 'Acme HVAC' })).toBeInTheDocument();
  });

  it('shows an empty state and opens the create form from it', async () => {
    api.listPilots.mockResolvedValue([]);
    render(<PilotManagementPage />);
    expect(await screen.findByText('No pilots yet')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: /new pilot/i })[1]);
    expect(await screen.findByLabelText(/customer account/i)).toBeInTheDocument();
  });

  it('shows an error state and retries', async () => {
    api.listPilots.mockRejectedValueOnce(new Error('Could not load pilots.'));
    render(<PilotManagementPage />);
    expect(await screen.findByText('Could not load pilots.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByRole('heading', { name: 'Acme HVAC' })).toBeInTheDocument();
    expect(api.listPilots).toHaveBeenCalledTimes(2);
  });

  it('explains a pilot with no baseline and one that has not started', async () => {
    api.listPilots.mockResolvedValue([toPilot(rawPilot({
      status: 'onboarding', live_days: 0, weeks_elapsed: 0, baseline_weekly_calls: null, baseline_missed_call_pct: null, baseline_booking_rate_pct: null,
      baseline_avg_job_value_cents: null, baseline_weekly_revenue_cents: null, live_weekly_calls: null, live_missed_call_pct: null, live_booking_rate_pct: null,
      live_avg_job_value_cents: null, live_weekly_revenue_cents: null, live_avg_call_score: null, total_calls: 0, flagged_calls: 0, recovered_cents: 0, recovered_count: 0,
    }))]);
    render(<PilotManagementPage />);
    expect(await screen.findByText(/has not started yet/i)).toBeInTheDocument();
    expect(screen.getByText(/No baseline recorded/i)).toBeInTheDocument();
    expect(screen.getByText('No scored calls')).toBeInTheDocument();
  });

  it('filters by search and status', async () => {
    api.listPilots.mockResolvedValue([toPilot(rawPilot()), toPilot(rawPilot({ id: 'p2', tenant_id: 't2', company_name: 'Beta Plumbing', tenant_email: 'b@x.com', status: 'completed', ended_on: '2027-06-10' }))]);
    render(<PilotManagementPage />);
    await screen.findByRole('heading', { name: 'Acme HVAC' });
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'beta' } });
    expect(screen.queryByRole('heading', { name: 'Acme HVAC' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Beta Plumbing' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'active' } });
    expect(await screen.findByText('No pilots match')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /clear filters/i }));
    expect(await screen.findByRole('heading', { name: 'Acme HVAC' })).toBeInTheDocument();
  });
});

describe('PilotManagementPage: details', () => {
  it('shows the week-by-week trend, with in-progress and no-data weeks handled', async () => {
    render(<PilotManagementPage />);
    await openDetails();
    const table = await screen.findByRole('table', { name: /weekly calls, booking rate/i });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent('20.0%'); // missed
    expect(rows[1]).toHaveTextContent('70.0%'); // booking
    expect(rows[2]).toHaveTextContent('in progress');
    expect(rows[2]).toHaveTextContent('—'); // no calls: dash, not 0%
  });

  it('lists flagged calls without any caller details', async () => {
    render(<PilotManagementPage />);
    await openDetails();
    const table = await screen.findByRole('table', { name: /flagged calls/i });
    expect(within(table).getByText('Low call score')).toBeInTheDocument();
    expect(within(table).getByText('Price mismatch')).toBeInTheDocument();
    expect(within(table).getByText('abcdef12')).toBeInTheDocument();
    expect(screen.getByText(/deliberately not shown/i)).toBeInTheDocument();
  });

  it('shows an empty state when nothing is flagged', async () => {
    api.getFlaggedCalls.mockResolvedValue([]);
    render(<PilotManagementPage />);
    await openDetails();
    expect(await screen.findByText('No flagged calls')).toBeInTheDocument();
  });

  it('keeps export disabled, with the reason, until consent is recorded', async () => {
    render(<PilotManagementPage />);
    await openDetails();
    expect(screen.getByRole('button', { name: /export case study/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /weekly data/i })).toBeDisabled();
    expect(screen.getByText(/Record the customer’s consent/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /export case study/i }));
    expect(api.exportCaseStudy).not.toHaveBeenCalled();
  });

  it('refuses to save a grant without scope and evidence', async () => {
    render(<PilotManagementPage />);
    await openDetails();
    fireEvent.change(screen.getByLabelText('Consent status'), { target: { value: 'granted' } });
    fireEvent.click(screen.getByRole('button', { name: /save consent/i }));
    expect(await screen.findByText('Choose what the customer agreed to.')).toBeInTheDocument();
    expect(screen.getByText(/Say where the written consent is/i)).toBeInTheDocument();
    expect(api.updatePilot).not.toHaveBeenCalled();
  });

  it('saves a complete consent grant', async () => {
    render(<PilotManagementPage />);
    await openDetails();
    fireEvent.change(screen.getByLabelText('Consent status'), { target: { value: 'granted' } });
    fireEvent.click(screen.getByLabelText('Share metrics'));
    fireEvent.change(screen.getByLabelText('Evidence'), { target: { value: '  Email from owner  ' } });
    fireEvent.click(screen.getByRole('button', { name: /save consent/i }));
    await waitFor(() => expect(api.updatePilot).toHaveBeenCalledWith('p1', { consent_status: 'granted', consent_scope: ['metrics'], consent_evidence: 'Email from owner' }));
    expect(toast).toHaveBeenCalledWith('Consent saved.', 'success');
  });

  it('keeps the save button off until something changed', async () => {
    render(<PilotManagementPage />);
    await openDetails();
    expect(screen.getByRole('button', { name: /save consent/i })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Consent status'), { target: { value: 'requested' } });
    expect(screen.getByRole('button', { name: /save consent/i })).toBeEnabled();
  });

  it('exports the case study when consent is granted: markdown download', async () => {
    api.listPilots.mockResolvedValue([toPilot(rawPilot({ consent_status: 'granted', consent_scope: ['company_name', 'metrics'], consent_evidence: 'Email', consent_granted_at: '2027-06-12T08:00:00Z' }))]);
    render(<PilotManagementPage />);
    await openDetails();
    expect(screen.getByText(/includes the company name/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /export case study/i }));
    await waitFor(() => expect(api.exportCaseStudy).toHaveBeenCalledWith('p1', 'markdown'));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    const [filename, content, mime] = download.mock.calls[0];
    expect(filename).toBe('case-study-acme-hvac-2027-06-15.md');
    expect(content).toContain('# Acme HVAC: pilot results');
    expect(mime).toBe('text/markdown');
    expect(toast).toHaveBeenCalledWith('Export downloaded.', 'success');
  });

  it('exports weekly CSV through the shared CSV helper', async () => {
    api.listPilots.mockResolvedValue([toPilot(rawPilot({ consent_status: 'granted', consent_scope: ['metrics'], consent_evidence: 'Email' }))]);
    render(<PilotManagementPage />);
    await openDetails();
    expect(screen.getByText(/company name is left out/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /weekly data/i }));
    await waitFor(() => expect(api.exportCaseStudy).toHaveBeenCalledWith('p1', 'csv'));
    await waitFor(() => expect(exportToCsv).toHaveBeenCalledTimes(1));
    expect(exportToCsv.mock.calls[0][2]).toBe('case-study-acme-hvac-2027-06-15.csv');
    expect(download).not.toHaveBeenCalled();
  });

  it('surfaces a server-side consent refusal and refreshes the list', async () => {
    api.listPilots.mockResolvedValue([toPilot(rawPilot({ consent_status: 'granted', consent_scope: ['metrics'], consent_evidence: 'Email' }))]);
    api.exportCaseStudy.mockRejectedValue(new Error('Export needs the customer’s recorded consent to share metrics.'));
    render(<PilotManagementPage />);
    await openDetails();
    const before = api.listPilots.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: /export case study/i }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Export needs the customer’s recorded consent to share metrics.', 'error'));
    expect(download).not.toHaveBeenCalled();
    await waitFor(() => expect(api.listPilots.mock.calls.length).toBeGreaterThan(before));
    expect(screen.getByRole('button', { name: /export case study/i })).toBeEnabled(); // not stuck in "Exporting…"
  });

  it('shows the audit history', async () => {
    render(<PilotManagementPage />);
    await openDetails();
    expect(await screen.findByText('Pilot created')).toBeInTheDocument();
    expect(screen.getByText(/staff@vireek.com/)).toBeInTheDocument();
  });

  it('shows an inline error if the trend cannot load', async () => {
    api.getPilotTrend.mockRejectedValue(new Error('Could not load the weekly trend.'));
    render(<PilotManagementPage />);
    await openDetails();
    expect(await screen.findByText('Could not load the weekly trend.')).toBeInTheDocument();
  });
});

describe('PilotManagementPage: create, edit, delete', () => {
  it('validates before creating', async () => {
    render(<PilotManagementPage />);
    await screen.findByRole('heading', { name: 'Acme HVAC' });
    fireEvent.click(screen.getByRole('button', { name: /new pilot/i }));
    fireEvent.click(await screen.findByRole('button', { name: /create pilot/i }));
    expect(await screen.findByText('Choose the customer account for this pilot.')).toBeInTheDocument();
    expect(screen.getByText('Enter a valid start date.')).toBeInTheDocument();
    expect(api.createPilot).not.toHaveBeenCalled();
  });

  it('finds a customer, converts dollars to cents and creates the pilot', async () => {
    searchTenants.mockResolvedValue([{ id: 't9', email: 'new@x.com', company_name: 'New Co', full_name: null, plan: 'starter' }]);
    render(<PilotManagementPage />);
    await screen.findByRole('heading', { name: 'Acme HVAC' });
    fireEvent.click(screen.getByRole('button', { name: /new pilot/i }));
    fireEvent.change(await screen.findByLabelText(/customer account/i), { target: { value: 'new' } });
    fireEvent.click(await screen.findByRole('button', { name: /new co/i }));
    fireEvent.change(screen.getByLabelText(/pilot start date/i), { target: { value: '2027-06-20' } });
    fireEvent.change(screen.getByLabelText(/average job value/i), { target: { value: '$450.50' } });
    fireEvent.change(screen.getByLabelText(/missed calls \(%\)/i), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: /create pilot/i }));
    await waitFor(() => expect(api.createPilot).toHaveBeenCalledTimes(1));
    expect(api.createPilot.mock.calls[0][0]).toMatchObject({ tenant_id: 't9', started_on: '2027-06-20', baseline_avg_job_value_cents: 45050, baseline_missed_call_pct: 30, status: 'onboarding' });
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Pilot created.', 'success'));
  });

  it('shows the server message when a customer already has an open pilot', async () => {
    searchTenants.mockResolvedValue([{ id: 't9', email: 'new@x.com', company_name: 'New Co', full_name: null, plan: null }]);
    api.createPilot.mockRejectedValue(new Error('This customer already has an open pilot. Complete it before starting another.'));
    render(<PilotManagementPage />);
    await screen.findByRole('heading', { name: 'Acme HVAC' });
    fireEvent.click(screen.getByRole('button', { name: /new pilot/i }));
    fireEvent.change(await screen.findByLabelText(/customer account/i), { target: { value: 'new' } });
    fireEvent.click(await screen.findByRole('button', { name: /new co/i }));
    fireEvent.change(screen.getByLabelText(/pilot start date/i), { target: { value: '2027-06-20' } });
    fireEvent.click(screen.getByRole('button', { name: /create pilot/i }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringMatching(/already has an open pilot/), 'error'));
    expect(screen.getByRole('button', { name: /create pilot/i })).toBeEnabled();
  });

  it('edits a pilot without ever sending the tenant', async () => {
    render(<PilotManagementPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    expect(await screen.findByDisplayValue('2027-05-25')).toBeInTheDocument();
    expect(screen.queryByLabelText(/customer account/i)).not.toBeInTheDocument();
    // Two "Status" selects exist; the form is rendered above the list filter.
    fireEvent.change(screen.getAllByLabelText('Status')[0], { target: { value: 'completed' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(api.updatePilot).toHaveBeenCalledTimes(1));
    const [id, patch] = api.updatePilot.mock.calls[0];
    expect(id).toBe('p1');
    expect(patch.status).toBe('completed');
    expect('tenant_id' in patch).toBe(false);
  });

  it('deletes only after confirmation', async () => {
    render(<PilotManagementPage />);
    fireEvent.click(await screen.findByRole('button', { name: /delete pilot for acme hvac/i }));
    expect(api.deletePilot).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: /^delete pilot$/i }));
    await waitFor(() => expect(api.deletePilot).toHaveBeenCalledWith('p1'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Pilot for Acme HVAC deleted.', 'success'));
  });

  it('does not delete when cancelled', async () => {
    render(<PilotManagementPage />);
    fireEvent.click(await screen.findByRole('button', { name: /delete pilot for acme hvac/i }));
    fireEvent.click((await screen.findAllByRole('button', { name: /cancel/i }))[0]);
    expect(api.deletePilot).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('button', { name: /^delete pilot$/i })).not.toBeInTheDocument());
  });
});
