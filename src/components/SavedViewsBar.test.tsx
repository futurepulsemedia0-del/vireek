import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  listSavedViews: vi.fn(),
  createSavedView: vi.fn(),
  updateSavedView: vi.fn(),
  deleteSavedView: vi.fn(),
  setDefaultSavedView: vi.fn(),
  toast: vi.fn(),
  auth: { user: { id: 'me' }, isOwner: false },
}));

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/savedViews', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/savedViews')>()),
  listSavedViews: mocks.listSavedViews,
  createSavedView: mocks.createSavedView,
  updateSavedView: mocks.updateSavedView,
  deleteSavedView: mocks.deleteSavedView,
  setDefaultSavedView: mocks.setDefaultSavedView,
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => mocks.auth }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast: mocks.toast }) }));

import { SavedViewsBar } from '@/components/SavedViewsBar';
import type { SavedView } from '@/lib/savedViews';

const view = (over: Partial<SavedView> = {}): SavedView => ({
  id: 'v1',
  user_id: 'me',
  owner_id: 'acct',
  page: 'jobs',
  name: 'Emergencies',
  filters: { statusFilter: 'open' },
  sort: { key: 'name', dir: 'asc' },
  columns: ['service'],
  is_shared: false,
  is_default: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  ...over,
});

const renderBar = (props: Partial<React.ComponentProps<typeof SavedViewsBar>> = {}) => {
  const onApply = vi.fn();
  const utils = render(<SavedViewsBar page="jobs" currentFilters={{ statusFilter: 'all' }} onApply={onApply} {...props} />);
  return { onApply, ...utils };
};

const openMenu = async () => {
  fireEvent.click(screen.getByRole('button', { name: /views/i }));
  await waitFor(() => expect(screen.queryByText(/loading views/i)).not.toBeInTheDocument());
};

beforeEach(() => {
  Object.values(mocks).forEach((m) => typeof m === 'function' && 'mockReset' in m && (m as ReturnType<typeof vi.fn>).mockReset());
  mocks.auth.isOwner = false;
  mocks.listSavedViews.mockResolvedValue([]);
});

