// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { eraseAccountStorage } from './storageErasure.ts';

const ACC = '11111111-1111-4111-8111-111111111111';

/** In-memory storage: objects keyed by "bucket/name"; remove() deletes them; the RPC lists what is left. */
function fake(initial: Array<[string, string]>, opts: { removeFails?: string; listError?: boolean; stuck?: boolean } = {}) {
  const objs = new Map(initial.map(([b, n]) => [`${b}/${n}`, { b, n }]));
  const removed: string[] = [];
  const admin: any = {
    rpc: async (name: string, a: any) => {
      if (name !== 'storage_objects_for_account') throw new Error('unexpected rpc');
      if (opts.listError) return { data: null, error: { code: '42883' } };
      return { data: [...objs.values()].filter(({ n }) => n.startsWith(`${a.p_account}/`)).slice(0, a.p_limit).map((o) => ({ bucket_id: o.b, name: o.n })), error: null };
    },
    storage: { from: (bucket: string) => ({ remove: async (paths: string[]) => {
      if (opts.removeFails === bucket) return { data: null, error: { message: 'x' } };
      if (!opts.stuck) for (const p of paths) objs.delete(`${bucket}/${p}`);
      removed.push(...paths.map((p) => `${bucket}/${p}`));
      return { data: null, error: null };
    } }) },
  };
  return { admin, objs, removed };
}

describe('eraseAccountStorage', () => {
  it('removes the account\'s objects across buckets and leaves other tenants\' files alone', async () => {
    const { admin, objs } = fake([['pbx-media', `${ACC}/rec/1.mp3`], ['estimate-photos', `${ACC}/a.jpg`], ['pbx-media', 'someone-else/rec/2.mp3']]);
    const r = await eraseAccountStorage(admin, ACC);
    expect(r).toMatchObject({ ok: true, removed: 2, buckets: ['estimate-photos', 'pbx-media'] });
    expect([...objs.keys()]).toEqual(['pbx-media/someone-else/rec/2.mp3']);
  });
  it('pages through more objects than one listing returns', async () => {
    const many: Array<[string, string]> = Array.from({ length: 1234 }, (_, i) => ['job-evidence-photos', `${ACC}/p${i}.jpg`]);
    const { admin, objs } = fake(many);
    const r = await eraseAccountStorage(admin, ACC);
    expect(r.ok).toBe(true);
    expect(r.removed).toBe(1234);
    expect(objs.size).toBe(0);
  });
  it('nothing to remove is ok', async () => {
    expect(await eraseAccountStorage(fake([]).admin, ACC)).toMatchObject({ ok: true, removed: 0 });
  });
  it('a failing bucket makes the result not ok and is reported without object names', async () => {
    const { admin } = fake([['pbx-media', `${ACC}/rec/1.mp3`]], { removeFails: 'pbx-media' });
    const r = await eraseAccountStorage(admin, ACC);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('remove_failed:pbx-media');
    expect(JSON.stringify(r)).not.toContain('rec/1.mp3');
  });
  it('does not spin when objects cannot be removed, and the final verify catches what remains', async () => {
    const r = await eraseAccountStorage(fake([['pbx-media', `${ACC}/x.mp3`]], { stuck: true }).admin, ACC);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('objects_remaining');
  });
  it('a list failure (e.g. migration not applied) fails closed', async () => {
    const r = await eraseAccountStorage(fake([], { listError: true }).admin, ACC);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain('list_failed');
  });
  it('rejects anything that is not a uuid before querying', async () => {
    const r = await eraseAccountStorage(fake([]).admin, "x' OR 1=1 --");
    expect(r).toMatchObject({ ok: false, errors: ['invalid_account_id'] });
  });
});
