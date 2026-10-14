import { describe, it, expect } from 'vitest';
import {
  UNDO_WINDOW_MS, SOFT_DELETE_CHUNK, mergeRestored, planRevert, restoreSoftDeleted, revertUpdates, snapshotRows,
  softDeleteRecords, summarizeRestore, summarizeRevert, type RevertClient, type RevertQuery, type RpcFn,
} from './undoEngine';

describe('undo window', () => {
  it('is exactly 10 seconds', () => expect(UNDO_WINDOW_MS).toBe(10_000));
});

describe('softDeleteRecords', () => {
  it('calls the RPC once, de-duplicates ids and returns the undo id', async () => {
    const calls: { fn: string; args: Record<string, unknown> }[] = [];
    const rpc: RpcFn = async (fn, args) => {
      calls.push({ fn, args });
      return { data: { undo_id: 'u1', deleted: ['a', 'b'], failed: [] }, error: null };
    };
    const r = await softDeleteRecords(rpc, 'jobs', [{ id: 'a', label: 'A' }, { id: 'b' }, { id: 'a', label: 'A' }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].fn).toBe('soft_delete_records');
    expect(calls[0].args.p_ids).toEqual(['a', 'b']);
    expect(r).toMatchObject({ requested: 2, succeeded: ['a', 'b'], undoIds: ['u1'] });
  });

  it('splits large deletes into server-sized chunks, one undo id each', async () => {
    let n = 0;
    const rpc: RpcFn = async (_fn, args) => ({ data: { undo_id: `u${++n}`, deleted: args.p_ids as string[], failed: [] }, error: null });
    const rows = Array.from({ length: SOFT_DELETE_CHUNK + 1 }, (_, i) => ({ id: `id${i}` }));
    const r = await softDeleteRecords(rpc, 'leads', rows);
    expect(r.undoIds).toEqual(['u1', 'u2']);
    expect(r.succeeded).toHaveLength(SOFT_DELETE_CHUNK + 1);
  });

  it('reports per-row server failures without losing the successes', async () => {
    const rpc: RpcFn = async () => ({ data: { undo_id: 'u1', deleted: ['a'], failed: [{ id: 'b', reason: 'locked' }] }, error: null });
    const r = await softDeleteRecords(rpc, 'customers', [{ id: 'a' }, { id: 'b' }]);
    expect(r.succeeded).toEqual(['a']);
    expect(r.failed).toEqual([{ id: 'b', reason: 'locked' }]);
  });

  it('turns an RPC error or a thrown error into failures for that chunk and never throws', async () => {
    const bad: RpcFn = async () => ({ data: null, error: { message: 'not authenticated' } });
    const r1 = await softDeleteRecords(bad, 'calls', [{ id: 'a' }]);
    expect(r1.failed).toEqual([{ id: 'a', reason: 'not authenticated' }]);
    expect(r1.undoIds).toEqual([]);
    const boom: RpcFn = async () => { throw new Error('offline'); };
    const r2 = await softDeleteRecords(boom, 'calls', [{ id: 'a' }]);
    expect(r2.failed[0].reason).toBe('offline');
  });

  it('sends no undo id when nothing was deleted', async () => {
    const rpc: RpcFn = async () => ({ data: { undo_id: null, deleted: [], failed: [{ id: 'a' }] }, error: null });
    const r = await softDeleteRecords(rpc, 'quotes', [{ id: 'a' }]);
    expect(r.undoIds).toEqual([]);
    expect(r.failed[0].reason).toBe('Could not delete.');
  });
});

describe('restoreSoftDeleted', () => {
  it('restores every batch and aggregates results', async () => {
    const rpc: RpcFn = async (_f, args) => ({ data: { restored: [`${args.p_batch_id}-1`], failed: [] }, error: null });
    const r = await restoreSoftDeleted(rpc, ['u1', 'u2']);
    expect(r.restored).toEqual(['u1-1', 'u2-1']);
  });
  it('surfaces a failed batch and keeps going', async () => {
    const rpc: RpcFn = async (_f, args) =>
      args.p_batch_id === 'u1' ? { data: null, error: { message: 'gone' } } : { data: { restored: ['x'], failed: [] }, error: null };
    const r = await restoreSoftDeleted(rpc, ['u1', 'u2']);
    expect(r.restored).toEqual(['x']);
    expect(r.failed).toEqual([{ id: 'u1', reason: 'gone' }]);
  });
  it('summarizes', () => {
    expect(summarizeRestore({ restored: ['a', 'b'], failed: [] }, { singular: 'job', plural: 'jobs' })).toEqual({ ok: true, message: 'Restored 2 jobs.' });
    expect(summarizeRestore({ restored: [], failed: [] }, { singular: 'job', plural: 'jobs' }).ok).toBe(false);
    expect(summarizeRestore({ restored: ['a'], failed: [{ id: 'b', reason: 'dup' }] }, { singular: 'job', plural: 'jobs' }).message).toBe('Restored 1 job. 1 could not be restored (dup).');
  });
});

/** Fake store: rows hold their current value for `field`; the guard decides which rows the revert may touch. */
function fakeRevertClient(store: Record<string, Record<string, unknown>>, reject: string[] = []) {
  const statements: { patch: Record<string, unknown>; ids: string[]; guard?: [string, unknown] }[] = [];
  const client: RevertClient = {
    from: () => ({
      update: (patch) => {
        let ids: string[] = [];
        let guard: [string, unknown] | undefined;
        const q = {
          in: (_c: string, v: string[]) => ((ids = v), q),
          eq: (c: string, v: unknown) => ((guard = [c, v]), q),
          is: (c: string, v: null) => ((guard = [c, v]), q),
          select: () => q,
          then: (res: (v: unknown) => unknown) => {
            statements.push({ patch, ids, guard });
            if (ids.some((i) => reject.includes(i))) return Promise.resolve(res({ data: null, error: { message: 'trigger said no' } }));
            const hit = ids.filter((id) => store[id] && (!guard || store[id][guard[0]] === guard[1]));
            hit.forEach((id) => Object.assign(store[id], patch));
            return Promise.resolve(res({ data: hit.map((id) => ({ id })), error: null }));
          },
        };
        return q as unknown as RevertQuery;
      },
    }),
  };
  return { client, statements, store };
}

