import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
const auth = { isOwner: true, permissions: { can_view_billing: true } };
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/components/DashboardNav', () => ({ DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

const fetchTrash = vi.fn();
const fetchTrashCounts = vi.fn();
const restoreRecords = vi.fn();
vi.mock('@/lib/trash', async () => {
  const actual = await vi.importActual<typeof import('@/lib/trash')>('@/lib/trash');
  return {
    ...actual,
    fetchTrash: (...a: unknown[]) => fetchTrash(...a),
    fetchTrashCounts: (...a: unknown[]) => fetchTrashCounts(...a),
    restoreRecords: (...a: unknown[]) => restoreRecords(...a),
  };
});

import { TrashPage } from '@/pages/TrashPage';

const counts = { customers: 1, jobs: 0, quotes: 0, invoices: 0, leads: 0 };
const item = {
  kind: 'customers' as const,
  id: 'c1',
  title: 'Jane Smith',
  subtitle: '555-0100',
  deleted_at: new Date().toISOString(),
  deleted_by_email: 'owner@example.com',
  purge_at: new Date(Date.now() + 29 * 86_400_000).toISOString(),
};

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  auth.isOwner = true;
  auth.permissions = { can_view_billing: true };
  fetchTrashCounts.mockResolvedValue(counts);
});

describe('TrashPage', () => {
  it('shows the empty state when nothing is deleted', async () => {
    fetchTrash.mockResolvedValue([]);
    render(<TrashPage />);
    expect(await screen.findByText('Trash is empty')).toBeInTheDocument();
  });

  it('lists deleted items and restores one', async () => {
    fetchTrash.mockResolvedValue([item]);
    restoreRecords.mockResolvedValue({ restored: 1, conflicts: 0 });
    render(<TrashPage />);
    expect(await screen.findByText('Jane Smith')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Restore Jane Smith' }));
    await waitFor(() => expect(restoreRecords).toHaveBeenCalledWith('customers', ['c1']));
  });

  it('blocks team members without billing access and never queries', async () => {
    auth.isOwner = false;
    auth.permissions = { can_view_billing: false };
    render(<TrashPage />);
    expect(await screen.findByText(/don't have access to the trash/i)).toBeInTheDocument();
    expect(fetchTrash).not.toHaveBeenCalled();
  });

  it('hides "Delete forever" from non-owners', async () => {
    auth.isOwner = false;
    fetchTrash.mockResolvedValue([item]);
    render(<TrashPage />);
    await screen.findByText('Jane Smith');
    expect(screen.queryByRole('button', { name: /forever/i })).not.toBeInTheDocument();
  });

  it('offers a retry when loading fails', async () => {
    fetchTrash.mockRejectedValueOnce(new Error('boom'));
    render(<TrashPage />);
    expect(await screen.findByText("Couldn't load the trash")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
