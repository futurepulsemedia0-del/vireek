import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
const { api } = vi.hoisted(() => ({
  api: {
    fetchDuplicatePairs: vi.fn(),
    fetchDuplicateCounts: vi.fn(),
    fetchRecentMerges: vi.fn(),
    fetchRelatedCounts: vi.fn(),
    mergeRecords: vi.fn(),
    unmergeRecords: vi.fn(),
    dismissPair: vi.fn(),
  },
}));

const auth = { isOwner: true, permissions: { can_view_billing: true } };
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
const toast = vi.fn();
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/components/DashboardNav', () => ({ DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

vi.mock('@/lib/duplicates', async () => {
  const actual = await vi.importActual<typeof import('@/lib/duplicates')>('@/lib/duplicates');
  return { ...actual, ...Object.fromEntries(Object.entries(api).map(([k, fn]) => [k, (...a: unknown[]) => fn(...a)])) };
});

import { DuplicatesPage } from '@/pages/DuplicatesPage';

const pair = {
  key: 'a:b',
  kind: 'customers' as const,
  reasons: ['phone' as const, 'address' as const],
  confidence: 'high' as const,
  score: 95,
  a: { id: 'a', name: 'Jane Smith', phone: '(555) 123-4567', email: null, address: '12 Oak St', created_at: '2026-01-01T00:00:00Z' },
  b: { id: 'b', name: 'jane smith', phone: '555.123.4567', email: 'jane@x.com', address: '12 Oak Street', created_at: '2026-02-01T00:00:00Z' },
};
const recentMerge = {
  id: 'm1', kind: 'customers' as const, survivor_id: 'a', merged_id: 'b', survivor_name: 'Jane Smith', merged_name: 'jane smith',
  merged_at: new Date().toISOString(), expires_at: new Date(Date.now() + 6 * 86_400_000).toISOString(), merged_by_email: 'owner@x.com', moved_total: 3,
};

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  auth.isOwner = true;
  auth.permissions = { can_view_billing: true };
  api.fetchDuplicatePairs.mockResolvedValue({ pairs: [pair], total: 1 });
  api.fetchDuplicateCounts.mockResolvedValue({ customers: 1, leads: 0 });
  api.fetchRecentMerges.mockResolvedValue([]);
  api.fetchRelatedCounts.mockImplementation((_k: string, id: string) => Promise.resolve(id === 'a' ? { calls: 1 } : { calls: 4, equipment: 2 }));
});

describe('DuplicatesPage', () => {
  it('lists likely duplicates with their match reasons', async () => {
    render(<DuplicatesPage />);
    expect(await screen.findByText('Likely duplicate')).toBeInTheDocument();
    expect(screen.getByText('Same phone')).toBeInTheDocument();
    expect(screen.getByText('Same address')).toBeInTheDocument();
  });

  it('shows the empty state when nothing matches', async () => {
    api.fetchDuplicatePairs.mockResolvedValue({ pairs: [], total: 0 });
    render(<DuplicatesPage />);
    expect(await screen.findByText('No duplicate customers found')).toBeInTheDocument();
  });

  it('blocks members without billing access and never queries', async () => {
    auth.isOwner = false;
    auth.permissions = { can_view_billing: false };
    render(<DuplicatesPage />);
    expect(await screen.findByText(/don't have access to duplicates/i)).toBeInTheDocument();
    expect(api.fetchDuplicatePairs).not.toHaveBeenCalled();
  });

  it('offers a retry when loading fails', async () => {
    api.fetchDuplicatePairs.mockRejectedValueOnce(new Error('boom'));
    render(<DuplicatesPage />);
    expect(await screen.findByText("Couldn't load duplicates")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('dismisses a pair as not a duplicate', async () => {
    api.dismissPair.mockResolvedValue(undefined);
    render(<DuplicatesPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Not a duplicate: Jane Smith and jane smith/ }));
    await waitFor(() => expect(api.dismissPair).toHaveBeenCalledWith('customers', 'a', 'b'));
  });

  it('merges into the record with more history, filling gaps from the other', async () => {
    api.mergeRecords.mockResolvedValue({ merge_id: 'm1', moved: { calls: 1 }, skipped: {}, irreversible: [], expires_at: 'x' });
    render(<DuplicatesPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Review and merge/ }));
    // record b has more linked history (6 vs 1), so it becomes primary by default
    const keep = await screen.findByRole('radio', { name: 'Keep jane smith as the primary record' });
    expect(keep).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Merge records' }));
    await waitFor(() => expect(api.mergeRecords).toHaveBeenCalledWith('customers', 'b', 'a', expect.any(Object)));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringContaining('Merged'), 'success'));
  });

  it('shows the server error inside the dialog when a merge fails', async () => {
    const { DuplicatesError } = await import('@/lib/duplicates');
    api.mergeRecords.mockRejectedValue(new DuplicatesError('not_found', 'One of these records no longer exists or was already merged.'));
    render(<DuplicatesPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Review and merge/ }));
    await screen.findAllByRole('radio', { name: /primary record/ });
    fireEvent.click(screen.getByRole('button', { name: 'Merge records' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('no longer exists');
  });

  it('undoes a recent merge after confirmation', async () => {
    api.fetchRecentMerges.mockResolvedValue([recentMerge]);
    api.unmergeRecords.mockResolvedValue({ restored: { calls: 3 }, not_restored: [], kind: 'customers', survivor_id: 'a', merged_id: 'b' });
    render(<DuplicatesPage />);
    fireEvent.click(await screen.findByRole('tab', { name: /Recent merges/ }));
    expect(await screen.findByText('6 days left to undo')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Undo merge of jane smith into Jane Smith/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Undo merge' }));
    await waitFor(() => expect(api.unmergeRecords).toHaveBeenCalledWith('m1'));
  });
});
