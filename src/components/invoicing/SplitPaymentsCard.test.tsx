import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchPayers = vi.fn();
const toast = vi.fn();
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/lib/invoiceSplit', async (orig) => ({
  ...(await orig<typeof import('@/lib/invoiceSplit')>()),
  fetchSplitPayers: (...a: unknown[]) => fetchPayers(...a),
}));

import { SplitPaymentsCard } from './SplitPaymentsCard';
import type { Invoice } from '@/lib/invoices';
import type { InvoiceLedger, InvoicePayment } from '@/lib/invoiceDetail';
import type { SplitPayer } from '@/lib/invoiceSplit';

const invoice = (over: Partial<Invoice> = {}) => ({ id: 'i1', status: 'sent', invoice_number: 'INV-1', ...over }) as Invoice;
const ledger = (over: Partial<InvoiceLedger> = {}): InvoiceLedger => ({ subtotalCents: 100000, taxCents: 0, totalCents: 100000, paidCents: 0, refundedCents: 0, netPaidCents: 0, balanceCents: 100000, state: 'unpaid', ...over });
const payer = (over: Partial<SplitPayer> = {}): SplitPayer => ({
  id: 'a', user_id: 'u', invoice_id: 'i1', sort_order: 1, role: 'insurer', name: 'Acme Insurance', email: 'c@acme.com', phone: null,
  share_type: 'fixed', share_value: 80000, amount_cents: 80000, plan_total_cents: 100000, public_token: 'tok', stripe_payment_intent_id: null,
  needs_review: false, link_sent_at: null, created_at: '', updated_at: '', ...over,
});
const pay = (over: Partial<InvoicePayment> = {}): InvoicePayment => ({ id: 'p1', invoice_id: 'i1', amount_cents: 30000, method: 'check', reference: null, note: null, paid_at: '', created_by_email: null, created_at: '', payer_id: 'a', ...over });

const renderCard = (props: { invoice?: Invoice; ledger?: InvoiceLedger; payments?: InvoicePayment[] } = {}) =>
  render(<SplitPaymentsCard ownerId="u" invoice={props.invoice ?? invoice()} ledger={props.ledger ?? ledger()} payments={props.payments ?? []} refunds={[]} onChanged={async () => {}} />);

describe('SplitPaymentsCard', () => {
  beforeEach(() => { fetchPayers.mockReset(); toast.mockReset(); });

  it('shows a loading skeleton, then the empty state with a way to start', async () => {
    fetchPayers.mockResolvedValue([]);
    renderCard();
    expect(screen.getByLabelText('Loading split payments')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Set up split' }));
    expect(await screen.findByRole('dialog', { name: 'Split this invoice' })).toBeInTheDocument();
  });

  it('offers a retry when loading fails', async () => {
    fetchPayers.mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce([]);
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Set up split' })).toBeInTheDocument();
  });

  it('lists payers with progress from the shared ledger', async () => {
    fetchPayers.mockResolvedValue([payer()]);
    renderCard({ payments: [pay()] });
    expect(await screen.findByText('Acme Insurance')).toBeInTheDocument();
    expect(screen.getByText('Partly paid')).toBeInTheDocument();
    expect(screen.getByText(/Remaining \$500\.00/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /record payment/i })).toBeInTheDocument();
  });

  it('pauses actions and warns when the invoice total changed', async () => {
    fetchPayers.mockResolvedValue([payer({ plan_total_cents: 90000 })]);
    renderCard();
    expect(await screen.findByRole('alert')).toHaveTextContent(/total changed/i);
    expect(screen.queryByRole('button', { name: /record payment/i })).toBeNull();
  });

  it('copies a payer’s private link', async () => {
    fetchPayers.mockResolvedValue([payer()]);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: /copy link/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining('/pay-share/tok')));
  });

  it('renders nothing for a void invoice with no split, and no actions when void with one', async () => {
    fetchPayers.mockResolvedValue([]);
    const { container } = renderCard({ invoice: invoice({ status: 'void' }) });
    await waitFor(() => expect(container.querySelector('section')).toBeNull());
  });

  it('disables emailing a payer without an address', async () => {
    fetchPayers.mockResolvedValue([payer({ email: null })]);
    renderCard();
    expect(await screen.findByRole('button', { name: /email link/i })).toBeDisabled();
  });
});
