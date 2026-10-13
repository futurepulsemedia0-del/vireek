import { describe, it, expect } from 'vitest';
import {
  CHUNK_SIZE, applyRowPatches, bulkDelete, bulkTags, bulkUpdate, chunk, normalizeTag, parseTags, summarize,
  type BulkClient, type BulkQuery,
} from './engine';

interface Call { op: 'update' | 'delete'; table: string; patch?: Record<string, unknown>; ids: string[] }

/** Fake client: rows in `existing` are affected; ids in `reject` make any statement touching them error. */
function fakeClient(existing: string[], reject: string[] = []) {
  const calls: Call[] = [];
  const client: BulkClient = {
    from: (table) => {
      const make = (op: 'update' | 'delete', patch?: Record<string, unknown>): BulkQuery => {
        let ids: string[] = [];
        const q = {
          in: (_c: string, v: string[]) => ((ids = v), q),
          eq: (_c: string, v: string) => ((ids = [v]), q),
          select: () => q,
          then: (res: (v: unknown) => unknown) => {
            calls.push({ op, table, patch, ids });
            if (ids.some((i) => reject.includes(i))) return Promise.resolve(res({ data: null, error: { message: 'blocked by trigger' } }));
            return Promise.resolve(res({ data: ids.filter((i) => existing.includes(i)).map((id) => ({ id })), error: null }));
          },
        };
        return q as unknown as BulkQuery;
      };
      return { update: (p) => make('update', p), delete: () => make('delete') };
    },
  };
  return { client, calls };
}

describe('bulk engine', () => {
  it('chunks ids', () => {
    expect(chunk(Array.from({ length: 250 }, (_, i) => String(i))).map((c) => c.length)).toEqual([CHUNK_SIZE, CHUNK_SIZE, 50]);
  });

  it('updates in one statement per chunk and de-duplicates ids', async () => {
    const { client, calls } = fakeClient(['a', 'b']);
    const r = await bulkUpdate(client, 'leads', ['a', 'b', 'a'], { stage: 'won' });
    expect(calls).toHaveLength(1);
    expect(r.requested).toBe(2);
    expect(r.succeeded).toEqual(['a', 'b']);
  });

  it('reports rows silently filtered by RLS as failures, not successes', async () => {
    const { client } = fakeClient(['a']);
    const r = await bulkUpdate(client, 'calls', ['a', 'ghost'], { status: 'spam' });
    expect(r.succeeded).toEqual(['a']);
    expect(r.failed.map((f) => f.id)).toEqual(['ghost']);
  });

  it('isolates a failing row by retrying the chunk row-by-row', async () => {
    const { client } = fakeClient(['a', 'b', 'c'], ['b']);
    const r = await bulkUpdate(client, 'jobs', ['a', 'b', 'c'], { job_status: 'completed' });
    expect(r.succeeded.sort()).toEqual(['a', 'c']);
    expect(r.failed).toEqual([{ id: 'b', reason: 'blocked by trigger' }]);
  });

  it('skips rows rejected by the guard and never writes them', async () => {
    const { client, calls } = fakeClient(['a', 'b']);
    const r = await bulkUpdate(client, 'jobs', ['a', 'b'], { job_status: 'cancelled' }, { guard: async (id) => (id === 'b' ? 'VIP customer' : null) });
    expect(r.skipped).toEqual([{ id: 'b', reason: 'VIP customer' }]);
    expect(calls.flatMap((c) => c.ids)).toEqual(['a']);
  });

  it('deletes and reports', async () => {
    const { client, calls } = fakeClient(['a', 'b']);
    const r = await bulkDelete(client, 'quotes', ['a', 'b']);
    expect(calls[0].op).toBe('delete');
    expect(r.succeeded).toHaveLength(2);
  });

  it('normalizes and parses tags', () => {
    expect(normalizeTag('  Follow Up ')).toBe('follow-up');
    expect(parseTags('VIP, vip, ,Follow Up')).toEqual(['vip', 'follow-up']);
  });

  it('adds tags, merging per row and grouping identical results into one statement', async () => {
    const { client, calls } = fakeClient(['a', 'b', 'c']);
    const rows = [{ id: 'a', tags: [] }, { id: 'b', tags: [] }, { id: 'c', tags: ['vip'] }];
    const r = await bulkTags(client, 'customers', rows, 'add', ['vip']);
    expect(calls).toHaveLength(1); // a+b share ['vip']; c unchanged -> skipped
    expect(calls[0].ids).toEqual(['a', 'b']);
    expect(r.skipped.map((s) => s.id)).toEqual(['c']);
    expect(applyRowPatches(rows, r.updates)[0].tags).toEqual(['vip']);
  });

  it('removes tags', async () => {
    const { client } = fakeClient(['a']);
    const r = await bulkTags(client, 'jobs', [{ id: 'a', tags: ['x', 'y'] }], 'remove', ['x']);
    expect(r.updates).toEqual([{ id: 'a', patch: { tags: ['y'] } }]);
  });

  it('summarizes results for the toast', () => {
    const msg = summarize({ requested: 3, succeeded: ['a'], failed: [{ id: 'b', reason: 'nope' }], skipped: [{ id: 'c', reason: 'x' }] }, 'Deleted', { singular: 'job', plural: 'jobs' });
    expect(msg).toBe('Deleted 1 job. 1 skipped. 1 failed. (nope)');
  });
});
