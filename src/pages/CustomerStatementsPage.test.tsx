import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CustomerStatementsPage } from './CustomerStatementsPage';
import type { Statement, StatementAccount } from '@/lib/statements';

const mocks = vi.hoisted(() => ({
  auth: {} as Record<string, unknown>,
  toast: vi.fn(),
  fetchAccounts: vi.fn(),
  fetchSchedules: vi.fn(),
  fetchSends: vi.fn(),
  fetchStatement: vi.fn(),
  sendStatementNow: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => mocks.auth }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/components/DashboardNav', () => ({ DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/statements', async (orig) => ({
  ...(await orig<typeof import('@/lib/statements')>()),
  fetchAccounts: mocks.fetchAccounts,
  fetchSchedules: mocks.fetchSchedules,
  fetchSends: mocks.fetchSends,
  fetchStatement: mocks.fetchStatement,
  sendStatementNow: mocks.sendStatementNow,
  fetchCustomerNames: vi.fn().mockResolvedValue({}),
  searchCustomers: vi.fn().mockResolvedValue([]),
}));

const account: StatementAccount = {
  customer_id: 'c1', name: 'Parent Corp', email: 'ap@parent.com', phone: null, customer_type: 'commercial', child_count: 1,
  invoice_count: 2, balance_cents: 125_000, overdue_cents: 75_000, oldest_due: '2027-01-10', last_sent_at: null,
};

const statement: Statement = {
  customer: { id: 'c1', name: 'Parent Corp', email: 'ap@parent.com', phone: null, address: null },
  period_from: '2027-01-01', period_to: '2027-01-31', consolidated: true,
  members: [{ id: 'c1', name: 'Parent Corp' }, { id: 'c2', name: 'Parent Site B' }],
  opening_cents: 110_000, charges_cents: 50_000, payments_cents: 40_000, refunds_cents: 5_000, closing_cents: 125_000,
  lines: [], open_invoices: [], aging: { current: 50_000, d1_30: 0, d31_60: 75_000, d61_90: 0, d90_plus: 0 },
};

function setAuth(over: Record<string, unknown> = {}) {
  mocks.auth = { user: { id: 'u1' }, isOwner: true, permissions: { can_view_billing: true }, profile: { id: 'u1' }, ...over };
}

afterEach(() => cleanup());

beforeEach(() => {
  vi.clearAllMocks();
  setAuth();
  mocks.fetchAccounts.mockResolvedValue([account]);
  mocks.fetchSchedules.mockResolvedValue([]);
  mocks.fetchSends.mockResolvedValue([]);
  mocks.fetchStatement.mockResolvedValue(statement);
  mocks.sendStatementNow.mockResolvedValue({ ok: true, recipient: 'ap@parent.com' });
});

describe('CustomerStatementsPage', () => {
  it('blocks team members without billing permission', () => {
    setAuth({ isOwner: false, permissions: { can_view_billing: false } });
    render(<CustomerStatementsPage />);
    expect(screen.getByText(/don't have access/i)).toBeTruthy();
    expect(mocks.fetchAccounts).not.toHaveBeenCalled();
  });

  it('lists accounts with consolidated and overdue badges', async () => {
    render(<CustomerStatementsPage />);
    expect(await screen.findByText('Parent Corp')).toBeTruthy();
    expect(screen.getByText(/1 linked/)).toBeTruthy();
    expect(screen.getByText(/Overdue \$750\.00/)).toBeTruthy();
  });

  it('shows an error state with retry when loading fails', async () => {
    mocks.fetchAccounts.mockRejectedValueOnce(new Error('boom'));
    render(<CustomerStatementsPage />);
    expect(await screen.findByText("Couldn't load statements")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /try again|retry/i }));
    expect(await screen.findByText('Parent Corp')).toBeTruthy();
  });

  it('shows the empty state when there are no customers', async () => {
    mocks.fetchAccounts.mockResolvedValue([]);
    render(<CustomerStatementsPage />);
    expect(await screen.findByText('No customers yet')).toBeTruthy();
  });

  it('opens a statement and sends it to the customer', async () => {
    render(<CustomerStatementsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /open statement for parent corp/i }));
    expect(await screen.findByText('Balance due')).toBeTruthy();
    expect(mocks.fetchStatement).toHaveBeenCalledWith('c1', expect.any(String), expect.any(String), true);
    fireEvent.click(screen.getByRole('button', { name: /send statement/i }));
    await waitFor(() => expect(mocks.sendStatementNow).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'c1', consolidate: true })));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('ap@parent.com'), 'success'));
  });

  it('shows the schedules empty state', async () => {
    render(<CustomerStatementsPage />);
    fireEvent.click(await screen.findByRole('tab', { name: /schedules/i }));
    expect(await screen.findByText('No schedules yet')).toBeTruthy();
  });
});
