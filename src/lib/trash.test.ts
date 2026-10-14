import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('@/lib/supabase', () => ({ supabase: { rpc: (...args: unknown[]) => rpc(...args) } }));

import {
  TRASH_MAX_IDS_PER_CALL,
  TRASH_RETENTION_DAYS,
  TrashError,
  canManageTrash,
  canPurgeTrash,
  chunkIds,
  daysUntilPurge,
  fetchTrash,
  fetchTrashCounts,
  purgeRecords,
  restoreRecords,
  softDeleteRecords,
} from '@/lib/trash';

beforeEach(() => rpc.mockReset());

describe('permission gates', () => {
  it('lets the owner and billing-access members manage the trash', () => {
    expect(canManageTrash(true, { can_view_billing: false })).toBe(true);
    expect(canManageTrash(false, { can_view_billing: true })).toBe(true);
    expect(canManageTrash(false, { can_view_billing: false })).toBe(false);
  });

  it('only lets the owner purge', () => {
    expect(canPurgeTrash(true)).toBe(true);
    expect(canPurgeTrash(false)).toBe(false);
  });
});

describe('daysUntilPurge', () => {
  const now = new Date('2027-01-10T12:00:00Z').getTime();
  it('rounds partial days up and never goes negative', () => {
    expect(daysUntilPurge('2027-01-11T00:00:00Z', now)).toBe(1);
    expect(daysUntilPurge('2027-02-09T12:00:00Z', now)).toBe(TRASH_RETENTION_DAYS);
    expect(daysUntilPurge('2027-01-01T00:00:00Z', now)).toBe(0);
    expect(daysUntilPurge('not-a-date', now)).toBe(0);
  });
});

describe('chunkIds', () => {
  it('de-duplicates and splits at the server-side cap', () => {
    const ids = Array.from({ length: TRASH_MAX_IDS_PER_CALL + 1 }, (_, i) => `id-${i}`);
    const chunks = chunkIds([...ids, 'id-0']);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(TRASH_MAX_IDS_PER_CALL);
    expect(chunks[1]).toEqual([`id-${TRASH_MAX_IDS_PER_CALL}`]);
  });
});

describe('softDeleteRecords', () => {
  it('calls the RPC and sums the moved rows across chunks', async () => {
    rpc.mockResolvedValue({ data: 2, error: null });
    const n = await softDeleteRecords('jobs', ['a', 'b']);
    expect(rpc).toHaveBeenCalledWith('soft_delete_records', { p_kind: 'jobs', p_ids: ['a', 'b'] });
    expect(n).toBe(2);
  });

  it('does not call the database for an empty selection', async () => {
    expect(await softDeleteRecords('leads', [])).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('maps permission errors to a TrashError', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'forbidden', code: '42501' } });
    await expect(softDeleteRecords('customers', ['a'])).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('restoreRecords', () => {
  it('aggregates restored and conflict counts', async () => {
    rpc.mockResolvedValue({ data: { restored: 1, conflicts: 1 }, error: null });
    expect(await restoreRecords('customers', ['a', 'b'])).toEqual({ restored: 1, conflicts: 1 });
  });
});

describe('purgeRecords', () => {
  it('surfaces a legal hold distinctly', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'legal_hold_active' } });
    const err = await purgeRecords('invoices', ['a']).catch((e) => e);
    expect(err).toBeInstanceOf(TrashError);
    expect(err.code).toBe('legal_hold');
  });
});

describe('fetchTrash / fetchTrashCounts', () => {
  it('passes filters through and trims the search term', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await fetchTrash({ kind: 'quotes', search: '  smith ', limit: 10, offset: 20 });
    expect(rpc).toHaveBeenCalledWith('list_trash', { p_kind: 'quotes', p_search: 'smith', p_limit: 10, p_offset: 20 });
  });

  it('fills missing kinds with zero and coerces bigint strings', async () => {
    rpc.mockResolvedValue({ data: [{ kind: 'jobs', n: '3' }, { kind: 'bogus', n: 9 }], error: null });
    expect(await fetchTrashCounts()).toEqual({ customers: 0, jobs: 3, quotes: 0, invoices: 0, leads: 0 });
  });
});
