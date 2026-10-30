import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { InstantPayoutDialog } from './InstantPayoutDialog';
import { InstantPayoutError, type InstantPayoutEligibility } from '@/lib/instantPayouts';

const toast = vi.fn();
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast }) }));

const requestMock = vi.fn();
vi.mock('@/lib/instantPayouts', async () => {
  const actual = await vi.importActual<typeof import('@/lib/instantPayouts')>('@/lib/instantPayouts');
  return { ...actual, requestInstantPayout: (...args: unknown[]) => requestMock(...args) };
});

const eligibility: InstantPayoutEligibility = {
  eligible: true,
  reason: null,
  message: null,
  destination: { id: 'card_1', label: 'Visa debit •••• 4242' },
  availableCents: 50_500,
  maxPayoutCents: 50_000,
  pricing: { feeBps: 100, feeMinCents: 50, feeMaxCents: null, minPayoutCents: 100, maxPayoutCents: 999_900 },
  recent: [],
};

const payout = (over = {}) => ({
  id: 'p1', amount_cents: 50_000, fee_cents: 500, currency: 'usd', destination_label: 'Visa debit •••• 4242',
  status: 'in_transit', stripe_payout_id: 'po_1', failure_code: null, failure_message: null, arrival_date: null,
  completed_at: null, created_at: '2026-06-01T00:00:00Z', ...over,
});

describe('InstantPayoutDialog', () => {
  afterEach(cleanup);
  beforeEach(() => {
    toast.mockReset();
    requestMock.mockReset();
  });

  it('shows the fee breakdown before anything is sent', () => {
    render(<InstantPayoutDialog eligibility={eligibility} onClose={vi.fn()} onDone={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: /instant payout/i })).toBeInTheDocument();
    expect(screen.getByText('$500.00')).toBeInTheDocument(); // to bank
    expect(screen.getByText('$5.00')).toBeInTheDocument(); // 1% fee
    expect(screen.getByText('$505.00')).toBeInTheDocument(); // taken from balance
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('requires a review step, then sends the amount, the fee the user saw, and an idempotency key', async () => {
    requestMock.mockResolvedValue({ payout: payout(), warning: null, message: null });
    const onDone = vi.fn();
    render(<InstantPayoutDialog eligibility={eligibility} onClose={vi.fn()} onDone={onDone} />);

    fireEvent.click(screen.getByRole('button', { name: /review payout/i }));
    expect(requestMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /confirm instant payout/i }));

    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));
    expect(requestMock.mock.calls[0][0]).toMatchObject({ amountCents: 50_000, expectedFeeCents: 500 });
    expect(requestMock.mock.calls[0][0].idempotencyKey).toMatch(/.{8,}/);
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(true));
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('$500.00 is on its way'), 'success');
  });

  it('validates a custom amount against the balance', () => {
    render(<InstantPayoutDialog eligibility={eligibility} onClose={vi.fn()} onDone={vi.fn()} />);
    fireEvent.click(screen.getByLabelText(/custom amount/i));
    fireEvent.change(screen.getByLabelText('Payout amount'), { target: { value: '600' } });
    expect(screen.getByText(/up to \$500\.00/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /review payout/i }));
    expect(screen.queryByRole('button', { name: /confirm instant payout/i })).not.toBeInTheDocument();
  });

  it('asks the user to type a phrase for large payouts', () => {
    const big = { ...eligibility, availableCents: 600_000, maxPayoutCents: 594_000 };
    render(<InstantPayoutDialog eligibility={big} onClose={vi.fn()} onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /review payout/i }));
    expect(screen.getByRole('button', { name: /confirm instant payout/i })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/to confirm/i), { target: { value: 'instant payout' } });
    expect(screen.getByRole('button', { name: /confirm instant payout/i })).toBeEnabled();
  });

  it('shows a server error and returns to the form so the user can retry', async () => {
    requestMock.mockRejectedValue(new InstantPayoutError('Your card issuer declined this payout.', 422, 'stripe_rejected'));
    render(<InstantPayoutDialog eligibility={eligibility} onClose={vi.fn()} onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /review payout/i }));
    fireEvent.click(screen.getByRole('button', { name: /confirm instant payout/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/declined/);
    expect(screen.getByRole('button', { name: /review payout/i })).toBeInTheDocument();
  });

  it('reloads when the quote changed under the user', async () => {
    requestMock.mockRejectedValue(new InstantPayoutError('The fee is now $5.10.', 409, 'quote_changed'));
    const onDone = vi.fn();
    render(<InstantPayoutDialog eligibility={eligibility} onClose={vi.fn()} onDone={onDone} />);
    fireEvent.click(screen.getByRole('button', { name: /review payout/i }));
    fireEvent.click(screen.getByRole('button', { name: /confirm instant payout/i }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(true));
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('fee is now'), 'error');
  });
});
