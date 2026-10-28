import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

const toast = vi.fn();
const auth = {
  profile: { id: 'owner-1' } as { id: string } | null,
  profileLoading: false,
  isOwner: true,
  permissions: { can_manage_team: true } as Record<string, boolean>,
  teamMember: null as { account_owner_id: string } | null,
};

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/components/DashboardNav', () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const fetchRoleLayouts = vi.fn();
const saveRoleLayout = vi.fn();
const deleteRoleLayout = vi.fn();
vi.mock('@/lib/dashboardRoleLayoutsApi', () => ({
  fetchRoleLayouts: (...a: unknown[]) => fetchRoleLayouts(...a),
  saveRoleLayout: (...a: unknown[]) => saveRoleLayout(...a),
  deleteRoleLayout: (...a: unknown[]) => deleteRoleLayout(...a),
}));

import { DashboardBuilderPage } from './DashboardBuilderPage';
import { buildPresetLayout } from '@/lib/overviewLayout';

const saveButton = () => screen.getByRole('button', { name: /save layout|saving/i });

beforeEach(() => {
  vi.clearAllMocks();
  auth.profile = { id: 'owner-1' };
  auth.profileLoading = false;
  auth.isOwner = true;
  auth.permissions = { can_manage_team: true };
  auth.teamMember = null;
  fetchRoleLayouts.mockResolvedValue([]);
  saveRoleLayout.mockResolvedValue(undefined);
  deleteRoleLayout.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe('DashboardBuilderPage', () => {
  it('shows the default owner dashboard with nothing to save yet', async () => {
    render(<DashboardBuilderPage />);
    expect(await screen.findByRole('tab', { name: /owner/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: 'Hide Quick actions' })).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    expect(fetchRoleLayouts).toHaveBeenCalledWith('owner-1');
  });

  it('blocks people who cannot manage the team', () => {
    auth.isOwner = false;
    auth.permissions = { can_manage_team: false };
    auth.teamMember = { account_owner_id: 'owner-1' };
    render(<DashboardBuilderPage />);
    expect(screen.getByText(/don't have access/i)).toBeInTheDocument();
    expect(fetchRoleLayouts).not.toHaveBeenCalled();
  });

  it('shows an error state and recovers on retry', async () => {
    fetchRoleLayouts.mockRejectedValueOnce(new Error('offline'));
    render(<DashboardBuilderPage />);
    expect(await screen.findByText(/couldn't load dashboard layouts/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('tab', { name: /owner/i })).toBeInTheDocument();
  });

  it("saves to the account owner's row when a team member manages layouts", async () => {
    auth.isOwner = false;
    auth.profile = { id: 'member-1' };
    auth.permissions = { can_manage_team: true };
    auth.teamMember = { account_owner_id: 'owner-9' };
    render(<DashboardBuilderPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Hide Quick actions' }));
    expect(saveButton()).toBeEnabled();
    fireEvent.click(saveButton());
    await waitFor(() => expect(saveRoleLayout).toHaveBeenCalledTimes(1));
    const [ownerId, role, layout] = saveRoleLayout.mock.calls[0];
    expect(ownerId).toBe('owner-9');
    expect(role).toBe('owner');
    expect(layout.items.find((i: { id: string }) => i.id === 'quick_actions').hidden).toBe(true);
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Owner layout saved.', 'success'));
    await waitFor(() => expect(saveButton()).toBeDisabled());
  });

  it('keeps the draft and says so when saving fails', async () => {
    saveRoleLayout.mockRejectedValue(new Error('rls'));
    render(<DashboardBuilderPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Hide Quick actions' }));
    fireEvent.click(saveButton());
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringMatching(/could not save/i), 'error'));
    await waitFor(() => expect(saveButton()).toBeEnabled());
  });

  it('adds a hidden widget back from the available list', async () => {
    render(<DashboardBuilderPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Hide Quick actions' }));
    expect(screen.queryByRole('button', { name: 'Hide Quick actions' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add Quick actions to the Owner dashboard' }));
    expect(screen.getByRole('button', { name: 'Hide Quick actions' })).toBeInTheDocument();
  });

  it("keeps each role's draft when switching tabs and flags unsaved roles", async () => {
    render(<DashboardBuilderPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Hide Quick actions' }));
    fireEvent.click(screen.getByRole('tab', { name: /dispatcher/i }));
    expect(screen.getByRole('img', { name: 'Unsaved changes' })).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    fireEvent.click(screen.getByRole('tab', { name: /owner/i }));
    expect(saveButton()).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Hide Quick actions' })).not.toBeInTheDocument();
  });

  it('refuses to publish a dashboard with no widgets', async () => {
    render(<DashboardBuilderPage />);
    await screen.findByRole('tab', { name: /owner/i });
    let hide = screen.queryAllByRole('button', { name: /^Hide / });
    while (hide.length > 0) {
      fireEvent.click(hide[0]);
      hide = screen.queryAllByRole('button', { name: /^Hide / });
    }
    expect(screen.getByText('No widgets on this dashboard')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/at least one widget/i);
    expect(saveButton()).toBeDisabled();
  });

  it('resets a saved layout only after confirmation', async () => {
    fetchRoleLayouts.mockResolvedValue([{ roleKey: 'owner', layout: { ...buildPresetLayout('owner'), preset: 'custom' }, updatedAt: null }]);
    render(<DashboardBuilderPage />);
    expect(await screen.findByText('Custom')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /reset to default/i }));
    expect(deleteRoleLayout).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Reset layout' }));
    await waitFor(() => expect(deleteRoleLayout).toHaveBeenCalledWith('owner-1', 'owner'));
    await waitFor(() => expect(screen.queryByText('Custom')).not.toBeInTheDocument());
  });

  it('copies another role only after confirmation', async () => {
    render(<DashboardBuilderPage />);
    await screen.findByRole('tab', { name: /owner/i });
    fireEvent.change(screen.getByLabelText(/copy from/i), { target: { value: 'technician' } });
    expect(screen.getAllByRole('button', { name: /^Hide / }).length).toBeGreaterThan(6);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy layout' }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^Hide / })).toHaveLength(6));
    expect(saveButton()).toBeEnabled();
  });
});
