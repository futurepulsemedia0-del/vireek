import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PublicChangeOrderPage } from './PublicChangeOrderPage';
import type { PublicChangeOrder } from '@/lib/changeOrders';

const api = vi.hoisted(() => ({
  fetchPublicChangeOrder: vi.fn(),
  recordPublicView: vi.fn(),
  respondPublic: vi.fn(),
}));

vi.mock('@/lib/changeOrdersApi', () => api);
vi.mock('@/lib/quotes', () => ({ formatCents: (c: number) => `$${(c / 100).toFixed(2)}` }));

const TOKEN = '00000000-0000-4000-8000-000000000001';

const PUBLIC: PublicChangeOrder = {
  number: 'CO-0001', title: 'Replace contactor', reason: 'unforeseen_condition', description: 'Burnt contactor found.',
  lineItems: [{ description: 'Contactor', quantity: 1, unit_price_cents: 10000 }], taxPercent: 0,
  subtotalCents: 10000, taxCents: 0, totalCents: 10000, scheduleImpactDays: 1, status: 'sent',
  sentAt: '2027-03-02T00:00:00Z', expiresAt: '2027-03-16T00:00:00Z', respondedAt: null, approverName: null,
  customerName: 'Dana Whitfield', siteAddress: '12 Elm St', reference: 'AC repair', businessName: 'Acme HVAC',
};

function setup() {
  return render(
    <MemoryRouter initialEntries={[`/change-order/${TOKEN}`]}>
      <Routes><Route path="/change-order/:token" element={<PublicChangeOrderPage />} /></Routes>
    </MemoryRouter>,
  );
}

describe('PublicChangeOrderPage', () => {
  beforeEach(() => {
    Object.values(api).forEach((f) => f.mockReset());
    api.fetchPublicChangeOrder.mockResolvedValue(PUBLIC);
    api.recordPublicView.mockResolvedValue(undefined);
    api.respondPublic.mockResolvedValue(undefined);
  });

  it('shows a loading state, then the change order and records the view', async () => {
    setup();
    expect(screen.getByLabelText('Loading your change order')).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Replace contactor' })).toBeTruthy();
    expect(screen.getByTestId('public-total').textContent).toBe('$100.00');
    expect(screen.getByText(/Acme HVAC/)).toBeTruthy();
    expect(api.recordPublicView).toHaveBeenCalledWith(TOKEN);
  });

  it('shows a friendly page for an unknown link', async () => {
    api.fetchPublicChangeOrder.mockResolvedValue(null);
    setup();
    expect(await screen.findByText(/couldn.t find this change order/i)).toBeTruthy();
    expect(api.recordPublicView).not.toHaveBeenCalled();
  });

  it('requires a typed name and consent before approving', async () => {
    setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve and sign' }));
    expect(await screen.findByText('Please type your full name to sign.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/type your full name to sign/i), { target: { value: 'Dana Whitfield' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve and sign' }));
    expect(await screen.findByText('Please confirm that you agree to this change.')).toBeTruthy();
    expect(api.respondPublic).not.toHaveBeenCalled();
  });

  it('submits an approval and then shows the approved state', async () => {
    setup();
    fireEvent.change(await screen.findByLabelText(/type your full name to sign/i), { target: { value: 'Dana Whitfield' } });
    fireEvent.click(screen.getByRole('checkbox'));
    api.fetchPublicChangeOrder.mockResolvedValue({ ...PUBLIC, status: 'approved', approverName: 'Dana Whitfield', respondedAt: '2027-03-03T00:00:00Z' });
    fireEvent.click(screen.getByRole('button', { name: 'Approve and sign' }));
    await waitFor(() => expect(api.respondPublic).toHaveBeenCalledWith(TOKEN, 'approved', 'Dana Whitfield', ''));
    expect(await screen.findByText(/Approved — thank you/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve and sign' })).toBeNull();
  });

  it('lets the customer decline without a name', async () => {
    setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Decline' }));
    fireEvent.click(screen.getByRole('button', { name: 'Decline change order' }));
    await waitFor(() => expect(api.respondPublic).toHaveBeenCalledWith(TOKEN, 'declined', '', ''));
  });

  it('shows the server error when the response is refused', async () => {
    api.respondPublic.mockRejectedValue(new Error('This approval link has expired. Please ask the business to send it again.'));
    setup();
    fireEvent.change(await screen.findByLabelText(/type your full name to sign/i), { target: { value: 'Dana Whitfield' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Approve and sign' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/expired/);
  });

  it('hides the form for expired and closed change orders', async () => {
    api.fetchPublicChangeOrder.mockResolvedValue({ ...PUBLIC, status: 'expired' });
    setup();
    expect(await screen.findByText('This approval link has expired')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve and sign' })).toBeNull();
    expect(api.recordPublicView).not.toHaveBeenCalled();
  });
});
