import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ supabase: { from: mocks.from, rpc: mocks.rpc } }));

import {
  copyName,
  createSavedView,
  deleteSavedView,
  listSavedViews,
  normalizeColumns,
  normalizeSort,
  normalizeViewName,
  orderViews,
  parseSavedViewRow,
  pickDefaultView,
  sanitizeFilters,
  setDefaultSavedView,
  stableStringify,
  updateSavedView,
  validateViewName,
  viewMatchesState,
  type SavedView,
} from '@/lib/savedViews';

const view = (over: Partial<SavedView> = {}): SavedView => ({
  id: 'v1',
  user_id: 'me',
  owner_id: 'acct',
  page: 'jobs',
  name: 'Emergencies',
  filters: { statusFilter: 'open' },
  sort: null,
  columns: null,
  is_shared: false,
  is_default: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  ...over,
});

/** Chainable Supabase query double that resolves to `result`. */
function query(result: { data?: unknown; error?: unknown }) {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'order']) q[m] = vi.fn(() => q);
  q.single = vi.fn(() => Promise.resolve(result));
  q.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(result).then(resolve, reject);
  return q as Record<string, ReturnType<typeof vi.fn>>;
}

beforeEach(() => {
  mocks.from.mockReset();
  mocks.rpc.mockReset();
});

describe('normalizers', () => {
  it('normalizeSort accepts only {key, dir}', () => {
    expect(normalizeSort({ key: 'name', dir: 'asc' })).toEqual({ key: 'name', dir: 'asc' });
    expect(normalizeSort({ key: 'name', dir: 'sideways' })).toBeNull();
    expect(normalizeSort({ key: '', dir: 'asc' })).toBeNull();
    expect(normalizeSort('name')).toBeNull();
    expect(normalizeSort(null)).toBeNull();
  });

  it('normalizeColumns drops junk and duplicates', () => {
    expect(normalizeColumns(['a', 'b', 'a', 3, '', null])).toEqual(['a', 'b']);
    expect(normalizeColumns('a')).toBeNull();
    expect(normalizeColumns(null)).toBeNull();
    expect(normalizeColumns([])).toEqual([]);
  });

  it('parseSavedViewRow survives malformed jsonb', () => {
    const v = parseSavedViewRow({ id: 'x', user_id: 'u', page: 'jobs', name: 'N', filters: 'oops', sort: 5, columns: {} });
    expect(v.filters).toEqual({});
    expect(v.sort).toBeNull();
    expect(v.columns).toBeNull();
    expect(v.is_shared).toBe(false);
    expect(v.owner_id).toBe('u');
  });
});

describe('names', () => {
  it('normalizes whitespace', () => {
    expect(normalizeViewName('  Hot   leads \n')).toBe('Hot leads');
  });

  it('rejects empty, too long and duplicate (case-insensitive) names', () => {
    expect(validateViewName('   ', [])).toMatch(/name/i);
    expect(validateViewName('x'.repeat(61), [])).toMatch(/60/);
    expect(validateViewName('emergencies', [view()])).toMatch(/already/i);
    expect(validateViewName('Emergencies', [view()], 'v1')).toBeNull();
    expect(validateViewName('Fresh', [view()])).toBeNull();
  });

  it('copyName finds a free name', () => {
    expect(copyName('Emergencies', [])).toBe('Emergencies (copy)');
    expect(copyName('Emergencies', [view({ name: 'Emergencies (copy)' })])).toBe('Emergencies (copy 2)');
    expect(copyName('x'.repeat(80), []).length).toBeLessThanOrEqual(60);
  });
});

describe('filters', () => {
  it('sanitizeFilters strips undefined and rejects oversized payloads', () => {
    expect(sanitizeFilters({ a: 1, b: undefined, c: 'x' })).toEqual({ a: 1, c: 'x' });
    expect(sanitizeFilters(null)).toEqual({});
    expect(() => sanitizeFilters({ blob: 'x'.repeat(20_000) })).toThrow(/too large/i);
  });

  it('stableStringify ignores key order', () => {
    expect(stableStringify({ a: 1, b: { d: 1, c: 2 } })).toBe(stableStringify({ b: { c: 2, d: 1 }, a: 1 }));
  });

  it('viewMatchesState compares filters, sort and columns', () => {
    const v = view({ filters: { a: 1, b: 2 }, sort: { key: 'k', dir: 'asc' }, columns: ['x', 'y'] });
    expect(viewMatchesState(v, { filters: { b: 2, a: 1 }, sort: { key: 'k', dir: 'asc' }, columns: ['y', 'x'] })).toBe(true);
    expect(viewMatchesState(v, { filters: { a: 1, b: 3 }, sort: { key: 'k', dir: 'asc' }, columns: ['x', 'y'] })).toBe(false);
    expect(viewMatchesState(v, { filters: { a: 1, b: 2 }, sort: { key: 'k', dir: 'desc' }, columns: ['x', 'y'] })).toBe(false);
    expect(viewMatchesState(v, { filters: { a: 1, b: 2 }, sort: { key: 'k', dir: 'asc' }, columns: ['x'] })).toBe(false);
    expect(viewMatchesState(view({ filters: {} }), { filters: {} })).toBe(true);
  });
});

