import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThirdPartyIntakePage } from './ThirdPartyIntakePage';
import type { ThirdPartyWorkOrder } from '@/lib/thirdPartyIntake';

const OWNER_ID = 'owner-1';
const auth = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const api = vi.hoisted(() => ({
  fetchIntakes: vi.fn(),
  fetchPayers: vi.fn(),
  fetchEvents: vi.fn(),
  fetchRawPayload: vi.fn(),
  actOnIntake: vi.fn(),
  editIntake: vi.fn(),
}));

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth.value }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/components/DashboardNav', () => ({ DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/thirdPartyIntakeApi', () => api);

const baseAuth = {
  profile: { id: OWNER_ID, inbound_email_token: 'tok123' },
  teamMember: null,
  isOwner: true,
  permissions: { can_view_billing: true },
  loading: false,
  profileLoading: false,
};

const inMin = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const makeRow = (over: Partial<ThirdPartyWorkOrder> = {}): ThirdPartyWorkOrder => ({
  id: 'r1', user_id: OWNER_ID, payer_id: 'p1', payer_name: 'Acme Warranty', received_via: 'api', external_ref: 'CLM-1',
  priority: 'urgent', title: 'Fridge not cooling', description: 'Compressor noise', service_type: null, customer_name: 'Ana Lopez',
  customer_phone: '555-010-2030', customer_email: null, service_address: '12 Oak St', policy_number: null,
  nte_cents: 45000, quoted_cents: null, status: 'new', needs_review: false, review_reasons: [],
  authorization_status: 'pending', authorization_ref: null, authorized_cents: null, authorized_at: null, decline_reason: null,
  scheduled_for: null, work_order_id: null, received_at: inMin(-30), accept_due_at: inMin(90), schedule_due_at: inMin(1440),
  complete_due_at: inMin(4320), responded_at: null, accepted_at: null, completed_at: null, paused_at: null, paused_from_status: null,
  created_at: inMin(-30), updated_at: inMin(-30), ...over,
});

const renderPage = () => render(<MemoryRouter><ThirdPartyIntakePage /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  auth.value = { ...baseAuth };
  api.fetchPayers.mockResolvedValue([]);
  api.fetchEvents.mockResolvedValue([]);
});

describe('ThirdPartyIntakePage', () => {
  it('blocks team members without billing permission', () => {
    auth.value = { ...baseAuth, isOwner: false, teamMember: { account_owner_id: OWNER_ID }, permissions: { can_view_billing: false } };
    renderPage();
    expect(screen.getByText(/don.t have access/i)).toBeInTheDocument();
    expect(api.fetchIntakes).not.toHaveBeenCalled();
  });

  it('scopes the query to the account owner and shows requests with their SLA', async () => {
    api.fetchIntakes.mockResolvedValue([makeRow()]);
    renderPage();
    expect(await screen.findByText('Fridge not cooling')).toBeInTheDocument();
    expect(api.fetchIntakes).toHaveBeenCalledWith(OWNER_ID);
    expect(screen.getByText(/Respond:/)).toBeInTheDocument();
    expect(screen.getByText('Urgent')).toBeInTheDocument();
  });

  it('shows the first-run empty state with a way to add a partner', async () => {
    api.fetchIntakes.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText('Connect your first partner')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add a partner/i })).toBeInTheDocument();
  });

  it('shows an error state and retries', async () => {
    api.fetchIntakes.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce([makeRow()]);
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn.t load/i);
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('Fridge not cooling')).toBeInTheDocument();
  });

  it('opens a request and offers accept first; decline needs a reason', async () => {
    api.fetchIntakes.mockResolvedValue([makeRow()]);
    renderPage();
    fireEvent.click(await screen.findByText('Fridge not cooling'));
    expect(await screen.findByRole('button', { name: 'Accept job' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    fireEvent.click(screen.getByRole('button', { name: 'Decline job' }));
    expect(await screen.findByText(/short reason/i)).toBeInTheDocument();
    expect(api.actOnIntake).not.toHaveBeenCalled();
  });

  it('accepts a job through the RPC and updates the card', async () => {
    api.fetchIntakes.mockResolvedValue([makeRow()]);
    api.actOnIntake.mockResolvedValue(makeRow({ status: 'accepted', accepted_at: inMin(0), responded_at: inMin(0) }));
    renderPage();
    fireEvent.click(await screen.findByText('Fridge not cooling'));
    fireEvent.click(await screen.findByRole('button', { name: 'Accept job' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Accept job' }).at(-1)!);
    await waitFor(() => expect(api.actOnIntake).toHaveBeenCalledWith('r1', 'accept', expect.anything()));
    expect(await screen.findByText('Accepted')).toBeInTheDocument();
  });

  it('surfaces a database guard message in the dialog', async () => {
    api.fetchIntakes.mockResolvedValue([makeRow({ status: 'accepted', authorization_status: 'authorized' })]);
    api.actOnIntake.mockRejectedValue({ code: '23514', message: 'Payer authorization is required before this work can be scheduled or completed' });
    renderPage();
    fireEvent.click(await screen.findByText('Fridge not cooling'));
    fireEvent.click(await screen.findByRole('button', { name: 'Mark complete' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Mark complete' }).at(-1)!);
    expect(await screen.findByText(/authorization is required/i)).toBeInTheDocument();
  });
});
