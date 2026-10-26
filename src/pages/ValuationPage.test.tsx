import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QUESTIONS, type Answers, type ValuationBundle, type ValuationProfile } from '@/lib/valuation';

const mocks = vi.hoisted(() => ({
  auth: {} as Record<string, unknown>,
  toast: vi.fn(),
  fetchValuationBundle: vi.fn(),
  saveNumbers: vi.fn(),
  saveAnswers: vi.fn(),
  saveDataRoomItem: vi.fn(),
  saveSnapshot: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => mocks.auth }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/components/DashboardNav', () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/lib/valuation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/valuation')>();
  return {
    ...actual,
    fetchValuationBundle: mocks.fetchValuationBundle,
    saveNumbers: mocks.saveNumbers,
    saveAnswers: mocks.saveAnswers,
    saveDataRoomItem: mocks.saveDataRoomItem,
    saveSnapshot: mocks.saveSnapshot,
  };
});

import { ValuationPage } from './ValuationPage';

const answers = (value: 0 | 1 | 2 | 3): Answers => Object.fromEntries(QUESTIONS.map((q) => [q.key, value])) as Answers;

function profile(over: Partial<ValuationProfile> = {}): ValuationProfile {
  return {
    id: 'p1',
    annual_revenue: 2_000_000,
    owner_earnings: 400_000,
    revenue_growth_pct: 8,
    recurring_revenue_pct: 20,
    top_customer_pct: 10,
    cash_on_hand: 50_000,
    total_debt: 100_000,
    multiple_low: 2,
    multiple_high: 3.5,
    answers: answers(2),
    target_exit_date: null,
    updated_at: '2026-10-01T00:00:00Z',
    ...over,
  };
}

const FULL: ValuationBundle = { profile: profile(), items: [], snapshots: [] };
const EMPTY: ValuationBundle = { profile: null, items: [], snapshots: [] };

function setAuth(isOwner = true) {
  mocks.auth = { isOwner, profile: { id: 'owner-1' }, teamMember: isOwner ? null : { account_owner_id: 'owner-1' }, permissions: {} };
}

afterEach(cleanup);

beforeEach(() => {
  setAuth(true);
  mocks.toast.mockReset();
  mocks.fetchValuationBundle.mockReset();
  mocks.saveNumbers.mockReset();
  mocks.saveAnswers.mockReset();
  mocks.saveDataRoomItem.mockReset();
  mocks.saveSnapshot.mockReset();
});

