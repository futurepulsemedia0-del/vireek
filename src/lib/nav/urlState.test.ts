import { describe, expect, it } from 'vitest';
import { codec, readUrlState, writeUrlState } from '@/lib/nav/urlState';

const schema = {
  q: { ...codec.string('', { resets: ['page'] }) },
  page: codec.int(1, { min: 1, max: 10_000, history: 'push' }),
  sort: codec.oneOf(['recent', 'name'] as const, 'recent'),
  tab: codec.oneOf(['all', 'open'] as const, 'all', { history: 'push' }),
  d: codec.date(''),
};

describe('urlState', () => {
  it('degrades invalid params to defaults', () => {
    const s = readUrlState(schema, new URLSearchParams('page=-4&sort=zzz&d=2026-02-31&tab=open'));
    expect(s).toEqual({ q: '', page: 1, sort: 'recent', tab: 'open', d: '' });
  });
  it('omits defaults and is a no-op when nothing changes', () => {
    const r = writeUrlState(schema, new URLSearchParams('page=2'), { page: 2 });
    expect(r.changed).toBe(false);
    expect(writeUrlState(schema, new URLSearchParams('page=2'), { page: 1 }).params.toString()).toBe('');
  });
  it('replaces for refinements, pushes for places', () => {
    expect(writeUrlState(schema, new URLSearchParams(), { sort: 'name' }).history).toBe('replace');
    expect(writeUrlState(schema, new URLSearchParams(), { tab: 'open' }).history).toBe('push');
  });
  it('resets dependent params', () => {
    expect(writeUrlState(schema, new URLSearchParams('page=4'), { q: 'leak' }).params.toString()).toBe('q=leak');
  });
  it('preserves unrelated params and ignores unknown keys', () => {
    const r = writeUrlState(schema, new URLSearchParams('utm=1'), { sort: 'name' });
    expect(r.params.get('utm')).toBe('1');
  });
});

describe('sort codec', () => {
  const sortSchema = { sort: codec.sort(['name', 'created_at'], null) };
  it('parses key:dir, defaults to asc, rejects unknown keys', () => {
    expect(readUrlState(sortSchema, new URLSearchParams('sort=name:desc')).sort).toEqual({ key: 'name', dir: 'desc' });
    expect(readUrlState(sortSchema, new URLSearchParams('sort=name')).sort).toEqual({ key: 'name', dir: 'asc' });
    expect(readUrlState(sortSchema, new URLSearchParams('sort=evil:desc')).sort).toBeNull();
    expect(readUrlState(sortSchema, new URLSearchParams('sort=name:sideways')).sort).toBeNull();
  });
  it('round-trips and clears on null', () => {
    const r = writeUrlState(sortSchema, new URLSearchParams(), { sort: { key: 'created_at', dir: 'desc' } });
    expect(r.params.get('sort')).toBe('created_at:desc');
    expect(writeUrlState(sortSchema, r.params, { sort: null }).params.toString()).toBe('');
  });
});
