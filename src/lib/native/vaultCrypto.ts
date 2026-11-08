// src/lib/native/vaultCrypto.ts
// AES-256-GCM sealing for the on-device vault. The random key lives in the Keychain/Keystore,
// never beside the data. If the key store is unavailable every seal*() returns null and the
// caller keeps the previous (unsealed) behaviour: losing a technician's field data is worse.

export interface KeyStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
}

const KEY_NAME = 'vireek-vault-key-v1';
const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

interface Envelope {
  v: number;
  enc: string;
}

const isEnvelope = (x: unknown): x is Envelope =>
  typeof x === 'object' && x !== null && (x as Envelope).v === VERSION && typeof (x as Envelope).enc === 'string';

export function createVaultCipher(store: KeyStore, webCrypto: Crypto = globalThis.crypto) {
  let keyPromise: Promise<CryptoKey | null> | null = null;

  const loadKey = async (): Promise<CryptoKey | null> => {
    try {
      let raw = await store.get(KEY_NAME);
      if (!raw) {
        const fresh = bytesToBase64(webCrypto.getRandomValues(new Uint8Array(32)));
        await store.set(KEY_NAME, fresh);
        raw = await store.get(KEY_NAME); // a store that silently drops writes must not be trusted
        if (raw !== fresh) return null;
      }
      return await webCrypto.subtle.importKey('raw', base64ToBytes(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
    } catch {
      return null;
    }
  };

  const getKey = (): Promise<CryptoKey | null> => {
    keyPromise ??= loadKey().then((k) => {
      if (!k) keyPromise = null; // retry next time (keystore may become available)
      return k;
    });
    return keyPromise;
  };

  const encryptBytes = async (plain: BufferSource): Promise<Uint8Array | null> => {
    const key = await getKey();
    if (!key) return null;
    const iv = webCrypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ct = new Uint8Array(await webCrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
    const out = new Uint8Array(1 + IV_BYTES + ct.length);
    out[0] = VERSION;
    out.set(iv, 1);
    out.set(ct, 1 + IV_BYTES);
    return out;
  };

  const decryptBytes = async (sealed: Uint8Array): Promise<ArrayBuffer> => {
    if (sealed.length < 1 + IV_BYTES + TAG_BYTES || sealed[0] !== VERSION) throw new Error('vault: unsupported or truncated data');
    const key = await getKey();
    if (!key) throw new Error('vault: key unavailable');
    return webCrypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.slice(1, 1 + IV_BYTES) }, key, sealed.slice(1 + IV_BYTES));
  };

  return {
    /** base64 of the sealed bytes, or null when no key is available. */
    async sealBytes(plain: ArrayBuffer): Promise<string | null> {
      const sealed = await encryptBytes(plain);
      return sealed ? bytesToBase64(sealed) : null;
    },
    /** Throws on tampering, truncation or a missing key. */
    openBytes(b64: string): Promise<ArrayBuffer> {
      return decryptBytes(base64ToBytes(b64));
    },
    /** File text for a sealed JSON value, or null when no key is available. */
    async sealJson(value: unknown): Promise<string | null> {
      const sealed = await encryptBytes(new TextEncoder().encode(JSON.stringify(value)));
      return sealed ? JSON.stringify({ v: VERSION, enc: bytesToBase64(sealed) } satisfies Envelope) : null;
    },
    /** Reads sealed files and legacy plaintext files alike. */
    async openJson<T>(text: string): Promise<T> {
      const parsed: unknown = JSON.parse(text);
      if (!isEnvelope(parsed)) return parsed as T;
      return JSON.parse(new TextDecoder().decode(await decryptBytes(base64ToBytes(parsed.enc)))) as T;
    },
  };
}
