import { describe, expect, it } from 'vitest';
import { createVaultCipher, type KeyStore } from './vaultCrypto';

const memoryStore = (): KeyStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, get: async (k) => data.get(k) ?? null, set: async (k, v) => void data.set(k, v) };
};
const droppingStore: KeyStore = { get: async () => null, set: async () => undefined };
const bytes = (n: number) => new Uint8Array(Array.from({ length: n }, (_, i) => i % 251)).buffer;

describe('vaultCipher', () => {
  it('round-trips bytes and JSON, and the ciphertext does not contain the plaintext', async () => {
    const c = createVaultCipher(memoryStore());
    const sealed = await c.sealBytes(bytes(100_000));
    expect(sealed).toBeTruthy();
    expect(new Uint8Array(await c.openBytes(sealed as string))).toEqual(new Uint8Array(bytes(100_000)));
    const json = await c.sealJson({ op: { note: 'secret-note' } });
    expect((json as string).includes('secret-note')).toBe(false);
    expect(await c.openJson<{ op: { note: string } }>(json as string)).toEqual({ op: { note: 'secret-note' } });
  });

  it('a second cipher on the same key store can read what the first wrote (app restart)', async () => {
    const store = memoryStore();
    const sealed = (await createVaultCipher(store).sealBytes(bytes(64))) as string;
    expect(new Uint8Array(await createVaultCipher(store).openBytes(sealed))).toEqual(new Uint8Array(bytes(64)));
  });

  it('parallel first use creates exactly one key', async () => {
    const store = memoryStore();
    const c = createVaultCipher(store);
    const [a, b] = await Promise.all([c.sealBytes(bytes(8)), c.sealBytes(bytes(9))]);
    const fresh = createVaultCipher(store);
    expect((await fresh.openBytes(a as string)).byteLength).toBe(8);
    expect((await fresh.openBytes(b as string)).byteLength).toBe(9);
    expect(store.data.size).toBe(1);
  });

  it('detects tampering, truncation and a different key', async () => {
    const c = createVaultCipher(memoryStore());
    const sealed = (await c.sealBytes(bytes(64))) as string;
    const raw = Uint8Array.from(atob(sealed), (ch) => ch.charCodeAt(0));
    raw[raw.length - 1] ^= 1;
    await expect(c.openBytes(btoa(String.fromCharCode(...raw)))).rejects.toThrow();
    await expect(c.openBytes(btoa('short'))).rejects.toThrow();
    await expect(createVaultCipher(memoryStore()).openBytes(sealed)).rejects.toThrow();
  });

  it('returns null (caller keeps legacy behaviour) when the key store drops writes', async () => {
    const c = createVaultCipher(droppingStore);
    expect(await c.sealBytes(bytes(8))).toBeNull();
    expect(await c.sealJson({ a: 1 })).toBeNull();
  });

  it('still reads legacy plaintext JSON entries', async () => {
    const legacy = JSON.stringify({ op: { id: 'x' }, blob: null });
    expect(await createVaultCipher(droppingStore).openJson(legacy)).toEqual({ op: { id: 'x' }, blob: null });
  });
});
