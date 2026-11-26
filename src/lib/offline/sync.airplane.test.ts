// Airplane-mode simulation of the real sync engine + outbox against an in-memory IndexedDB fake
// and a scripted Supabase. Covers: offline queueing (status, photo, drawn + typed signature),
// reconnect, a dropped connection mid-batch, per-job ordering, duplicates and conflict rules.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const stores: Record<string, Map<unknown, any>> = {};
  const keyOf: Record<string, string> = { jobs: 'id', briefs: 'job_id', outbox: 'id', blobs: 'id', pings: 'recorded_at', meta: 'key' };
  const reset = () => { for (const k of Object.keys(keyOf)) stores[k] = new Map(); };
  reset();
  const store = (n: string) => ({
    put: (v: any) => { stores[n].set(v[keyOf[n]], v); },
    delete: (k: unknown) => { stores[n].delete(k); },
    clear: () => { stores[n].clear(); },
  });
  return {
    stores, reset,
    rpc: vi.fn(), upload: vi.fn(),
    store,
  };
});

vi.mock('./db', () => {
  let seq = 0;
  const get = async (n: string, k: unknown) => h.stores[n].get(k);
  return {
    idb: {
      get, getAll: async (n: string) => [...h.stores[n].values()],
      put: async (n: string, v: any) => h.store(n).put(v), delete: async (n: string, k: unknown) => h.store(n).delete(k),
      clear: async (n: string) => h.store(n).clear(),
    },
    transact: async (_s: string[], _m: string, work: (s: (n: string) => any) => unknown) => { work((n) => h.store(n)); },
    getMeta: async (k: string) => h.stores.meta.get(k)?.value,
    setMeta: async (k: string, v: unknown) => (v === undefined ? h.stores.meta.delete(k) : h.stores.meta.set(k, { key: k, value: v })),
    notifyData: () => undefined, subscribeData: () => () => undefined,
    notifyEnqueue: () => undefined, onEnqueue: () => () => undefined,
    newId: () => `id-${++seq}`, nextSeq: () => ++seq,
  };
});
vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...a: unknown[]) => h.rpc(...a),
    auth: { getSession: async () => ({ data: { session: { user: { id: 'u1' } } } }) },
    storage: { from: (b: string) => ({ upload: (p: string, ...r: unknown[]) => h.upload(b, p, ...r) }) },
  },
}));
vi.mock('../native/vault', () => ({
  mirrorToVault: async () => undefined, forgetFromVault: async () => undefined,
  rehydrateFromVault: async () => undefined, wipeVault: async () => undefined,
}));
vi.mock('../native/dataSaver', () => ({ isDataSaverActive: () => false }));
vi.mock('./forms', () => ({ refreshFormTemplates: async () => undefined }));

import { enqueue, listOutbox } from './outbox';
import { setCachedIdentity } from './identity';
import { getSyncState, syncNow } from './sync';

let online = true;
const setOnline = (v: boolean) => { online = v; };
const ok = (ops: { client_op_id: string }[], outcome = 'applied', detail?: unknown) =>
  ({ data: { results: ops.map((o) => ({ client_op_id: o.client_op_id, outcome, detail })) }, error: null });
const bundle = { data: { jobs: [] }, error: null };
const png = () => new Blob([new Uint8Array(10)], { type: 'image/png' });

beforeEach(() => {
  h.reset(); h.rpc.mockReset(); h.upload.mockReset();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date('2027-01-01T08:00:00Z'));
  online = true;
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
  setCachedIdentity({ userId: 'u1', teamMemberId: 't1' });
  h.upload.mockResolvedValue({ error: null });
});

async function queueFieldWork() {
  await enqueue('status', 'job-a', { status: 'in_progress' });
  await enqueue('artifact', 'job-a', { kind: 'photo' }, { blob: { data: png(), bucket: 'field-captures', ext: 'jpg' } });
  await enqueue('artifact', 'job-a', { kind: 'signature', method: 'drawn' }, { blob: { data: png(), bucket: 'field-captures', ext: 'png' } });
  await enqueue('artifact', 'job-a', { kind: 'signature', method: 'typed', typed_name: 'A. Tech' });
}

