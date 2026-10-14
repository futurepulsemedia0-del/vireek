import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/lib/supabase', () => ({ supabase: { rpc: vi.fn() } }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'user-1' }, session: {}, loading: false }) }));

import { supabase } from '@/lib/supabase';
import { TechEarningsPage } from './TechEarningsPage';

const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;

const SUMMARY = {
  employee: { id: 'e1', full_name: 'Tech One', pay_type: 'hourly', pay_schedule: 'biweekly', commission_rate_percent: 0, employment_type: 'w2' },
  current: {
    since: '2026-09-15', regular_hours: 14, overtime_hours: 2, pending_timesheets: 1, regular_pay_cents: 42000, overtime_pay_cents: 9000,
    salary_pay_cents: 0, commission_cents: 14000, commission_count: 3, tips_cents: 2500,
  },
  periods: [
    {
      pay_run_id: 'r1', item_id: 'i1', pay_period_start: '2026-09-01', pay_period_end: '2026-09-14', pay_date: '2026-09-19', status: 'paid',
      regular_hours: 80, overtime_hours: 4, regular_pay_cents: 240000, overtime_pay_cents: 18000, salary_pay_cents: 0, commission_cents: 12000,
      bonus_cents: 0, gross_pay_cents: 270000, tax_withholding_cents: 54000, other_deductions_cents: 0, net_pay_cents: 216000,
      paid_at: '2026-09-19T00:00:00Z', tips_cents: 3500,
    },
  ],
  generated_at: new Date().toISOString(),
};

const DETAIL = {
  commissions: [{ id: 'c1', job_id: 'j1', customer_name: 'Smith residence', service_type: null, basis_amount_cents: 80000, commission_rate_percent: 10, commission_cents: 8000, status: 'approved', created_at: '2026-10-02T12:00:00Z' }],
  timesheets: [{ id: 't1', work_date: '2026-10-01', regular_hours: 8, overtime_hours: 2, status: 'approved', customer_name: null }],
  tips: [{ id: 'p1', amount_cents: 2500, source: 'cash', note: null, received_at: '2026-10-02T12:00:00Z', customer_name: 'Smith residence' }],
};

function mockServer(summary: unknown = SUMMARY) {
  rpc.mockImplementation(async (name: string) => {
    if (name === 'get_my_earnings') return { data: summary, error: null };
    return { data: DETAIL, error: null };
  });
}

const renderPage = () => render(<MemoryRouter><TechEarningsPage /></MemoryRouter>);

afterEach(cleanup);

beforeEach(() => {
  window.localStorage.clear();
  rpc.mockReset();
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});

