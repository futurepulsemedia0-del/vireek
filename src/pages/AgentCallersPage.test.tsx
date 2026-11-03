import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import axe from 'axe-core';
import { AgentCallersPage } from './AgentCallersPage';
import { DEFAULT_AGENT_CALLER_SETTINGS, type AgentCallRow, type AgentHold } from '@/lib/agentCallers';

const api = vi.hoisted(() => ({
  fetchSettings: vi.fn(), saveSettings: vi.fn(), fetchHolds: vi.fn(), decideHold: vi.fn(), fetchCalls30d: vi.fn(),
  fetchFunnelEvents: vi.fn(), fetchQuotableItems: vi.fn(), setItemQuotable: vi.fn(),
}));
const auth = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const toast = vi.hoisted(() => vi.fn());

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth.value }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/components/DashboardNav', () => ({ DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/agentCallersApi', () => api);

const soon = new Date(Date.now() + 10 * 60_000).toISOString();
const hold: AgentHold = { id: 'h1', code: 'ABC234', status: 'held', mode: 'hold', service: 'Drain Cleaning', zip: '78701', window_start: soon, expires_at: soon, platform_claimed: 'google', call_id: 'c1' };
const call = (o: Partial<AgentCallRow>): AgentCallRow => ({ id: 'c1', call_datetime: new Date().toISOString(), caller_kind: 'ai_agent', caller_kind_confidence: 0.92, agent_platform_claimed: 'google', status: 'new_lead', booking_outcome: null, ...o });

function renderPage() {
  return render(<MemoryRouter><AgentCallersPage /></MemoryRouter>);
}

beforeEach(() => {
  Object.values(api).forEach((m) => m.mockReset());
  toast.mockReset();
  auth.value = { profile: { id: 'owner-1' }, teamMember: null, isOwner: true };
  api.fetchSettings.mockResolvedValue({ ...DEFAULT_AGENT_CALLER_SETTINGS, enabled: true });
  api.fetchCalls30d.mockResolvedValue([call({ id: 'c1' }), call({ id: 'c2', caller_kind: 'human', agent_platform_claimed: null, status: 'booked' })]);
  api.fetchFunnelEvents.mockResolvedValue([{ callId: 'c1', type: 'quote_given' }]);
  api.fetchHolds.mockResolvedValue([hold]);
  api.fetchQuotableItems.mockResolvedValue([{ id: 'i1', service_name: 'Drain Cleaning', category: 'Plumbing', agent_quotable: true }]);
});
afterEach(cleanup);

describe('AgentCallersPage', () => {
  it('shows the funnel, the honest-detection note and separate agent vs human win rates', async () => {
    renderPage();
    expect(await screen.findByText('AI agent funnel (last 30 days)')).toBeInTheDocument();
    expect(screen.getByText(/Caller ID and phone numbers are never used to guess/)).toBeInTheDocument();
    expect(screen.getByText('AI agent win rate')).toBeInTheDocument();
    expect(screen.getByText('Human lead win rate')).toBeInTheDocument();
    expect(screen.getByText('1/1')).toBeInTheDocument(); // human cohort: 1 booked of 1
    expect(screen.getByText(/google \(claimed by the caller, not verified\)/)).toBeInTheDocument();
  });

  it('alerts when a hold is about to expire and lets the owner approve it', async () => {
    api.decideHold.mockResolvedValue('confirmed');
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('Holds expiring soon');
    fireEvent.click(screen.getByRole('tab', { name: 'Holds' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(api.decideHold).toHaveBeenCalledWith('h1', true));
    expect(toast).toHaveBeenCalledWith('Hold approved', 'success');
  });

  it('saves controls through the API with parsed ZIPs and topics', async () => {
    api.saveSettings.mockImplementation(async (s) => s);
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: 'Controls' }));
    fireEvent.change(screen.getByLabelText('ZIP codes you never serve to AI agents'), { target: { value: '78701\nabc\n78701' } });
    fireEvent.change(screen.getByLabelText('Topics never discussed with AI agents'), { target: { value: 'Warranty\nwarranty' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save controls' }));
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalled());
    const saved = api.saveSettings.mock.calls[0][0];
    expect(saved.blockedZips).toEqual(['78701']);
    expect(saved.neverDiscuss).toEqual(['Warranty', 'warranty']);
  });

  it('warns before automatic booking is chosen', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: 'Controls' }));
    fireEvent.change(screen.getByLabelText('When an agent picks a time'), { target: { value: 'auto_book' } });
    expect(screen.getByRole('note')).toHaveTextContent('without a person looking at it');
  });

  it('has no axe violations on any tab (jsdom: colour contrast is covered by the Playwright spec)', async () => {
    const { container } = renderPage();
    await screen.findByText('AI agent funnel (last 30 days)');
    for (const name of ['Overview', 'Holds', 'Controls', 'Quotable services']) {
      fireEvent.click(screen.getByRole('tab', { name }));
      const r = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
      expect(r.violations.map((v) => `${name}: ${v.id}`)).toEqual([]);
    }
  });

  it('team members cannot edit controls', async () => {
    auth.value = { profile: { id: 'staff-1' }, teamMember: { account_owner_id: 'owner-1' }, isOwner: false };
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: 'Controls' }));
    expect(screen.getByText('Only the account owner can change these controls.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save controls' })).not.toBeInTheDocument();
  });

  it('shows an error state with retry when loading fails', async () => {
    api.fetchSettings.mockRejectedValue(new Error('boom'));
    renderPage();
    expect(await screen.findByText('Could not load AI agent data')).toBeInTheDocument();
  });
});