describe('snapshot + planRevert', () => {
  it('captures only the keys a row actually carries', () => {
    const snaps = snapshotRows([{ id: 'a', stage: 'new', x: 1 }, { id: 'b' } as { id: string; stage?: string }], ['stage', 'sent_at']);
    expect(snaps).toEqual([{ id: 'a', before: { stage: 'new' } }, { id: 'b', before: {} }]);
  });
  it('groups rows sharing the same previous values and skips empty snapshots', () => {
    const groups = planRevert([
      { id: 'a', before: { status: 'draft' } },
      { id: 'b', before: { status: 'draft' } },
      { id: 'c', before: { status: 'sent' } },
      { id: 'd', before: {} },
    ]);
    expect(groups).toEqual([{ ids: ['a', 'b'], patch: { status: 'draft' } }, { ids: ['c'], patch: { status: 'sent' } }]);
  });
  it('can be limited to the rows that really changed', () => {
    expect(planRevert([{ id: 'a', before: { s: 1 } }, { id: 'b', before: { s: 1 } }], ['b'])).toEqual([{ ids: ['b'], patch: { s: 1 } }]);
  });
  it('treats key order as irrelevant when grouping', () => {
    const g = planRevert([{ id: 'a', before: { x: 1, y: 2 } }, { id: 'b', before: { y: 2, x: 1 } }]);
    expect(g).toHaveLength(1);
  });
});

describe('revertUpdates', () => {
  const noun = { singular: 'job', plural: 'jobs' };

  it('reverts rows that still hold the value we wrote', async () => {
    const { client, store } = fakeRevertClient({ a: { s: 'done' }, b: { s: 'done' } });
    const r = await revertUpdates(client, 'jobs', [{ ids: ['a', 'b'], patch: { s: 'open' } }], { column: 's', value: 'done' });
    expect(r.reverted).toEqual(['a', 'b']);
    expect(store.a.s).toBe('open');
  });

  it('never overwrites a row a teammate changed in the meantime', async () => {
    const { client, store } = fakeRevertClient({ a: { s: 'done' }, b: { s: 'cancelled' } });
    const r = await revertUpdates(client, 'jobs', [{ ids: ['a', 'b'], patch: { s: 'open' } }], { column: 's', value: 'done' });
    expect(r.reverted).toEqual(['a']);
    expect(r.conflicts).toEqual(['b']);
    expect(store.b.s).toBe('cancelled');
    expect(summarizeRevert(r, noun).message).toBe('Undone — 1 job reverted. 1 changed since and was left as is.');
  });

  it('uses IS NULL as the guard when we wrote null (unassign)', async () => {
    const { client, statements } = fakeRevertClient({ a: { assigned_to: null } });
    const r = await revertUpdates(client, 'jobs', [{ ids: ['a'], patch: { assigned_to: 't1' } }], { column: 'assigned_to', value: null });
    expect(r.reverted).toEqual(['a']);
    expect(statements[0].guard).toEqual(['assigned_to', null]);
  });

  it('isolates a failing row by retrying the chunk row-by-row', async () => {
    const { client } = fakeRevertClient({ a: { s: 'done' }, b: { s: 'done' }, c: { s: 'done' } }, ['b']);
    const r = await revertUpdates(client, 'jobs', [{ ids: ['a', 'b', 'c'], patch: { s: 'open' } }], { column: 's', value: 'done' });
    expect(r.reverted.sort()).toEqual(['a', 'c']);
    expect(r.failed).toEqual([{ id: 'b', reason: 'trigger said no' }]);
  });

  it('works without a guard (tags) and issues one statement per distinct previous value', async () => {
    const { client, statements } = fakeRevertClient({ a: { tags: ['x'] }, b: { tags: ['x'] }, c: { tags: ['y'] } });
    const groups = planRevert([{ id: 'a', before: { tags: [] } }, { id: 'b', before: { tags: [] } }, { id: 'c', before: { tags: ['z'] } }]);
    const r = await revertUpdates(client, 'customers', groups);
    expect(statements).toHaveLength(2);
    expect(r.reverted.sort()).toEqual(['a', 'b', 'c']);
  });

  it('reports "Nothing to undo" for an empty result', () => {
    expect(summarizeRevert({ reverted: [], conflicts: [], failed: [] }, noun)).toEqual({ ok: false, message: 'Nothing to undo.' });
  });
});

describe('mergeRestored', () => {
  const rows = [{ id: 'c', created_at: '2027-01-03' }, { id: 'a', created_at: '2027-01-01' }];
  it('re-inserts at the right place for a newest-first list', () => {
    const out = mergeRestored(rows, [{ id: 'b', created_at: '2027-01-02' }], 'created_at');
    expect(out.map((r) => r.id)).toEqual(['c', 'b', 'a']);
  });
  it('is idempotent when a refetch already brought the row back', () => {
    expect(mergeRestored(rows, [{ id: 'a', created_at: '2027-01-01' }], 'created_at')).toBe(rows);
  });
  it('does not blow up on rows missing the order key', () => {
    const out = mergeRestored([{ id: 'x' } as { id: string; created_at?: string }], [{ id: 'y' }], 'created_at');
    expect(out).toHaveLength(2);
  });
});