describe('SavedViewsBar', () => {
  it('shows an empty state', async () => {
    renderBar();
    await openMenu();
    expect(screen.getByText(/no saved views yet/i)).toBeInTheDocument();
  });

  it('separates my views from views shared by teammates', async () => {
    mocks.listSavedViews.mockResolvedValue([view(), view({ id: 'v2', user_id: 'mate', name: 'Team board', is_shared: true })]);
    renderBar();
    await openMenu();
    expect(screen.getByText('My views')).toBeInTheDocument();
    expect(screen.getByText('Shared with team')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Emergencies' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Team board' })).toBeInTheDocument();
  });

  it('applies filters, sort and columns when a view is picked', async () => {
    mocks.listSavedViews.mockResolvedValue([view()]);
    const { onApply } = renderBar();
    await openMenu();
    fireEvent.click(screen.getByRole('button', { name: 'Emergencies' }));
    expect(onApply).toHaveBeenCalledWith({ statusFilter: 'open' }, { sort: { key: 'name', dir: 'asc' }, columns: ['service'] });
    expect(screen.queryByRole('dialog', { name: /saved views/i })).not.toBeInTheDocument();
  });

  it('opens on my default view exactly once', async () => {
    mocks.listSavedViews.mockResolvedValue([view({ is_default: true }), view({ id: 'v3', name: 'Mate default', user_id: 'mate', is_default: true })]);
    const { onApply, rerender } = renderBar();
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    expect(onApply).toHaveBeenCalledWith({ statusFilter: 'open' }, { sort: { key: 'name', dir: 'asc' }, columns: ['service'] });
    rerender(<SavedViewsBar page="jobs" currentFilters={{ statusFilter: 'open' }} onApply={onApply} />);
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it('does not auto-apply when applyDefaultOnMount is false', async () => {
    mocks.listSavedViews.mockResolvedValue([view({ is_default: true })]);
    const { onApply } = renderBar({ applyDefaultOnMount: false });
    await waitFor(() => expect(mocks.listSavedViews).toHaveBeenCalled());
    expect(onApply).not.toHaveBeenCalled();
  });

  it('flags an applied view as modified when the page state drifts', async () => {
    mocks.listSavedViews.mockResolvedValue([view({ is_default: true })]);
    const { onApply, rerender } = renderBar();
    await waitFor(() => expect(onApply).toHaveBeenCalled());
    rerender(<SavedViewsBar page="jobs" currentFilters={{ statusFilter: 'open' }} currentSort={{ key: 'name', dir: 'asc' }} currentColumns={['service']} onApply={onApply} />);
    expect(screen.queryByLabelText(/changed since saved/i)).not.toBeInTheDocument();
    rerender(<SavedViewsBar page="jobs" currentFilters={{ statusFilter: 'done' }} currentSort={{ key: 'name', dir: 'asc' }} currentColumns={['service']} onApply={onApply} />);
    expect(screen.getByLabelText(/changed since saved/i)).toBeInTheDocument();
  });

  it('saves the current state, optionally shared', async () => {
    const created = view({ id: 'new', name: 'Hot' });
    mocks.createSavedView.mockResolvedValue(created);
    mocks.listSavedViews.mockResolvedValueOnce([]).mockResolvedValueOnce([created]);
    renderBar({ currentSort: { key: 'k', dir: 'desc' }, currentColumns: ['a'] });
    await openMenu();
    fireEvent.click(screen.getByRole('button', { name: /save current view/i }));
    fireEvent.change(screen.getByLabelText('View name'), { target: { value: '  Hot ' } });
    fireEvent.click(screen.getByLabelText(/share with my team/i));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocks.createSavedView).toHaveBeenCalledTimes(1));
    expect(mocks.createSavedView).toHaveBeenCalledWith(
      'jobs',
      '  Hot ',
      { filters: { statusFilter: 'all' }, sort: { key: 'k', dir: 'desc' }, columns: ['a'] },
      { shared: true },
    );
    expect(mocks.setDefaultSavedView).not.toHaveBeenCalled();
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('View saved.', 'success'));
  });

  it('sets the new view as default when asked', async () => {
    const created = view({ id: 'new', name: 'Hot' });
    mocks.createSavedView.mockResolvedValue(created);
    mocks.setDefaultSavedView.mockResolvedValue(undefined);
    renderBar();
    await openMenu();
    fireEvent.click(screen.getByRole('button', { name: /save current view/i }));
    fireEvent.change(screen.getByLabelText('View name'), { target: { value: 'Hot' } });
    fireEvent.click(screen.getByLabelText(/open this view by default/i));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocks.setDefaultSavedView).toHaveBeenCalledWith('new', true));
  });

  it('blocks empty and duplicate names without calling the API', async () => {
    mocks.listSavedViews.mockResolvedValue([view()]);
    renderBar();
    await openMenu();
    fireEvent.click(screen.getByRole('button', { name: /save current view/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/name/i);
    fireEvent.change(screen.getByLabelText('View name'), { target: { value: 'emergencies' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/already/i);
    expect(mocks.createSavedView).not.toHaveBeenCalled();
  });

  it('toggles sharing on my own view', async () => {
    mocks.listSavedViews.mockResolvedValue([view()]);
    mocks.updateSavedView.mockResolvedValue(view({ is_shared: true }));
    renderBar();
    await openMenu();
    fireEvent.click(screen.getByRole('button', { name: /share emergencies with team/i }));
    await waitFor(() => expect(mocks.updateSavedView).toHaveBeenCalledWith('v1', { is_shared: true }));
  });

  it('toggles my default then reloads the list', async () => {
    mocks.listSavedViews.mockResolvedValue([view()]);
    mocks.setDefaultSavedView.mockResolvedValue(undefined);
    renderBar({ applyDefaultOnMount: false });
    await openMenu();
    fireEvent.click(screen.getByRole('button', { name: /set emergencies as default/i }));
    await waitFor(() => expect(mocks.setDefaultSavedView).toHaveBeenCalledWith('v1', true));
    await waitFor(() => expect(mocks.listSavedViews).toHaveBeenCalledTimes(2));
  });

  it('overwrites a view with the current state', async () => {
    mocks.listSavedViews.mockResolvedValue([view()]);
    mocks.updateSavedView.mockResolvedValue(view({ filters: { statusFilter: 'all' } }));
    renderBar({ currentSort: null, currentColumns: null });
    await openMenu();
    fireEvent.click(screen.getByRole('button', { name: /update emergencies with current filters/i }));
    await waitFor(() =>
      expect(mocks.updateSavedView).toHaveBeenCalledWith('v1', { filters: { statusFilter: 'all' }, sort: null, columns: null }),
    );
  });

  it('requires confirmation before deleting', async () => {
    mocks.listSavedViews.mockResolvedValue([view()]);
    mocks.deleteSavedView.mockResolvedValue(undefined);
    renderBar();
    await openMenu();
    fireEvent.click(screen.getByRole('button', { name: /delete emergencies/i }));
    expect(mocks.deleteSavedView).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    await waitFor(() => expect(mocks.deleteSavedView).toHaveBeenCalledWith('v1'));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Emergencies' })).not.toBeInTheDocument());
  });

  it("lets teammates copy but not delete someone else's shared view", async () => {
    mocks.listSavedViews.mockResolvedValue([view({ id: 'v2', user_id: 'mate', name: 'Team board', is_shared: true })]);
    mocks.createSavedView.mockResolvedValue(view({ id: 'copy', name: 'Team board (copy)' }));
    renderBar();
    await openMenu();
    expect(screen.queryByRole('button', { name: /delete team board/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /share team board/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /save a copy of team board/i }));
    await waitFor(() =>
      expect(mocks.createSavedView).toHaveBeenCalledWith('jobs', 'Team board (copy)', { filters: { statusFilter: 'open' }, sort: { key: 'name', dir: 'asc' }, columns: ['service'] }),
    );
  });

  it('lets the account owner remove a teammate\'s shared view', async () => {
    mocks.auth.isOwner = true;
    mocks.listSavedViews.mockResolvedValue([view({ id: 'v2', user_id: 'mate', name: 'Team board', is_shared: true })]);
    renderBar();
    await openMenu();
    expect(screen.getByRole('button', { name: /delete team board/i })).toBeInTheDocument();
  });

  it('reports a load failure without crashing', async () => {
    mocks.listSavedViews.mockRejectedValue(new Error('down'));
    renderBar();
    await openMenu();
    expect(screen.getByText(/could not load saved views/i)).toBeInTheDocument();
  });
});
