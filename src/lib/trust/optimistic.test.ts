import { describe, expect, it, vi } from 'vitest';
import { createMutationRunner } from './optimistic';

const noSleep = { sleep: () => Promise.resolve(), backoffMs: 0 };
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
};

describe('createMutationRunner', () => {
  it('applies immediately, then keeps the change on success', async () => {
    const r = createMutationRunner(noSleep);
    let state = 'open';
    const onSuccess = vi.fn();
    const p = r.mutate({ key: 'job:1', vars: 'done', apply: (v) => { const prev = state; state = v; return prev; }, run: async () => 'ok', rollback: () => { state = 'BROKEN'; }, onSuccess });
    expect(state).toBe('done'); // optimistic, before the server answered
    const res = await p;
    expect(res).toEqual({ ok: true, data: 'ok' });
    expect(state).toBe('done');
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it('rolls back and returns a classified error on failure', async () => {
    const r = createMutationRunner(noSleep);
    let state = 'open';
    const res = await r.mutate({
      key: 'job:1', vars: 'done',
      apply: (v) => { const prev = state; state = v; return prev; },
      run: async () => { throw { status: 403, message: 'permission denied for table jobs' }; },
      rollback: (snap) => { state = snap; },
    });
    expect(state).toBe('open');
    expect(res.ok).toBe(false);
    if (!res.ok) { expect(res.error.kind).toBe('permission'); expect(res.error.referenceId).toMatch(/^INC-/); }
  });

  it('retries transient errors only, with the configured count', async () => {
    const r = createMutationRunner(noSleep);
    let calls = 0;
    const flaky = await r.mutate({ key: 'a', vars: 0, apply: () => 0, rollback: () => {}, retries: 2, run: async () => { calls += 1; if (calls < 3) throw { status: 503 }; return 'fine'; } });
    expect(flaky).toEqual({ ok: true, data: 'fine' });
    expect(calls).toBe(3);

    let c2 = 0;
    const perm = await r.mutate({ key: 'b', vars: 0, apply: () => 0, rollback: () => {}, retries: 5, run: async () => { c2 += 1; throw { status: 422 }; } });
    expect(perm.ok).toBe(false);
    expect(c2).toBe(1); // validation is never retried
  });

  it('runs same-key mutations in order and fires onSettled exactly once at the end', async () => {
    const r = createMutationRunner(noSleep);
    const order: string[] = [];
    const d1 = deferred<string>();
    const settled = vi.fn();
    const m1 = r.mutate({ key: 'k', vars: 1, apply: () => 0, rollback: () => {}, onSettled: settled, run: async () => { order.push('start1'); const v = await d1.promise; order.push('end1'); return v; } });
    const m2 = r.mutate({ key: 'k', vars: 2, apply: () => 0, rollback: () => {}, onSettled: settled, run: async () => { order.push('start2'); return 'two'; } });
    await Promise.resolve();
    expect(order).toEqual(['start1']); // m2 must wait
    expect(r.pendingCount('k')).toBe(2);
    d1.resolve('one');
    await Promise.all([m1, m2]);
    expect(order).toEqual(['start1', 'end1', 'start2']);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(r.pendingCount('k')).toBe(0);
  });

  it('different keys run in parallel', async () => {
    const r = createMutationRunner(noSleep);
    const d = deferred<string>();
    const started: string[] = [];
    const a = r.mutate({ key: 'x', vars: 0, apply: () => 0, rollback: () => {}, run: async () => { started.push('x'); return d.promise; } });
    const b = r.mutate({ key: 'y', vars: 0, apply: () => 0, rollback: () => {}, run: async () => { started.push('y'); return 'y'; } });
    await b;
    expect(started).toEqual(['x', 'y']);
    d.resolve('x');
    await a;
  });

  it('a failing mutation does not block the next one on the same key', async () => {
    const r = createMutationRunner(noSleep);
    const first = r.mutate({ key: 'k', vars: 0, apply: () => 0, rollback: () => {}, run: async () => { throw { status: 500 }; } });
    const second = r.mutate({ key: 'k', vars: 0, apply: () => 0, rollback: () => {}, run: async () => 'ok' });
    expect((await first).ok).toBe(false);
    expect(await second).toEqual({ ok: true, data: 'ok' });
  });

  it('survives a throwing rollback callback without wedging the queue', async () => {
    const r = createMutationRunner(noSleep);
    const bad = r.mutate({ key: 'k', vars: 0, apply: () => 0, rollback: () => { throw new Error('boom'); }, run: async () => { throw { status: 500 }; } });
    await expect(bad).rejects.toThrow('boom');
    expect(r.pendingCount('k')).toBe(0);
    expect(await r.mutate({ key: 'k', vars: 0, apply: () => 0, rollback: () => {}, run: async () => 1 })).toEqual({ ok: true, data: 1 });
  });
});
