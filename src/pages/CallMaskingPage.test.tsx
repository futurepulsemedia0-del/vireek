import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CallMaskingPage } from './CallMaskingPage';
import type { MySession, ProxyNumber, ProxySession } from '@/lib/callMasking';

const api = vi.hoisted(() => ({
  fetchProxyNumbers: vi.fn(), fetchProxyNumberStats: vi.fn(), fetchSessions: vi.fn(), fetchRecentEvents: vi.fn(), fetchTechnicians: vi.fn(),
  fetchMySessions: vi.fn(), closeSession: vi.fn(), extendSession: vi.fn(), allocateSession: vi.fn(), addProxyNumber: vi.fn(),
  setProxyNumberStatus: vi.fn(), setTechnicianPhone: vi.fn(), startBridgeCall: vi.fn(),
}));
const auth = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth.value }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/components/DashboardNav', () => ({ DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/callMaskingApi', () => api);

const future = new Date(Date.now() + 5 * 3_600_000).toISOString();
const session: ProxySession = {
  id: 's1', proxy_number_id: 'n1', job_id: null, technician_id: 't1', customer_name: 'Ann Smith', technician_name: 'Tom Tech',
  customer_e164: '+15552010001', technician_e164: '+15552010002', status: 'active', expires_at: future, closed_at: null, close_reason: null, created_at: future,
};
const number: ProxyNumber = { id: 'n1', e164: '+15559990001', label: 'Main', status: 'active', created_at: future };
const mine: MySession = { id: 's1', job_id: null, customer_name: 'Ann Smith', proxy_e164: '+15559990001', expires_at: future, created_at: future };

afterEach(cleanup);

beforeEach(() => {
  Object.values(api).forEach((m) => m.mockReset());
  auth.value = { profile: { id: 'owner-1' }, teamMember: null, isOwner: true, permissions: { can_manage_numbers: true, can_view_billing: true, can_view_all_jobs: true } };
  api.fetchProxyNumbers.mockResolvedValue([number]);
  api.fetchProxyNumberStats.mockResolvedValue({ n1: { number_id: 'n1', active_sessions: 1, total_sessions: 1, calls_30d: 3 } });
  api.fetchSessions.mockResolvedValue([session]);
  api.fetchRecentEvents.mockResolvedValue([]);
  api.fetchTechnicians.mockResolvedValue([]);
  api.fetchMySessions.mockResolvedValue([mine]);
});

describe('CallMaskingPage', () => {
  it('shows live conversations and the stats', async () => {
    render(<CallMaskingPage />);
    expect(await screen.findByText('Ann Smith')).toBeTruthy();
    expect(screen.getByText('Live conversations')).toBeTruthy();
    expect(screen.getByText('(555) 201-0001', { exact: false })).toBeTruthy();
  });

  it('shows an error state with retry', async () => {
    api.fetchProxyNumbers.mockRejectedValueOnce(new Error('x'));
    render(<CallMaskingPage />);
    expect(await screen.findByText('Could not load call masking')).toBeTruthy();
    fireEvent.click(screen.getByText('Try again'));
    expect(await screen.findByText('Ann Smith')).toBeTruthy();
  });

  it('shows the empty state when nothing exists', async () => {
    api.fetchSessions.mockResolvedValue([]);
    render(<CallMaskingPage />);
    expect(await screen.findByText('No masked conversations yet')).toBeTruthy();
  });

  it('closes a conversation after confirmation', async () => {
    api.closeSession.mockResolvedValue(undefined);
    render(<CallMaskingPage />);
    await screen.findByText('Ann Smith');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Close conversation' }));
    await waitFor(() => expect(api.closeSession).toHaveBeenCalledWith('s1'));
  });

  it('technicians only see their own calls and never customer numbers', async () => {
    auth.value = { profile: null, teamMember: { account_owner_id: 'owner-1' }, isOwner: false, permissions: {} };
    render(<CallMaskingPage />);
    expect(await screen.findByText('Ann Smith')).toBeTruthy();
    expect(api.fetchSessions).not.toHaveBeenCalled();
    expect(screen.queryByText('(555) 201-0001', { exact: false })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Call customer/ }));
    await waitFor(() => expect(api.startBridgeCall).toHaveBeenCalledWith('s1'));
  });
});
