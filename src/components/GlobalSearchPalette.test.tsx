import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';

const { rpc, auth } = vi.hoisted(() => ({
  rpc: vi.fn(),
  auth: {
    user: { id: 'user-1' },
    permissions: { can_view_billing: true, can_manage_team: true, can_edit_business_profile: true },
  },
}));

vi.mock('@/lib/supabase', () => ({ supabase: { rpc: (...args: unknown[]) => rpc(...args) } }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));

import { GlobalSearchPalette } from './GlobalSearchPalette';

function Probe() {
  const loc = useLocation();
  return <div data-testid="loc">{`${loc.pathname}${loc.search}|${JSON.stringify(loc.state)}`}</div>;
}

function renderPalette() {
  return render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <GlobalSearchPalette />
      <Probe />
    </MemoryRouter>,
  );
}

const openPalette = () => fireEvent.keyDown(document, { key: 'k', ctrlKey: true });

const customerRow = {
  entity_type: 'customer',
  entity_id: 'c1',
  title: 'Smith HVAC',
  subtitle: '555-0100',
  parent_id: null,
  status: 'active',
  score: 1.2,
  created_at: null,
};

describe('GlobalSearchPalette', () => {
  beforeEach(() => {
    rpc.mockReset();
    rpc.mockResolvedValue({ data: [], error: null });
    auth.permissions.can_view_billing = true;
    window.localStorage.clear();
  });

  it('is closed until Ctrl/Cmd+K, then toggles', async () => {
    renderPalette();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    openPalette();
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    openPalette();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('shows quick actions and pages when empty, without calling the server', async () => {
    renderPalette();
    openPalette();
    expect(await screen.findByRole('option', { name: /New job/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /New quote/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Customers/ })).toBeInTheDocument();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('"New job" opens the Jobs create modal via navigation state', async () => {
    renderPalette();
    openPalette();
    fireEvent.click(await screen.findByRole('option', { name: /New job/ }));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/dashboard/jobs|{"prefill":{}}'));
  });

  it('does not search for a single character', async () => {
    renderPalette();
    openPalette();
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'a' } });
    expect(await screen.findByText(/at least 2 characters/i)).toBeInTheDocument();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('searches via the RPC, shows grouped results, and Enter opens the top hit', async () => {
    rpc.mockResolvedValue({ data: [customerRow], error: null });
    renderPalette();
    openPalette();
    const input = await screen.findByRole('combobox');
    fireEvent.change(input, { target: { value: '  smith ' } });

    const hit = await screen.findByRole('option', { name: /Smith HVAC/ });
    expect(hit).toBeInTheDocument();
    expect(rpc).toHaveBeenCalledWith('global_search', { p_query: 'smith', p_types: null, p_limit: 24 });
    expect(screen.getByRole('group', { name: 'Customers' })).toBeInTheDocument();

    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/dashboard/customers/c1'));
  });

  it('remembers what you opened and lists it under Recent next time', async () => {
    rpc.mockResolvedValue({ data: [customerRow], error: null });
    renderPalette();
    openPalette();
    const input = await screen.findByRole('combobox');
    fireEvent.change(input, { target: { value: 'smith' } });
    fireEvent.click(await screen.findByRole('option', { name: /Smith HVAC/ }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    openPalette();
    expect(await screen.findByRole('group', { name: 'Recent' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Smith HVAC/ })).toBeInTheDocument();
  });

  it('shows an empty state when nothing matches', async () => {
    renderPalette();
    openPalette();
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'zzzzqq' } });
    expect(await screen.findByText(/No results for/)).toBeInTheDocument();
  });

  it('shows an error with Retry and recovers', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    renderPalette();
    openPalette();
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'smith' } });
    expect(await screen.findByText(/unavailable right now/i)).toBeInTheDocument();

    rpc.mockResolvedValue({ data: [customerRow], error: null });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('option', { name: /Smith HVAC/ })).toBeInTheDocument();
    expect(rpc).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('hides billing pages from users without billing permission', async () => {
    auth.permissions.can_view_billing = false;
    renderPalette();
    openPalette();
    await screen.findByRole('option', { name: /New job/ });
    expect(screen.queryByRole('option', { name: /Invoicing/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /^Billing/ })).not.toBeInTheDocument();
  });

  it('moves the active option with the arrow keys', async () => {
    renderPalette();
    openPalette();
    const input = await screen.findByRole('combobox');
    const options = await screen.findAllByRole('option');
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
  });
});