describe('airplane mode', () => {
  it('queues everything locally and makes zero network calls while offline', async () => {
    setOnline(false);
    await queueFieldWork();
    await syncNow();
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.upload).not.toHaveBeenCalled();
    expect(await listOutbox()).toHaveLength(4);
  });

  it('delivers once on reconnect: uploads files first, one batch, same op ids, outbox emptied', async () => {
    setOnline(false);
    await queueFieldWork();
    const ids = (await listOutbox()).map((o) => o.id);
    setOnline(true);
    h.rpc.mockImplementation(async (name: string, args: { p_ops: { client_op_id: string }[] }) => (name === 'sync_technician_batch' ? ok(args.p_ops) : bundle));
    await syncNow();
    const batch = h.rpc.mock.calls.filter((c) => c[0] === 'sync_technician_batch');
    expect(batch).toHaveLength(1);
    expect(batch[0][1].p_ops.map((o: { client_op_id: string }) => o.client_op_id)).toEqual(ids);
    expect(h.upload).toHaveBeenCalledTimes(2);
    expect(h.upload.mock.calls[0][1]).toMatch(/^u1\/job-a\/.+\.jpg$/);
    expect(await listOutbox()).toHaveLength(0);
    expect(h.stores.blobs.size).toBe(0);
    expect(getSyncState().pending).toBe(0);
  });

  it('a dropped connection keeps data, backs off, and the retry re-sends the SAME op ids', async () => {
    await enqueue('status', 'job-a', { status: 'en_route' });
    const [op] = await listOutbox();
    h.rpc.mockResolvedValueOnce({ data: null, error: { message: 'TypeError: Failed to fetch' } });
    await syncNow();
    const after = (await listOutbox())[0];
    expect(after.state).toBe('pending');
    expect(after.net_failures).toBe(1);
    expect(after.next_attempt_at).toBeGreaterThan(Date.now());

    vi.setSystemTime(Date.now() + 10 * 60_000);
    h.rpc.mockImplementation(async (name: string, args: { p_ops: { client_op_id: string }[] }) => (name === 'sync_technician_batch' ? ok(args.p_ops) : bundle));
    await syncNow();
    const sent = h.rpc.mock.calls.filter((c) => c[0] === 'sync_technician_batch').at(-1)![1].p_ops;
    expect(sent[0].client_op_id).toBe(op.id);
    expect(await listOutbox()).toHaveLength(0);
  });

  it('network failures never turn into "failed"', async () => {
    await enqueue('note', 'job-a', { text: 'x' });
    for (let i = 0; i < 12; i++) {
      h.rpc.mockResolvedValueOnce({ data: null, error: { message: 'Failed to fetch' } });
      vi.setSystemTime(Date.now() + 20 * 60_000);
      await syncNow();
    }
    expect((await listOutbox())[0].state).toBe('pending');
  });

  it('a photo that cannot upload holds back later ops of the same job only', async () => {
    await enqueue('artifact', 'job-a', { kind: 'photo' }, { blob: { data: png(), bucket: 'field-captures', ext: 'jpg' } });
    await enqueue('status', 'job-a', { status: 'completed' });
    await enqueue('status', 'job-b', { status: 'in_progress' });
    h.upload.mockResolvedValue({ error: { message: 'Failed to fetch' } });
    h.rpc.mockImplementation(async (name: string, args: { p_ops: { job_id: string; client_op_id: string }[] }) => (name === 'sync_technician_batch' ? ok(args.p_ops) : bundle));
    await syncNow();
    const sent = h.rpc.mock.calls.find((c) => c[0] === 'sync_technician_batch')![1].p_ops;
    expect(sent.map((o: { job_id: string }) => o.job_id)).toEqual(['job-b']);
    expect((await listOutbox()).map((o) => o.job_id)).toEqual(['job-a', 'job-a']);
  });

  it('server "duplicate" counts as delivered; benign conflict is dropped; real conflict is parked', async () => {
    await enqueue('status', 'job-a', { status: 'en_route' });
    await enqueue('status', 'job-b', { status: 'in_progress' });
    await enqueue('note', 'job-c', { text: 'hi' });
    const ops = await listOutbox();
    h.rpc.mockImplementation(async (name: string) => name === 'sync_technician_batch'
      ? { data: { results: [
          { client_op_id: ops[0].id, outcome: 'duplicate' },
          { client_op_id: ops[1].id, outcome: 'conflict', detail: { reason: 'server_ahead' } },
          { client_op_id: ops[2].id, outcome: 'conflict', detail: { reason: 'job_closed' } },
        ] }, error: null }
      : bundle);
    await syncNow();
    const left = await listOutbox();
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ id: ops[2].id, state: 'conflict' });
    expect(getSyncState().conflicts).toBe(1);
  });

  it('data from a different signed-in user is never sent', async () => {
    await enqueue('note', 'job-a', { text: 'mine' });
    setCachedIdentity({ userId: 'u2', teamMemberId: 't2' });
    await syncNow();
    expect(h.rpc.mock.calls.filter((c) => c[0] === 'sync_technician_batch')).toHaveLength(0);
  });
});
