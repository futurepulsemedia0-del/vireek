import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const fetchPublicSplit = vi.fn();
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/publicSplitPayment', () => ({
  fetchPublicSplit: (...a: unknown[]) => fetchPublicSplit(...a),
  createSplitPaymentIntent: vi.fn(),
}));
vi.mock('@/components/payments/StripePaymentForm', () => ({
  StripePaymentForm: ({ payLabel }: { payLabel: string }) => <button type="button">{payLabel}</button>,
}));

import { SplitPayerPayPage } from './SplitPayerPayPage';

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/pay-share/abc']}>
      <Routes><Route path="/pay-share/:token" element={<SplitPayerPayPage />} /></Routes>
    </MemoryRouter>,
  );

const OPEN = { status: 'open', payer_name: 'Ada', role: 'tenant', invoice_number: 'INV-7', business_name: 'Acme HVAC', share_cents: 20000, paid_cents: 5000, payable_cents: 15000, publishable_key: 'pk_test_x' };

describe('SplitPayerPayPage', () => {
  beforeEach(() => fetchPublicSplit.mockReset());

  it('shows only the payer’s own amount and the pay button', async () => {
    fetchPublicSplit.mockResolvedValue(OPEN);
    renderPage();
    expect(await screen.findByRole('button', { name: /pay \$150\.00/i })).toBeInTheDocument();
    expect(screen.getByText(/INV-7/)).toBeInTheDocument();
    expect(screen.getByText(/Already paid/)).toBeInTheDocument();
  });

  it('shows a loading state first', () => {
    fetchPublicSplit.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByLabelText('Loading')).toBeInTheDocument();
  });

  it('thanks a payer whose share is already paid', async () => {
    fetchPublicSplit.mockResolvedValue({ status: 'paid' });
    renderPage();
    expect(await screen.findByText('Your share is paid')).toBeInTheDocument();
  });

  it('explains a changed invoice instead of taking money', async () => {
    fetchPublicSplit.mockResolvedValue({ status: 'blocked', reason: 'changed' });
    renderPage();
    expect(await screen.findByText('This invoice was updated')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /pay/i })).toBeNull();
  });

  it('handles an unknown link and a failed load', async () => {
    fetchPublicSplit.mockResolvedValueOnce({ status: 'not_found' });
    const first = renderPage();
    expect(await screen.findByText('This payment link isn’t available')).toBeInTheDocument();
    first.unmount();
    fetchPublicSplit.mockRejectedValueOnce(new Error('Something went wrong. Please try again.'));
    renderPage();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong'));
  });
});