describe('ordering and defaults', () => {
  const list = [
    view({ id: 'a', name: 'Zeta' }),
    view({ id: 'b', name: 'Alpha', user_id: 'mate', is_shared: true }),
    view({ id: 'c', name: 'Mid', is_default: true }),
    view({ id: 'd', name: 'Beta' }),
  ];

  it('orders default first, then mine, then shared', () => {
    expect(orderViews(list, 'me').map((v) => v.id)).toEqual(['c', 'd', 'a', 'b']);
  });

  it('pickDefaultView only returns MY default', () => {
    expect(pickDefaultView(list, 'me')?.id).toBe('c');
    expect(pickDefaultView(list, 'mate')).toBeNull();
    expect(pickDefaultView(list, undefined)).toBeNull();
    expect(pickDefaultView([view({ user_id: 'mate', is_default: true })], 'me')).toBeNull();
  });
});

describe('data access', () => {
  it('listSavedViews filters by page and parses rows', async () => {
    const q = query({ data: [{ id: '1', user_id: 'me', page: 'quotes', name: 'N', filters: { a: 1 } }], error: null });
    mocks.from.mockReturnValue(q);
    const out = await listSavedViews('quotes');
    expect(mocks.from).toHaveBeenCalledWith('saved_views');
    expect(q.eq).toHaveBeenCalledWith('page', 'quotes');
    expect(out[0].filters).toEqual({ a: 1 });
    expect(out[0].sort).toBeNull();
  });

  it('listSavedViews throws on error', async () => {
    mocks.from.mockReturnValue(query({ data: null, error: new Error('boom') }));
    await expect(listSavedViews('jobs')).rejects.toThrow('boom');
  });

  it('createSavedView sends a sanitized payload', async () => {
    const q = query({ data: { id: '1', user_id: 'me', page: 'jobs', name: 'Hot' }, error: null });
    mocks.from.mockReturnValue(q);
    await createSavedView('jobs', '  Hot  ', { filters: { a: 1, b: undefined }, sort: { key: 'k', dir: 'desc' }, columns: ['x'] }, { shared: true });
    expect(q.insert).toHaveBeenCalledWith({
      page: 'jobs',
      name: 'Hot',
      filters: { a: 1 },
      sort: { key: 'k', dir: 'desc' },
      columns: ['x'],
      is_shared: true,
    });
  });

  it('createSavedView defaults to private with null sort/columns', async () => {
    const q = query({ data: { id: '1', user_id: 'me', page: 'jobs', name: 'Hot' }, error: null });
    mocks.from.mockReturnValue(q);
    await createSavedView('jobs', 'Hot', { filters: {} });
    expect(q.insert).toHaveBeenCalledWith(expect.objectContaining({ is_shared: false, sort: null, columns: null }));
  });

  it('updateSavedView only sends provided fields', async () => {
    const q = query({ data: { id: '1', user_id: 'me', page: 'jobs', name: 'New', is_shared: true }, error: null });
    mocks.from.mockReturnValue(q);
    const out = await updateSavedView('1', { is_shared: true });
    expect(q.update).toHaveBeenCalledWith({ is_shared: true });
    expect(q.eq).toHaveBeenCalledWith('id', '1');
    expect(out.is_shared).toBe(true);
  });

  it('setDefaultSavedView calls the atomic RPC', async () => {
    mocks.rpc.mockResolvedValue({ error: null });
    await setDefaultSavedView('9', true);
    expect(mocks.rpc).toHaveBeenCalledWith('set_saved_view_default', { p_id: '9', p_default: true });
    mocks.rpc.mockResolvedValue({ error: new Error('nope') });
    await expect(setDefaultSavedView('9', false)).rejects.toThrow('nope');
  });

  it('deleteSavedView deletes by id and surfaces errors', async () => {
    const q = query({ error: null });
    mocks.from.mockReturnValue(q);
    await deleteSavedView('7');
    expect(q.delete).toHaveBeenCalled();
    expect(q.eq).toHaveBeenCalledWith('id', '7');
    mocks.from.mockReturnValue(query({ error: new Error('denied') }));
    await expect(deleteSavedView('7')).rejects.toThrow('denied');
  });
});
