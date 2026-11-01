import { describe, expect, it } from 'vitest';
import { buildResolvedPatch, diffThreeWay, planMerge, stableEqual, updateWithVersion, allChoices, type VersionedClient } from './conflict';

function fakeClient(rows: Record<string, unknown>[], opts: { updateError?: unknown; probeError?: unknown } = {}): VersionedClient & { writes: Record<string, unknown>[] } {
  const writes: Record<string, unknown>[] = [];
  const client = {
    writes,
    from() {
      return {
        update(patch: Record<string, unknown>) {
          const filters: [string, unknown][] = [];
          const q: any = {
            eq(c: string, v: unknown) { filters.push([c, v]); return q; },
            select() { return q; },
            then(res: (v: unknown) => unknown) {
              if (opts.updateError) return Promise.resolve({ data: null, error: opts.updateError }).then(res);
              const hit = rows.filter((r) => filters.every(([c, v]) => r[c] === v));
              hit.forEach((r) => { writes.push(patch); Object.assign(r, patch, { row_version: (r.row_version as number) + 1 }); });
              return Promise.resolve({ data: hit.map((r) => ({ ...r })), error: null }).then(res);
            },
          };
          return q;
        },
        select() {
          const filters: [string, unknown][] = [];
          const q: any = {
            eq(c: string, v: unknown) { filters.push([c, v]); return q; },
            select() { return q; },
            then(res: (v: unknown) => unknown) {
              if (opts.probeError) return Promise.resolve({ data: null, error: opts.probeError }).then(res);
              return Promise.resolve({ data: rows.filter((r) => filters.every(([c, v]) => r[c] === v)).map((r) => ({ ...r })), error: null }).then(res);
            },
          };
          return q;
        },
      };
    },
  };
  return client as never;
}

describe('updateWithVersion', () => {
  it('writes when the version matches and strips server-owned fields', async () => {
    const c = fakeClient([{ id: 'a', status: 'open', row_version: 3 }]);
    const r = await updateWithVersion(c, 'jobs', 'a', 3, { status: 'done', row_version: 99, id: 'zzz' });
    expect(r.status).toBe('ok');
    expect(c.writes[0]).toEqual({ status: 'done' });
  });
  it('reports a conflict with the current row and writes nothing', async () => {
    const c = fakeClient([{ id: 'a', status: 'closed', row_version: 5 }]);
    const r = await updateWithVersion(c, 'jobs', 'a', 3, { status: 'done' });
    expect(r).toMatchObject({ status: 'conflict', current: { status: 'closed', row_version: 5 } });
    expect(c.writes).toHaveLength(0);
  });
  it('reports gone when the row no longer exists', async () => {
    expect((await updateWithVersion(fakeClient([]), 'jobs', 'a', 1, { x: 1 })).status).toBe('gone');
  });
  it('surfaces update and probe errors instead of pretending a conflict', async () => {
    expect((await updateWithVersion(fakeClient([], { updateError: { code: '42501' } }), 'jobs', 'a', 1, {})).status).toBe('error');
    expect((await updateWithVersion(fakeClient([{ id: 'a', row_version: 2 }], { probeError: { code: 'x' } }), 'jobs', 'a', 1, {})).status).toBe('error');
  });
  it('two racing writers: exactly one wins', async () => {
    const rows = [{ id: 'a', status: 'open', row_version: 1 }];
    const c = fakeClient(rows);
    const [x, y] = await Promise.all([updateWithVersion(c, 'jobs', 'a', 1, { status: 'x' }), updateWithVersion(c, 'jobs', 'a', 1, { status: 'y' })]);
    expect([x.status, y.status].sort()).toEqual(['conflict', 'ok']);
  });
});

describe('stableEqual', () => {
  it('compares deeply and ignores key order', () => {
    expect(stableEqual({ a: [1, { b: 2 }], c: null }, { c: null, a: [1, { b: 2 }] })).toBe(true);
    expect(stableEqual([1, 2], [2, 1])).toBe(false);
    expect(stableEqual({ a: 1 }, [1])).toBe(false);
    expect(stableEqual(null, {})).toBe(false);
  });
});

describe('three-way diff', () => {
  const base = { id: 1, title: 'A', status: 'open', notes: 'n', tags: ['x'], updated_at: 't0', row_version: 1 };
  it('classifies every state and skips bookkeeping fields', () => {
    const mine = { title: 'A2', status: 'done', tags: ['x', 'y'] };
    const theirs = { ...base, status: 'closed', notes: 'n2', tags: ['x', 'y'], updated_at: 't1', row_version: 2 };
    const d = Object.fromEntries(diffThreeWay(base, mine, theirs).map((x) => [x.field, x.state]));
    expect(d).toEqual({ title: 'mine', status: 'conflict', notes: 'theirs', tags: 'both-same' });
  });
  it('merge plan + resolution never guesses', () => {
    const mine = { title: 'A2', status: 'done' };
    const theirs = { ...base, status: 'closed', row_version: 2 };
    const plan = planMerge(base, mine, theirs);
    expect(plan.conflicts.map((c) => c.field)).toEqual(['status']);
    expect(plan.autoMine).toEqual(['title']);
    expect(buildResolvedPatch(plan, {})).toBeNull();
    expect(buildResolvedPatch(plan, { status: 'mine' })).toEqual({ title: 'A2', status: 'done' });
    expect(buildResolvedPatch(plan, allChoices(plan, 'theirs'))).toEqual({ title: 'A2' }); // theirs already on server
  });
  it('treats a field deleted on the server as theirs-changed', () => {
    const plan = planMerge({ a: 1, b: 2 }, { a: 5 }, { a: 1 });
    expect(plan.diffs.find((x) => x.field === 'b')?.state).toBe('theirs');
  });
});
