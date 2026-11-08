import { describe, expect, it } from 'vitest';
import { prepareInOrder } from './replayOrder';

const op = (seq: number, job_id: string | null) => ({ seq, job_id });

describe('prepareInOrder', () => {
  it('sorts by seq', async () => {
    const out = await prepareInOrder([op(3, 'a'), op(1, 'a'), op(2, 'a')], async () => true);
    expect(out.map((o) => o.seq)).toEqual([1, 2, 3]);
  });

  it('holds back later ops of the same job after a failure, but not other jobs', async () => {
    const out = await prepareInOrder(
      [op(1, 'a'), op(2, 'b'), op(3, 'a'), op(4, 'b'), op(5, null)],
      async (o) => o.seq !== 1,
    );
    expect(out.map((o) => o.seq)).toEqual([2, 4, 5]);
  });

  it('treats null job ids as one shared stream and never calls prepare for blocked ops', async () => {
    const seen: number[] = [];
    const out = await prepareInOrder([op(1, null), op(2, null)], async (o) => {
      seen.push(o.seq);
      return false;
    });
    expect(out).toEqual([]);
    expect(seen).toEqual([1]);
  });

  it('orders numeric strings numerically', async () => {
    const out = await prepareInOrder([{ seq: '10', job_id: 'a' }, { seq: '9', job_id: 'a' }], async () => true);
    expect(out.map((o) => o.seq)).toEqual(['9', '10']);
  });
});
