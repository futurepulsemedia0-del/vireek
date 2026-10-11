import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const driver = { isSupported: vi.fn(), prepare: vi.fn(), collectAndConfirm: vi.fn(), cancel: vi.fn() };
vi.mock('@/lib/terminalDriver', () => ({ tapToPayDriver: driver }));
vi.mock('@/lib/inPersonPayments', async (orig) => ({
  ...(await orig<typeof import('@/lib/inPersonPayments')>()),
  fetchJobPaymentSummary: vi.fn(),
  recordManualPayment: vi.fn(),
  createCardIntent: vi.fn(),
  finalizeCardPayment: vi.fn(),
  cancelCardPayment: vi.fn(),
}));

import * as api from '@/lib/inPersonPayments';
import { JobPaymentPanel } from './JobPaymentPanel';

const base = { invoice_cents: 20000, paid_cents: 0, balance_cents: 20000, currency: 'usd', card_ready: true, payments: [] };
const summary = (o: Partial<typeof base> = {}) => ({ ...base, ...o });

beforeEach(() => {
  vi.resetAllMocks();
  driver.isSupported.mockReturnValue(true);
  driver.prepare.mockResolvedValue(undefined);
  driver.collectAndConfirm.mockResolvedValue(undefined);
  driver.cancel.mockResolvedValue(undefined);
  vi.mocked(api.fetchJobPaymentSummary).mockResolvedValue(summary());
});

describe('JobPaymentPanel', () => {
  it('shows totals and actions', async () => {
    render(<JobPaymentPanel jobId="j1" />);
    expect(await screen.findByText('Balance due')).toBeInTheDocument();
    expect(screen.getAllByText('$200.00').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /Tap/ })).toBeEnabled();
  });

  it('hides actions when paid in full', async () => {
    vi.mocked(api.fetchJobPaymentSummary).mockResolvedValue(summary({ paid_cents: 20000, balance_cents: 0 }));
    render(<JobPaymentPanel jobId="j1" />);
    expect(await screen.findByText(/Paid in full/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Cash/ })).toBeNull();
  });

  it('explains Tap to Pay on the web and disables it', async () => {
    driver.isSupported.mockReturnValue(false);
    render(<JobPaymentPanel jobId="j1" />);
    expect(await screen.findByText(/available in the Vireek Field app/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Tap/ })).toBeDisabled();
  });

  it('shows a retryable error state', async () => {
    vi.mocked(api.fetchJobPaymentSummary).mockRejectedValueOnce(new Error('x'));
    render(<JobPaymentPanel jobId="j1" />);
    fireEvent.click(await screen.findByRole('button', { name: /try again/i }));
    expect(await screen.findByText('Balance due')).toBeInTheDocument();
  });

  it('records cash with change and applies only the balance', async () => {
    vi.mocked(api.recordManualPayment).mockResolvedValue({ success: true, balance_cents: 0 });
    render(<JobPaymentPanel jobId="j1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Cash/ }));
    fireEvent.change(screen.getByLabelText('Cash received'), { target: { value: '250' } });
    expect(screen.getByText(/Change due \$50\.00/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Record/ }));
    await waitFor(() => expect(api.recordManualPayment).toHaveBeenCalledWith(expect.objectContaining({ method: 'cash', amountCents: 20000, tenderedCents: 25000 })));
    expect(await screen.findByText(/Give \$50\.00 change/)).toBeInTheDocument();
  });

  it('requires a valid check number before submitting', async () => {
    render(<JobPaymentPanel jobId="j1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Check/ }));
    fireEvent.click(screen.getByRole('button', { name: /Record/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/check number/i);
    expect(api.recordManualPayment).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/Check number/), { target: { value: '1001' } });
    vi.mocked(api.recordManualPayment).mockResolvedValue({ success: true });
    fireEvent.click(screen.getByRole('button', { name: /Record/ }));
    await waitFor(() => expect(api.recordManualPayment).toHaveBeenCalledWith(expect.objectContaining({ method: 'check', checkNumber: '1001', amountCents: 20000 })));
  });

  it('shows server-side rejection messages', async () => {
    vi.mocked(api.recordManualPayment).mockResolvedValue({ success: false, error: 'duplicate_check_number' });
    render(<JobPaymentPanel jobId="j1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Check/ }));
    fireEvent.change(screen.getByLabelText(/Check number/), { target: { value: '1001' } });
    fireEvent.click(screen.getByRole('button', { name: /Record/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/already recorded/);
  });

  it('completes a Tap to Pay payment', async () => {
    vi.mocked(api.createCardIntent).mockResolvedValue({ job_payment_id: 'p1', client_secret: 'cs', payment_intent_id: 'pi', amount_cents: 20000, location_id: 'l' });
    vi.mocked(api.finalizeCardPayment).mockResolvedValue({ status: 'succeeded', balance_cents: 0 });
    render(<JobPaymentPanel jobId="j1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Tap/ }));
    fireEvent.click(screen.getByRole('button', { name: /Start Tap to Pay/ }));
    await waitFor(() => expect(driver.collectAndConfirm).toHaveBeenCalledWith('cs'));
    expect(await screen.findByText(/card payment received/)).toBeInTheDocument();
  });

  it('cancels server-side and lets the tech retry when the card fails', async () => {
    vi.mocked(api.createCardIntent).mockResolvedValue({ job_payment_id: 'p1', client_secret: 'cs', payment_intent_id: 'pi', amount_cents: 20000, location_id: 'l' });
    driver.collectAndConfirm.mockRejectedValue(new Error('Card declined'));
    vi.mocked(api.cancelCardPayment).mockResolvedValue({ status: 'failed' });
    render(<JobPaymentPanel jobId="j1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Tap/ }));
    fireEvent.click(screen.getByRole('button', { name: /Start Tap to Pay/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Card declined');
    expect(api.cancelCardPayment).toHaveBeenCalledWith('p1');
    expect(screen.getByRole('button', { name: /Try again/ })).toBeEnabled();
  });

  it('rejects card amounts above the balance without calling the server', async () => {
    render(<JobPaymentPanel jobId="j1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Tap/ }));
    fireEvent.change(screen.getByLabelText('Amount to charge'), { target: { value: '500' } });
    fireEvent.click(screen.getByRole('button', { name: /Start Tap to Pay/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/more than the balance/);
    expect(api.createCardIntent).not.toHaveBeenCalled();
  });
});