describe('ValuationPage', () => {
  it('shows a loading state, then the score and the value range', async () => {
    mocks.fetchValuationBundle.mockResolvedValue(FULL);
    render(<ValuationPage />);
    expect(screen.getByRole('status', { name: /loading valuation/i })).toBeInTheDocument();

    expect(await screen.findByRole('img', { name: /exit-readiness score: \d+ out of 100/i })).toBeInTheDocument();
    expect(screen.getByText('Estimated business value')).toBeInTheDocument();
    expect(screen.getByText(/this is a planning estimate/i)).toBeInTheDocument();
    expect(mocks.fetchValuationBundle).toHaveBeenCalledWith('owner-1');
  });

  it('guides a first-time owner and opens the numbers form', async () => {
    mocks.fetchValuationBundle.mockResolvedValue(EMPTY);
    render(<ValuationPage />);
    expect(await screen.findByText('Find out what your business is worth')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Enter your numbers' }));
    expect(screen.getByRole('form', { name: /business numbers/i })).toBeInTheDocument();
  });

  it('asks for owner earnings when they are missing instead of inventing a value', async () => {
    mocks.fetchValuationBundle.mockResolvedValue({ ...FULL, profile: profile({ owner_earnings: null }) });
    render(<ValuationPage />);
    expect(await screen.findByText(/enter your annual owner earnings/i)).toBeInTheDocument();
  });

  it('shows an error with retry', async () => {
    mocks.fetchValuationBundle.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(FULL);
    render(<ValuationPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('Estimated business value')).toBeInTheDocument();
    expect(mocks.fetchValuationBundle).toHaveBeenCalledTimes(2);
  });

  it('blocks everyone except the owner without calling the database', async () => {
    setAuth(false);
    render(<ValuationPage />);
    expect(await screen.findByText('Owner access only')).toBeInTheDocument();
    expect(mocks.fetchValuationBundle).not.toHaveBeenCalled();
  });

  it('validates the numbers form before saving, then saves a valid one', async () => {
    mocks.fetchValuationBundle.mockResolvedValue(EMPTY);
    mocks.saveNumbers.mockResolvedValue(profile());
    render(<ValuationPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Enter your numbers' }));

    const earnings = screen.getByLabelText(/annual owner earnings/i);
    fireEvent.change(earnings, { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: /save numbers/i }));
    expect(await screen.findByText('Owner earnings must be a number.')).toBeInTheDocument();
    expect(mocks.saveNumbers).not.toHaveBeenCalled();

    fireEvent.change(earnings, { target: { value: '400000' } });
    fireEvent.click(screen.getByRole('button', { name: /save numbers/i }));
    await waitFor(() => expect(mocks.saveNumbers).toHaveBeenCalledWith('owner-1', expect.objectContaining({ owner_earnings: '400000' })));
    expect(mocks.toast).toHaveBeenCalledWith('Numbers saved.', 'success');
  });

  it('saves questionnaire answers', async () => {
    mocks.fetchValuationBundle.mockResolvedValue(EMPTY);
    mocks.saveAnswers.mockResolvedValue(profile({ answers: { fin_books: 3 } }));
    render(<ValuationPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start the questionnaire' }));

    expect(screen.getByRole('button', { name: /save answers/i })).toBeDisabled();
    fireEvent.click(screen.getAllByRole('radio', { name: 'Fully' })[0]);
    fireEvent.click(screen.getByRole('button', { name: /save answers/i }));
    await waitFor(() => expect(mocks.saveAnswers).toHaveBeenCalledWith('owner-1', { fin_books: 3 }));
    expect(mocks.toast).toHaveBeenCalledWith('Answers saved.', 'success');
  });

  it('updates a data-room item and reports a failed save', async () => {
    mocks.fetchValuationBundle.mockResolvedValue(FULL);
    mocks.saveDataRoomItem
      .mockResolvedValueOnce({ item_key: 'fin_pl_3y', status: 'ready', note: null, updated_at: '2026-10-02T00:00:00Z' })
      .mockRejectedValueOnce(new Error('network down'));
    render(<ValuationPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Data room' }));

    const select = screen.getByLabelText('Status for Profit and loss statements, last 3 years');
    fireEvent.change(select, { target: { value: 'ready' } });
    await waitFor(() => expect(mocks.saveDataRoomItem).toHaveBeenCalledWith('owner-1', 'fin_pl_3y', 'ready', null));
    await waitFor(() => expect(select).toHaveValue('ready'));

    fireEvent.change(screen.getByLabelText('Status for Balance sheets, last 3 years'), { target: { value: 'in_progress' } });
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('network down', 'error'));
  });

  it('saves a snapshot and lists it in history', async () => {
    mocks.fetchValuationBundle.mockResolvedValue(FULL);
    mocks.saveSnapshot.mockResolvedValue({
      id: 's1', label: 'Baseline', readiness_score: 44, assessment_score: 67, data_room_score: 0,
      value_low: 900000, value_mid: 1000000, value_high: 1100000, owner_earnings: 400000, multiple_mid: 2.5,
      dimension_scores: {}, created_at: '2026-10-26T00:00:00Z',
    });
    render(<ValuationPage />);
    await screen.findByText('Estimated business value');

    fireEvent.change(screen.getByLabelText('Name (optional)'), { target: { value: 'Baseline' } });
    fireEvent.click(screen.getByRole('button', { name: /^save snapshot$/i }));
    await waitFor(() => expect(mocks.saveSnapshot).toHaveBeenCalledWith('owner-1', expect.objectContaining({ label: 'Baseline' })));
    expect(mocks.toast).toHaveBeenCalledWith('Snapshot saved to your history.', 'success');

    fireEvent.click(screen.getByRole('tab', { name: 'History' }));
    expect(screen.getByRole('list', { name: /saved snapshots/i })).toBeInTheDocument();
    expect(screen.getByText('Baseline')).toBeInTheDocument();
  });

  it('shows an empty history with a way back', async () => {
    mocks.fetchValuationBundle.mockResolvedValue(FULL);
    render(<ValuationPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'History' }));
    expect(screen.getByText('No snapshots yet')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Go to overview' }));
    expect(await screen.findByText('Estimated business value')).toBeInTheDocument();
  });
});
