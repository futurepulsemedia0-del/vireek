import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('@/lib/supabase', () => ({ supabase: { rpc: (...args: unknown[]) => rpc(...args) } }));

import {
  DuplicatesError,
  canManageDuplicates,
  changedChoices,
  daysLeftToUnmerge,
  defaultChoices,
  dismissPair,
  fetchDuplicateCounts,
  fetchDuplicatePairs,
  fetchRecentMerges,
  humanizeTable,
  mergeRecords,
  pickDefaultPrimary,
  resolveValue,
  totalMoved,
  unmergeRecords,
  type DuplicateRecord,
} from '@/lib/duplicates';

beforeEach(() => rpc.mockReset());

const rec = (over: Partial<DuplicateRecord> = {}): DuplicateRecord => ({
  id: 'x', name: 'Jane Smith', phone: null, email: null, address: null, created_at: '2026-01-01T00:00:00Z', ...over,
});

describe('canManageDuplicates', () => {
  it('allows the owner and billing-access members only', () => {
    expect(canManageDuplicates(true, { can_view_billing: false })).toBe(true);
    expect(canManageDuplicates(false, { can_view_billing: true })).toBe(true);
    expect(canManageDuplicates(false, { can_view_billing: false })).toBe(false);
  });
});

describe('defaultChoices', () => {
  it('keeps the primary value but fills its gaps from the other record', () => {
    const c = defaultChoices('customers', rec({ phone: '555', email: null }), rec({ phone: '999', email: 'j@x.com' }));
    expect(c.phone).toBe('survivor');
    expect(c.email).toBe('merged');
  });

  it('keeps both versions of differing notes on leads only', () => {
    const c = defaultChoices('leads', rec({ notes: 'A' }), rec({ notes: 'B' }));
    expect(c.notes).toBe('both');
    expect(defaultChoices('leads', rec({ notes: 'A' }), rec({ notes: ' A ' })).notes).toBe('survivor');
  });
});

describe('changedChoices / resolveValue', () => {
  it('sends only choices that change the primary', () => {
    expect(changedChoices({ name: 'survivor', email: 'merged', notes: 'both' })).toEqual({ email: 'merged', notes: 'both' });
  });

  it('resolves each choice to the stored value', () => {
    expect(resolveValue('survivor', 'a', 'b')).toBe('a');
    expect(resolveValue('merged', 'a', 'b')).toBe('b');
    expect(resolveValue('both', 'a', 'b')).toBe('a\n\nb');
    expect(resolveValue('merged', 'a', '  ')).toBeNull();
  });
});

describe('pickDefaultPrimary', () => {
  it('prefers the record with more history, then the older one', () => {
    const older = rec({ id: 'a', created_at: '2025-01-01T00:00:00Z' });
    const newer = rec({ id: 'b', created_at: '2026-01-01T00:00:00Z' });
    expect(pickDefaultPrimary(older, newer, { calls: 1 }, { calls: 5 })).toBe('b');
    expect(pickDefaultPrimary(older, newer, { calls: 2 }, { calls: 2 })).toBe('a');
    expect(pickDefaultPrimary(newer, older, null, null)).toBe('b');
  });
});

describe('small helpers', () => {
  it('counts days left to undo, never negative', () => {
    const now = new Date('2027-01-10T12:00:00Z').getTime();
    expect(daysLeftToUnmerge('2027-01-17T12:00:00Z', now)).toBe(7);
    expect(daysLeftToUnmerge('2027-01-10T13:00:00Z', now)).toBe(1);
    expect(daysLeftToUnmerge('2027-01-01T00:00:00Z', now)).toBe(0);
  });

  it('humanizes table names and totals moved rows', () => {
    expect(humanizeTable('home_service_passports')).toBe('Home service passports');
    expect(totalMoved({ calls: 2, jobs: 3 })).toBe(5);
  });
});

describe('rpc wrappers', () => {
  it('maps pair rows and reads the total from the first row', async () => {
    rpc.mockResolvedValue({
      data: [{ kind: 'customers', a_id: 'a', b_id: 'b', reasons: ['phone'], confidence: 'high', score: 70, a: rec({ id: 'a' }), b: rec({ id: 'b' }), total_count: '3' }],
      error: null,
    });
    const { pairs, total } = await fetchDuplicatePairs('customers', 10, 0);
    expect(rpc).toHaveBeenCalledWith('find_duplicate_pairs', { p_kind: 'customers', p_limit: 10, p_offset: 0 });
    expect(total).toBe(3);
    expect(pairs[0]).toMatchObject({ key: 'a:b', confidence: 'high', reasons: ['phone'] });
  });

  it('returns zero when there are no pairs', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    expect(await fetchDuplicatePairs('leads')).toEqual({ pairs: [], total: 0 });
  });

  it('coerces counts and ignores unknown kinds', async () => {
    rpc.mockResolvedValue({ data: [{ kind: 'customers', n: '4' }, { kind: 'bogus', n: 9 }], error: null });
    expect(await fetchDuplicateCounts()).toEqual({ customers: 4, leads: 0 });
  });

  it('merges with only the changed field choices', async () => {
    rpc.mockResolvedValue({ data: { merge_id: 'm1', moved: { calls: 2 }, skipped: {}, irreversible: [], expires_at: 'x' }, error: null });
    await mergeRecords('customers', 'keep', 'drop', { name: 'survivor', email: 'merged' });
    expect(rpc).toHaveBeenCalledWith('merge_records', { p_kind: 'customers', p_survivor: 'keep', p_merged: 'drop', p_choices: { email: 'merged' } });
  });

  it('maps server errors to typed DuplicatesError codes', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'merge_window_closed' } });
    await expect(unmergeRecords('m1')).rejects.toMatchObject({ code: 'window_closed' });
    rpc.mockResolvedValue({ data: null, error: { message: 'unmerge_conflict' } });
    await expect(unmergeRecords('m1')).rejects.toMatchObject({ code: 'unmerge_conflict' });
    rpc.mockResolvedValue({ data: null, error: { message: 'forbidden', code: '42501' } });
    const err = await dismissPair('leads', 'a', 'b').catch((e) => e);
    expect(err).toBeInstanceOf(DuplicatesError);
    expect(err.code).toBe('forbidden');
  });

  it('coerces moved_total on recent merges', async () => {
    rpc.mockResolvedValue({ data: [{ id: 'm', kind: 'customers', moved_total: '5' }], error: null });
    expect((await fetchRecentMerges())[0].moved_total).toBe(5);
  });
});
