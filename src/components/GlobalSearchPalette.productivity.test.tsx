import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
vi.mock('react-i18next', async () => (await import('@/test/i18nMock')).reactI18nextMock);
vi.mock('@/components/operator/OperatorPanel', () => ({
  OperatorPanel: ({ instruction }: { instruction: string }) => <div data-testid="operator">{instruction}</div>,
}));

import { GlobalSearchPalette } from './GlobalSearchPalette';
import { __resetShortcutBusForTests } from '@/lib/shortcuts/useShortcuts';
import { shortcutStore } from '@/lib/shortcuts/store';

function Probe() {
  const loc = useLocation();
  return <div data-testid="loc">{`${loc.pathname}${loc.search}|${JSON.stringify(loc.state)}`}</div>;
}

const renderPalette = () =>
  render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <GlobalSearchPalette />
      <Probe />
    </MemoryRouter>,
  );

const openPalette = () => fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
const row = (type: string, id: string, title: string) => ({
  entity_type: type, entity_id: id, title, subtitle: null, parent_id: null, status: null, score: 1, created_at: null,
});

describe('GlobalSearchPalette — unified command surface', () => {
  beforeEach(() => {
    rpc.mockReset();
    rpc.mockResolvedValue({ data: [], error: null });
    auth.permissions.can_manage_team = true;
    window.localStorage.clear();
    shortcutStore.setScope('palette-test');
    shortcutStore.resetAll();
  });
  afterEach(() => __resetShortcutBusForTests());

  it('">" lists actions only, never calls the server, and shows a scope chip', async () => {
    renderPalette();
    openPalette();
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: '>' } });
    expect(await screen.findByRole('option', { name: /New job/ })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Pages' })).not.toBeInTheDocument();
    expect(screen.getByText('Actions')).toBeInTheDocument();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('offers "Invite teammate" to people who can manage the team', async () => {
    renderPalette();
    openPalette();
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: '> invite' } });
    expect(await screen.findByRole('option', { name: /Invite teammate/ })).toBeInTheDocument();
  });

  it('hides "Invite teammate" from people without team permission', async () => {
    auth.permissions.can_manage_team = false;
    renderPalette();
    openPalette();
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: '> invite' } });
    await screen.findByText('No matching actions. Try “new job” or “invite”.');
    expect(screen.queryByRole('option', { name: /Invite teammate/ })).not.toBeInTheDocument();
  });

  it('choosing "Invite teammate" deep-links to the team page with ?invite=1', async () => {
    renderPalette();
    openPalette();
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: '> invite' } });
    fireEvent.click(await screen.findByRole('option', { name: /Invite teammate/ }));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/dashboard/team?invite=1'));
  });

  it('"@" searches people only', async () => {
    renderPalette();
    openPalette();
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: '@sam' } });
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith('global_search', { p_query: 'sam', p_types: ['team', 'customer', 'lead'], p_limit: 24 }),
    );
  });

  it('"#" searches jobs only', async () => {
    rpc.mockResolvedValue({ data: [row('job', 'j1', 'Furnace repair')], error: null });
    renderPalette();
    openPalette();
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: '#furn' } });
    expect(await screen.findByRole('option', { name: /Furnace repair/ })).toBeInTheDocument();
    expect(rpc).toHaveBeenCalledWith('global_search', { p_query: 'furn', p_types: ['job'], p_limit: 24 });
    expect(screen.queryByRole('group', { name: 'Pages' })).not.toBeInTheDocument();
  });

  it('serves a repeated query from the cache (no second round trip)', async () => {
    rpc.mockResolvedValue({ data: [row('customer', 'c1', 'Smith HVAC')], error: null });
    renderPalette();
    openPalette();
    const input = await screen.findByRole('combobox');
    fireEvent.change(input, { target: { value: 'smith' } });
    await screen.findByRole('option', { name: /Smith HVAC/ });
    fireEvent.change(input, { target: { value: 'smit' } });
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
    fireEvent.change(input, { target: { value: 'smith' } });
    expect(await screen.findByRole('option', { name: /Smith HVAC/ })).toBeInTheDocument();
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('does not show people results under the "#" scope after switching scope', async () => {
    rpc.mockResolvedValue({ data: [row('customer', 'c1', 'Smith HVAC')], error: null });
    renderPalette();
    openPalette();
    const input = await screen.findByRole('combobox');
    fireEvent.change(input, { target: { value: '@smith' } });
    await screen.findByRole('option', { name: /Smith HVAC/ });
    rpc.mockResolvedValue({ data: [], error: null });
    fireEvent.change(input, { target: { value: '#smith' } });
    await waitFor(() => expect(screen.queryByRole('option', { name: /Smith HVAC/ })).not.toBeInTheDocument());
  });

  it('shows the live shortcut hint next to commands', async () => {
    renderPalette();
    openPalette();
    expect(await screen.findAllByRole('img', { name: 'C then J' })).not.toHaveLength(0);
  });

  it('"> <instruction>" offers Ask Operator and opens the panel', async () => {
    renderPalette();
    openPalette();
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: '> reschedule tomorrow' } });
    fireEvent.click(await screen.findByRole('option', { name: /Ask Operator/ }));
    expect(await screen.findByTestId('operator')).toHaveTextContent('reschedule tomorrow');
  });

  it('follows a customised open shortcut', async () => {
    shortcutStore.setOverride('palette.toggle', 'mod+j');
    renderPalette();
    openPalette(); // Ctrl+K no longer opens it
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'j', ctrlKey: true });
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('toggles from inside its own input and closes on Escape', async () => {
    renderPalette();
    openPalette();
    const input = await screen.findByRole('combobox');
    fireEvent.keyDown(input, { key: 'k', ctrlKey: true });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    openPalette();
    await screen.findByRole('dialog');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('does not navigate when Enter confirms an IME composition', async () => {
    renderPalette();
    openPalette();
    const input = await screen.findByRole('combobox');
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(screen.getByTestId('loc')).toHaveTextContent('/dashboard|');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('finds a page from a typo', async () => {
    renderPalette();
    openPalette();
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'custmers' } });
    expect(await screen.findByRole('option', { name: /Customers/ })).toBeInTheDocument();
  });
});
