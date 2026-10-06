import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutboxOp, StoredBlob } from '../offline/db';

// In-memory device: private file system + IndexedDB stores.
const files = new Map<string, string>();
const stores: Record<string, Map<string, unknown>> = { outbox: new Map(), blobs: new Map() };

vi.mock('./platform', () => ({ isNative: () => true, nativePlatform: () => 'ios' }));

vi.mock('@capacitor/filesystem', () => ({
  Directory: { Data: 'DATA' },
  Encoding: { UTF8: 'utf8' },
  Filesystem: {
    mkdir: async () => undefined,
    writeFile: async ({ path, data }: { path: string; data: string }) => void files.set(path, data),
    readFile: async ({ path }: { path: string }) => {
      if (!files.has(path)) throw new Error('not found');
      return { data: files.get(path) };
    },
    deleteFile: async ({ path }: { path: string }) => {
      if (!files.delete(path)) throw new Error('not found');
    },
    readdir: async ({ path }: { path: string }) => {
      const prefix = `${path}/`;
      const names = [...files.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
      if (names.length === 0) throw new Error('no dir');
      return { files: names.map((name) => ({ name })) };
    },
  },
}));

vi.mock('../offline/db', () => ({
  idb: {
    get: async (store: string, key: string) => stores[store].get(key),
    put: async (store: string, value: { id: string }) => void stores[store].set(value.id, value),
  },
  transact: async (_s: string[], _m: string, work: (get: (n: string) => { put: (v: { id: string }) => void }) => void) => {
    work((name) => ({ put: (v) => void stores[name].set(v.id, v) }));
  },
  notifyData: () => undefined,
  notifyEnqueue: () => undefined,
}));

import { forgetFromVault, mirrorToVault, rehydrateFromVault } from './vault';

function op(id: string, extra: Partial<OutboxOp> = {}): OutboxOp {
  return {
    id, seq: 1, user_id: 'u1', type: 'artifact', job_id: 'j1', payload: { kind: 'photo' },
    client_ts: '2027-02-10T10:00:00.000Z', state: 'pending', attempts: 3, next_attempt_at: 99, uploaded: true, ...extra,
  };
}

describe('durable vault', () => {
  beforeEach(() => {
    files.clear();
    stores.outbox.clear();
    stores.blobs.clear();
  });

  it('restores an operation and its photo after the WebView storage was wiped', async () => {
    const stored: StoredBlob = { id: 'b1', blob: new Blob([new Uint8Array([1, 2, 3, 250])], { type: 'image/jpeg' }), mime: 'image/jpeg', ext: 'jpg' };
    await mirrorToVault(op('op-1', { blob_id: 'b1', blob_bucket: 'job-evidence-photos' }), stored);

    expect([...files.keys()].sort()).toEqual(['vireek-vault/u1/op-1.bin', 'vireek-vault/u1/op-1.json']);
    // IndexedDB is empty (wiped) → rehydrate must rebuild it.
    expect(await rehydrateFromVault('u1')).toBe(1);

    const revived = stores.outbox.get('op-1') as OutboxOp;
    expect(revived.state).toBe('pending');
    expect(revived.attempts).toBe(0);
    expect(revived.uploaded).toBe(false);
    const blob = (stores.blobs.get('b1') as StoredBlob).blob;
    expect(blob.type).toBe('image/jpeg');
    const bytes = await new Promise<Uint8Array>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
      reader.readAsArrayBuffer(blob);
    });
    expect([...bytes]).toEqual([1, 2, 3, 250]);
  });

  it('does not touch operations IndexedDB already has, and never restores another user\'s', async () => {
    await mirrorToVault(op('op-2'));
    await mirrorToVault(op('op-3', { user_id: 'u2' }));
    stores.outbox.set('op-2', op('op-2', { attempts: 1 }));
    vi.resetModules();
    const fresh = await import('./vault');
    expect(await fresh.rehydrateFromVault('u1')).toBe(0);
    expect((stores.outbox.get('op-2') as OutboxOp).attempts).toBe(1);
    expect(stores.outbox.has('op-3')).toBe(false);
  });

  it('removes delivered operations from the vault', async () => {
    const stored: StoredBlob = { id: 'b9', blob: new Blob(['x'], { type: 'audio/webm' }), mime: 'audio/webm', ext: 'webm' };
    const o = op('op-4', { blob_id: 'b9' });
    await mirrorToVault(o, stored);
    expect(files.size).toBe(2);
    await forgetFromVault(o);
    expect(files.size).toBe(0);
    await expect(forgetFromVault(o)).resolves.toBeUndefined(); // idempotent
  });
});
