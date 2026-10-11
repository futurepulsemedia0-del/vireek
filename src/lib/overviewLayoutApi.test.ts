import { describe, it, expect, vi, beforeEach } from 'vitest';

const maybeSingle = vi.fn();
const upsert = vi.fn();
const eqDelete = vi.fn();
const eqSelect = vi.fn(() => ({ maybeSingle }));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn(() => ({
      select: () => ({ eq: eqSelect }),
      upsert,
      delete: () => ({ eq: eqDelete }),
    })),
  },
}));

import { deleteOverviewLayout, fetchOverviewLayout, saveOverviewLayout } from './overviewLayoutApi';
import { buildPresetLayout } from './overviewLayout';

beforeEach(() => vi.clearAllMocks());

describe('overviewLayoutApi', () => {
  it('returns the stored layout, or null when none exists', async () => {
    maybeSingle.mockResolvedValueOnce({ data: { layout: { a: 1 } }, error: null });
    expect(await fetchOverviewLayout('u1')).toEqual({ a: 1 });
    expect(eqSelect).toHaveBeenCalledWith('user_id', 'u1');
    maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    expect(await fetchOverviewLayout('u1')).toBeNull();
  });

  it('throws when the read fails', async () => {
    maybeSingle.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    await expect(fetchOverviewLayout('u1')).rejects.toThrow('boom');
  });

  it('upserts keyed on user_id', async () => {
    upsert.mockResolvedValueOnce({ error: null });
    const layout = buildPresetLayout('csr');
    await saveOverviewLayout('u1', layout);
    expect(upsert).toHaveBeenCalledWith(
      { user_id: 'u1', layout, preset: 'csr', schema_version: 1 },
      { onConflict: 'user_id' },
    );
  });

  it('throws when save or delete fails; delete targets only the user row', async () => {
    upsert.mockResolvedValueOnce({ error: { message: 'denied' } });
    await expect(saveOverviewLayout('u1', buildPresetLayout('csr'))).rejects.toThrow('denied');
    eqDelete.mockResolvedValueOnce({ error: null });
    await deleteOverviewLayout('u1');
    expect(eqDelete).toHaveBeenCalledWith('user_id', 'u1');
    eqDelete.mockResolvedValueOnce({ error: { message: 'nope' } });
    await expect(deleteOverviewLayout('u1')).rejects.toThrow('nope');
  });
});
