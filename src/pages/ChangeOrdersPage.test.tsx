import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ChangeOrdersPage } from './ChangeOrdersPage';
import type { ChangeOrder } from '@/lib/changeOrders';

const api = vi.hoisted(() => ({
  fetchChangeOrders: vi.fn(),
  fetchParentInfo: vi.fn(),
  fetchParentOptions: vi.fn(),
  fetchEvents: vi.fn(),
  fetchInvoice: vi.fn(),
  createChangeOrder: vi.fn(),
  updateChangeOrder: vi.fn(),
  sendChangeOrder: vi.fn(),
  cancelChangeOrder: vi.fn(),
  recordDecision: vi.fn(),
  invoiceChangeOrder: vi.fn(),
}));
const toast = vi.hoisted(() => vi.fn());
const auth = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock('@/lib/changeOrdersApi', () => api);
vi.mock('@/lib/quotes', () => ({ formatCents: (c: number) => `$${(c / 100).toFixed(2)}` }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth.value }));
vi.mock('@/components/DashboardNav', () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const CO = (over: Partial<ChangeOrder> = {}): ChangeOrder => ({
  id: 'c1', user_id: 'owner1', co_number: 'CO-0001', job_id: 'j1', project_id: null, customer_id: null,
  customer_name: 'Dana Whitfield', customer_email: 'dana@example.com', customer_phone: null, site_address: '12 Elm St',
  title: 'Replace contactor', reason: 'unforeseen_condition', description: 'Burnt contactor found.', internal_notes: '',
  line_items: [{ description: 'Contactor', quantity: 1, unit_price_cents: 10000 }],
  tax_percent: 0, subtotal_cents: 10000, tax_cents: 0, total_cents: 10000, schedule_impact_days: 1,
  status: 'draft', approval_token: '00000000-0000-4000-8000-000000000001', content_hash: null,
  sent_at: null, expires_at: null, viewed_at: null, responded_at: null, approval_method: null,
  approver_name: null, response_note: null, cancelled_at: null, cancel_reason: null, invoice_id: null,
  invoiced_at: null, created_at: '2027-03-01T00:00:00Z', updated_at: '2027-03-01T00:00:00Z', ...over,
});

const FUTURE = new Date(Date.now() + 10 * 86_400_000).toISOString();

function setup(path = '/dashboard/change-orders', over: Partial<Record<string, unknown>> = {}) {
  auth.value = { profile: { id: 'owner1' }, teamMember: null, isOwner: true, permissions: {}, loading: false, profileLoading: false, ...over };
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/dashboard/change-orders" element={<ChangeOrdersPage />} />
        <Route path="/dashboard/change-orders/:changeOrderId" element={<ChangeOrdersPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ChangeOrdersPage', () => {
  beforeEach(() => {
    Object.values(api).forEach((f) => f.mockReset());
    toast.mockReset();
    api.fetchChangeOrders.mockResolvedValue([
      CO({ id: 'c1', status: 'sent', expires_at: FUTURE, sent_at: '2027-03-02T00:00:00Z', content_hash: 'h' }),
      CO({ id: 'c2', co_number: 'CO-0002', title: 'Add zone damper', status: 'approved', total_cents: 25000, responded_at: '2027-03-03T00:00:00Z', approval_method: 'online', approver_name: 'Dana', content_hash: 'h', sent_at: '2027-03-02T00:00:00Z' }),
    ]);
    api.fetchParentInfo.mockResolvedValue({ 'job:j1': { label: 'Dana Whitfield · AC repair', originalCents: 500000, href: '/dashboard/jobs' } });
    api.fetchEvents.mockResolvedValue([]);
    api.fetchInvoice.mockResolvedValue(null);
    api.fetchParentOptions.mockResolvedValue([]);
  });

  it('shows a loading state, then summary tiles and the list', async () => {
    setup();
    expect(screen.getByLabelText('Loading change orders')).toBeTruthy();
    expect(await screen.findByText('Replace contactor')).toBeTruthy();
    expect(screen.getByText('Add zone damper')).toBeTruthy();
    expect(screen.getByText('Awaiting approval', { selector: 'p' })).toBeTruthy();
    expect(screen.getByText('Ready to invoice')).toBeTruthy();
  });

  it('shows the empty state with a call to action', async () => {
    api.fetchChangeOrders.mockResolvedValue([]);
    setup();
    expect(await screen.findByText('No change orders yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: /create your first change order/i })).toBeTruthy();
  });

  it('shows an error state and retries', async () => {
    api.fetchChangeOrders.mockRejectedValueOnce(new Error('network'));
    setup();
    expect(await screen.findByText('Could not load change orders')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('Replace contactor')).toBeTruthy();
    expect(api.fetchChangeOrders).toHaveBeenCalledTimes(2);
  });

  it('blocks team members without billing access', async () => {
    setup('/dashboard/change-orders', { isOwner: false, permissions: { can_view_billing: false }, teamMember: { account_owner_id: 'owner1' } });
    expect(await screen.findByText(/limited to billing access/i)).toBeTruthy();
    expect(api.fetchChangeOrders).not.toHaveBeenCalled();
  });

  it('allows team members with billing access, scoped to the account owner', async () => {
    setup('/dashboard/change-orders', { isOwner: false, permissions: { can_view_billing: true }, teamMember: { account_owner_id: 'owner9' } });
    expect(await screen.findByText('Replace contactor')).toBeTruthy();
    expect(api.fetchChangeOrders).toHaveBeenCalledWith('owner9');
  });

  it('filters by status and offers to clear when nothing matches', async () => {
    setup();
    await screen.findByText('Replace contactor');
    fireEvent.click(screen.getByRole('button', { name: 'Declined' }));
    expect(await screen.findByText('Nothing matches')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /clear filters/i }));
    expect(await screen.findByText('Replace contactor')).toBeTruthy();
  });

  it('searches by customer, title and number', async () => {
    setup();
    await screen.findByText('Replace contactor');
    fireEvent.change(screen.getByLabelText('Search change orders'), { target: { value: 'zone' } });
    expect(screen.queryByText('Replace contactor')).toBeNull();
    expect(screen.getByText('Add zone damper')).toBeTruthy();
  });

  it('requires a job or project before a new change order can be created', async () => {
    setup();
    await screen.findByText('Replace contactor');
    fireEvent.click(screen.getByRole('button', { name: /new change order/i }));
    fireEvent.click(await screen.findByRole('button', { name: /create draft/i }));
    expect(await screen.findByText('Pick the job or project this change applies to.')).toBeTruthy();
    expect(api.createChangeOrder).not.toHaveBeenCalled();
  });

  it('opens the detail view with totals and the customer link for a sent change order', async () => {
    setup('/dashboard/change-orders/c1');
    expect(await screen.findByRole('heading', { name: 'Replace contactor' })).toBeTruthy();
    expect(screen.getByTestId('detail-total').textContent).toBe('$100.00');
    expect(screen.getByTestId('approval-link').textContent).toContain('/change-order/00000000-0000-4000-8000-000000000001');
    // revised contract = original 5,000.00 + 0 approved on this job (c1 is only pending)
    expect(screen.getByText('Revised contract')).toBeTruthy();
  });

  it('sends a draft for approval with the chosen expiry', async () => {
    api.fetchChangeOrders.mockResolvedValue([CO({ status: 'draft' })]);
    api.sendChangeOrder.mockResolvedValue('tok');
    setup('/dashboard/change-orders/c1');
    fireEvent.click(await screen.findByRole('button', { name: /send for approval/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(api.sendChangeOrder).toHaveBeenCalledWith('c1', 14));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Ready to share with the customer.', 'success'));
  });

  it('surfaces a friendly error when the server refuses an action', async () => {
    api.fetchChangeOrders.mockResolvedValue([CO({ status: 'draft' })]);
    api.sendChangeOrder.mockRejectedValue(new Error('Could not send the change order.'));
    setup('/dashboard/change-orders/c1');
    fireEvent.click(await screen.findByRole('button', { name: /send for approval/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls.at(-1)?.[1]).toBe('error');
  });

  it('requires a reason to cancel a sent change order', async () => {
    setup('/dashboard/change-orders/c1');
    fireEvent.click(await screen.findByRole('button', { name: /cancel change order/i }));
    fireEvent.click(await screen.findByRole('button', { name: /yes, cancel it/i }));
    expect(toast).toHaveBeenCalledWith('Please give a short reason.', 'error');
    expect(api.cancelChangeOrder).not.toHaveBeenCalled();
  });

  it('offers invoicing for an approved change order and creates the invoice', async () => {
    api.fetchChangeOrders.mockResolvedValue([CO({ status: 'approved', responded_at: '2027-03-03T00:00:00Z', approval_method: 'online', approver_name: 'Dana', content_hash: 'h', sent_at: '2027-03-02T00:00:00Z' })]);
    api.invoiceChangeOrder.mockResolvedValue('inv1');
    setup('/dashboard/change-orders/c1');
    fireEvent.click(await screen.findByRole('button', { name: /create invoice/i }));
    fireEvent.click((await screen.findAllByRole('button', { name: /create invoice/i })).at(-1)!);
    await waitFor(() => expect(api.invoiceChangeOrder).toHaveBeenCalledWith('c1', null));
  });

  it('shows not-found for an unknown change order', async () => {
    setup('/dashboard/change-orders/nope');
    expect(await screen.findByText('Change order not found')).toBeTruthy();
  });
});
