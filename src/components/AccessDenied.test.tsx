import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, o?: Record<string, unknown> & { defaultValue?: string }) =>
      (o?.defaultValue ?? _k).replace(/\{\{(\w+)\}\}/g, (_m, n: string) => String(o?.[n] ?? '')),
  }),
}));

const authState = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => authState.value }));
const api = vi.hoisted(() => ({ requestAccess: vi.fn(), findMyPendingRequest: vi.fn() }));
vi.mock('@/lib/accessRequests', () => ({
  MAX_ACCESS_MESSAGE: 500,
  requestAccess: api.requestAccess,
  findMyPendingRequest: api.findMyPendingRequest,
}));

import { AccessDenied } from './AccessDenied';

const renderIt = (area?: 'technician' | 'staff' | 'page') =>
  render(
    <MemoryRouter initialEntries={['/tech/jobs?x=1']}>
      <AccessDenied area={area} />
    </MemoryRouter>,
  );

beforeEach(() => {
  api.findMyPendingRequest.mockResolvedValue(null);
  api.requestAccess.mockResolvedValue({ ok: true });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AccessDenied', () => {
  it('lets a team member request access for the exact path and confirms', async () => {
    authState.value = { isOwner: false, profile: { role: 'member', full_name: 'Sam' }, teamMember: { id: 't1' } };
    renderIt('technician');
    expect(screen.getByRole('heading', { name: 'Access denied' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/add a note/i), { target: { value: 'Need it for on-call' } });
    fireEvent.click(screen.getByRole('button', { name: 'Request access' }));
    await waitFor(() =>
      expect(api.requestAccess).toHaveBeenCalledWith({ path: '/tech/jobs?x=1', area: 'technician', message: 'Need it for on-call', name: 'Sam' }),
    );
    expect(await screen.findByText(/request sent/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request access' })).toBeNull();
  });

  it('owners/admins and staff-only areas never get a request form', () => {
    authState.value = { isOwner: true, profile: { role: 'owner' }, teamMember: null };
    renderIt('technician');
    expect(screen.queryByRole('button', { name: 'Request access' })).toBeNull();
    cleanup();
    authState.value = { isOwner: false, profile: { role: 'member' }, teamMember: { id: 't1' } };
    renderIt('staff');
    expect(screen.queryByRole('button', { name: 'Request access' })).toBeNull();
    expect(screen.getByText(/only for Vireek staff/i)).toBeInTheDocument();
  });

  it('shows "already requested" without a form when a pending request exists', async () => {
    authState.value = { isOwner: false, profile: { role: 'member' }, teamMember: { id: 't1' } };
    api.findMyPendingRequest.mockResolvedValue({ id: 'r1' });
    renderIt();
    expect(await screen.findByText(/request sent/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request access' })).toBeNull();
  });

  it('is noindex and tagged 403 for prerender layers', () => {
    authState.value = { isOwner: false, profile: { role: 'member' }, teamMember: { id: 't1' } };
    renderIt();
    expect(document.head.querySelector('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow');
    expect(document.head.querySelector('meta[name="prerender-status-code"]')).toHaveAttribute('content', '403');
  });

  it('surfaces a send failure', async () => {
    authState.value = { isOwner: false, profile: { role: 'member' }, teamMember: { id: 't1' } };
    api.requestAccess.mockResolvedValue({ ok: false, reason: 'failed' });
    renderIt();
    fireEvent.click(screen.getByRole('button', { name: 'Request access' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not send/i);
  });
});