describe('TechEarningsPage', () => {
  it('shows loading, then the current estimate with wages, commission and tips', async () => {
    mockServer();
    renderPage();
    expect(screen.getByRole('status', { name: /loading earnings/i })).toBeInTheDocument();

    const card = await screen.findByRole('region', { name: 'Current period' });
    expect(within(card).getByText('$675.00')).toBeInTheDocument(); // 420 + 90 + 140 + 25
    expect(within(card).getByText('Estimate')).toBeInTheDocument();
    expect(within(card).getByText(/Regular pay · 14 h/)).toBeInTheDocument();
    expect(within(card).getByText('$140.00')).toBeInTheDocument();
    expect(within(card).getByText('$25.00')).toBeInTheDocument();
    expect(within(card).getByText(/1 timesheet is waiting for approval/)).toBeInTheDocument();
    expect(screen.getByText('Hourly · paid biweekly')).toBeInTheDocument();
  });

  it('lists the commission, tip and hour lines behind the current period', async () => {
    mockServer();
    renderPage();
    expect(await screen.findByText(/\$800\.00 × 10%/)).toBeInTheDocument();
    expect(screen.getByText(/Cash/)).toBeInTheDocument();
    expect(screen.getByText(/Oct 1/)).toBeInTheDocument();
    expect(rpc).toHaveBeenCalledWith('get_my_earnings_detail', { p_item_id: null });
    expect(screen.getAllByText('$80.00').length).toBeGreaterThan(0);
  });

  it('switches to a past pay period with gross, deductions, net, tips and take-home', async () => {
    mockServer();
    renderPage();
    await screen.findByRole('region', { name: 'Current period' });

    fireEvent.click(screen.getByRole('button', { name: /Period ending Sep 14: \$2,735\.00/ }));

    const card = await screen.findByRole('region', { name: 'Pay period' });
    expect(within(card).getByText('Paid Sep 19')).toBeInTheDocument();
    expect(within(card).getByText('$2,735.00')).toBeInTheDocument(); // gross 2700 + tips 35
    expect(within(card).getByText('Gross pay').nextSibling).toHaveTextContent('$2,700.00');
    expect(within(card).getByText('Net pay').nextSibling).toHaveTextContent('$2,160.00');
    expect(within(card).getByText('Take-home').nextSibling).toHaveTextContent('$2,195.00');
    expect(within(card).getByText('Tax withheld (estimate)').nextSibling).toHaveTextContent('−$540.00');
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('get_my_earnings_detail', { p_item_id: 'i1' }));
  });

  it('shows empty detail sections when nothing was earned', async () => {
    rpc.mockImplementation(async (name: string) =>
      name === 'get_my_earnings'
        ? { data: { ...SUMMARY, periods: [], current: { ...SUMMARY.current, commission_cents: 0, commission_count: 0, tips_cents: 0, regular_pay_cents: 0, overtime_pay_cents: 0, regular_hours: 0, overtime_hours: 0, pending_timesheets: 0 } }, error: null }
        : { data: { commissions: [], timesheets: [], tips: [] }, error: null },
    );
    renderPage();
    expect(await screen.findByText('No commission in this period.')).toBeInTheDocument();
    expect(screen.getByText(/No pay periods yet/)).toBeInTheDocument();
  });

  it('shows an error with retry when the details fail', async () => {
    rpc.mockImplementation(async (name: string) =>
      name === 'get_my_earnings' ? { data: SUMMARY, error: null } : { data: null, error: { message: 'boom' } },
    );
    renderPage();
    expect(await screen.findByText(/Couldn't load the details/)).toBeInTheDocument();
    rpc.mockImplementation(async (name: string) => (name === 'get_my_earnings' ? { data: SUMMARY, error: null } : { data: DETAIL, error: null }));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/\$800\.00 × 10%/)).toBeInTheDocument();
  });

  it('works offline from the saved copy and says so', async () => {
    window.localStorage.setItem('vk:tech-earnings:v1:user-1', JSON.stringify(SUMMARY));
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    rpc.mockResolvedValue({ data: null, error: { message: 'Failed to fetch' } });
    renderPage();
    expect(await screen.findByText(/You're offline\. Showing what was saved/)).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Current period' })).getByText('$675.00')).toBeInTheDocument();
    expect(await screen.findByText(/details need a connection/i)).toBeInTheDocument();
  });

  it('explains when there is no pay profile, and when the user is not a technician', async () => {
    rpc.mockResolvedValue({ data: { error: 'no_pay_profile' }, error: null });
    const first = renderPage();
    expect(await screen.findByText("Your pay profile isn't set up yet")).toBeInTheDocument();
    first.unmount();

    window.localStorage.clear();
    rpc.mockResolvedValue({ data: { error: 'not_a_technician' }, error: null });
    renderPage();
    expect(await screen.findByText('This page is for technicians')).toBeInTheDocument();
  });

  it('shows an error with retry when nothing is saved and the server fails', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    renderPage();
    expect(await screen.findByText("Couldn't load your earnings")).toBeInTheDocument();
    mockServer();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('region', { name: 'Current period' })).toBeInTheDocument();
  });
});
