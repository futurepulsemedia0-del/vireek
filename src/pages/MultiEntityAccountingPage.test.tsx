import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MultiEntityAccountingPage } from './MultiEntityAccountingPage';
import type { AccountingEntity, BalanceRow, IcTransaction } from '@/lib/multiEntity';

const mocks = vi.hoisted(() => ({
  auth: {} as Record<string, unknown>,
  toast: vi.fn(),
  fetchEntities: vi.fn(),
  fetchIntercompany: vi.fn(),
  fetchBalances: vi.fn(),
  setupMultiEntity: vi.fn(),
  postIntercompany: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => mocks.auth }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/components/DashboardNav', () => ({ DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/accounting', () => ({ fetchChartOfAccounts: vi.fn().mockResolvedValue([]) }));
vi.mock('@/lib/multiEntityApi', () => ({
  fetchEntities: mocks.fetchEntities,
  fetchIntercompany: mocks.fetchIntercompany,
  fetchBalances: mocks.fetchBalances,
  setupMultiEntity: mocks.setupMultiEntity,
  postIntercompany: mocks.postIntercompany,
  saveEntity: vi.fn(),
  settleIntercompany: vi.fn(),
  voidIntercompany: vi.fn(),
  postEntityJournal: vi.fn(),
}));

const entity = (id: string, over: Partial<AccountingEntity> = {}): AccountingEntity => ({
  id, code: id.toUpperCase(), name: `Entity ${id}`, legal_name: null, entity_type: 'operating', country: null,
  ownership_pct: 100, consolidation_method: 'full', is_primary: false, is_active: true, ...over,
});
const entities = [entity('a', { is_primary: true, name: 'Main Co' }), entity('b', { name: 'Texas LLC', ownership_pct: 80 })];

const ACC = {
  cash: { account_id: 'a-cash', code: '1000', name: 'Cash', type: 'asset', normal_balance: 'debit', ic_role: null },
  rec: { account_id: 'a-rec', code: '1900', name: 'Intercompany Receivable', type: 'asset', normal_balance: 'debit', ic_role: 'ic_receivable' },
  pay: { account_id: 'a-pay', code: '2900', name: 'Intercompany Payable', type: 'liability', normal_balance: 'credit', ic_role: 'ic_payable' },
  eq: { account_id: 'a-eq', code: '3000', name: 'Equity', type: 'equity', normal_balance: 'credit', ic_role: null },
  rev: { account_id: 'a-rev', code: '4950', name: 'Intercompany Revenue', type: 'revenue', normal_balance: 'credit', ic_role: 'ic_revenue' },
  exp: { account_id: 'a-exp', code: '6950', name: 'Intercompany Expense', type: 'expense', normal_balance: 'debit', ic_role: 'ic_expense' },
} as const;
const row = (e: string, k: keyof typeof ACC, d: number, c: number) =>
  ({ entity_id: e, ...ACC[k], cum_debit_cents: d, cum_credit_cents: c, period_debit_cents: d, period_credit_cents: c }) as BalanceRow;
const balances = [
  row('a', 'cash', 10_400_000, 0), row('a', 'rec', 1_000_000, 400_000), row('a', 'eq', 0, 10_000_000), row('a', 'rev', 0, 1_000_000),
  row('b', 'cash', 5_000_000, 400_000), row('b', 'exp', 1_000_000, 0), row('b', 'pay', 400_000, 1_000_000), row('b', 'eq', 0, 5_000_000),
];
const txn: IcTransaction = {
  id: 't1', txn_number: 'IC-202701-0001', txn_date: '2027-01-10', kind: 'service', from_entity_id: 'a', to_entity_id: 'b',
  amount_cents: 1_000_000, settled_cents: 400_000, status: 'partially_settled', description: 'Dispatch services', void_reason: null, created_at: '',
};

function setAuth(over: Record<string, unknown> = {}) {
  mocks.auth = { user: { id: 'u1' }, isOwner: true, permissions: { can_view_billing: true }, ...over };
}

afterEach(() => cleanup());
beforeEach(() => {
  vi.clearAllMocks();
  setAuth();
  mocks.fetchEntities.mockResolvedValue(entities);
  mocks.fetchIntercompany.mockResolvedValue([txn]);
  mocks.fetchBalances.mockResolvedValue(balances);
  mocks.setupMultiEntity.mockResolvedValue(undefined);
  mocks.postIntercompany.mockResolvedValue('new-id');
});

describe('MultiEntityAccountingPage', () => {
  it('blocks users without billing permission', async () => {
    setAuth({ isOwner: false, permissions: { can_view_billing: false } });
    render(<MultiEntityAccountingPage />);
    expect(await screen.findByText(/don't have access/i)).toBeInTheDocument();
    expect(mocks.fetchEntities).not.toHaveBeenCalled();
  });

  it('shows an error state with retry when loading fails', async () => {
    mocks.fetchEntities.mockRejectedValueOnce(new Error('boom'));
    render(<MultiEntityAccountingPage />);
    expect(await screen.findByText('boom')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /try again|retry/i }));
    await waitFor(() => expect(screen.getByRole('tab', { name: /Entities/ })).toBeInTheDocument());
  });

  it('lets the owner set up multi-entity accounting from the empty state', async () => {
    mocks.fetchEntities.mockResolvedValueOnce([]);
    render(<MultiEntityAccountingPage />);
    fireEvent.click(await screen.findByRole('button', { name: /set up now/i }));
    await waitFor(() => expect(mocks.setupMultiEntity).toHaveBeenCalledTimes(1));
  });

  it('tells non-owners to ask the owner when nothing is set up', async () => {
    setAuth({ isOwner: false });
    mocks.fetchEntities.mockResolvedValueOnce([]);
    render(<MultiEntityAccountingPage />);
    expect(await screen.findByText(/account owner needs to set up/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /set up now/i })).not.toBeInTheDocument();
  });

  it('renders consolidated totals with intercompany eliminated', async () => {
    render(<MultiEntityAccountingPage />);
    expect(await screen.findByText(/intercompany balances agree/i)).toBeInTheDocument();
    expect(screen.getAllByText('$150,000.00').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /export csv/i })).toBeInTheDocument();
    expect(mocks.fetchBalances).toHaveBeenCalledTimes(1);
  });

  it('warns when intercompany accounts disagree', async () => {
    mocks.fetchBalances.mockResolvedValue([
      ...balances.filter((r) => r.entity_id === 'a'),
      row('b', 'cash', 5_000_000, 400_000), row('b', 'exp', 900_000, 0), row('b', 'pay', 400_000, 900_000), row('b', 'eq', 0, 5_000_000),
    ]);
    render(<MultiEntityAccountingPage />);
    expect(await screen.findByText(/intercompany accounts do not agree/i)).toBeInTheDocument();
  });

  it('shows an empty state when the period has no activity', async () => {
    mocks.fetchBalances.mockResolvedValue([]);
    render(<MultiEntityAccountingPage />);
    expect(await screen.findByText(/no ledger activity/i)).toBeInTheDocument();
  });

  it('shows a report error with retry', async () => {
    mocks.fetchBalances.mockRejectedValueOnce(new Error('ledger offline'));
    render(<MultiEntityAccountingPage />);
    expect(await screen.findByText('ledger offline')).toBeInTheDocument();
  });

  it('posts an intercompany transaction from the dialog', async () => {
    render(<MultiEntityAccountingPage />);
    fireEvent.click(await screen.findByRole('tab', { name: /Intercompany/ }));
    expect(await screen.findByText('IC-202701-0001')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /new transaction/i }));
    fireEvent.change(await screen.findByLabelText('Received by'), { target: { value: 'b' } });
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '1,250.00' } });
    fireEvent.click(screen.getByRole('button', { name: /post transaction/i }));
    await waitFor(() => expect(mocks.postIntercompany).toHaveBeenCalledTimes(1));
    expect(mocks.postIntercompany).toHaveBeenCalledWith(expect.objectContaining({
      from_entity_id: 'a', to_entity_id: 'b', kind: 'service', amount_cents: 125_000, idempotency_key: expect.any(String),
    }));
  });

  it('keeps the dialog open and shows the server error when posting fails', async () => {
    mocks.postIntercompany.mockRejectedValueOnce(new Error('Accounting period for 2027-01-10 is closed'));
    render(<MultiEntityAccountingPage />);
    fireEvent.click(await screen.findByRole('tab', { name: /Intercompany/ }));
    fireEvent.click(await screen.findByRole('button', { name: /new transaction/i }));
    fireEvent.change(await screen.findByLabelText('Received by'), { target: { value: 'b' } });
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: /post transaction/i }));
    expect(await screen.findByText(/period for 2027-01-10 is closed/i)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('validates before posting', async () => {
    render(<MultiEntityAccountingPage />);
    fireEvent.click(await screen.findByRole('tab', { name: /Intercompany/ }));
    fireEvent.click(await screen.findByRole('button', { name: /new transaction/i }));
    fireEvent.click(await screen.findByRole('button', { name: /post transaction/i }));
    expect(await screen.findByText(/choose the receiving entity/i)).toBeInTheDocument();
    expect(mocks.postIntercompany).not.toHaveBeenCalled();
  });
});
