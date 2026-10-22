// Enterprise Trust Pack — envelope encryption primitives (AES-256-GCM, WebCrypto).
//
// ISOMORPHIC (browser, Deno, Node >= 20). No dependencies.
//
// Model: every sealed item gets its own random 256-bit data key (DEK). The DEK is
// produced/wrapped by the customer's KMS key (see kms.ts); only the wrapped DEK is
// stored next to the ciphertext. Revoking the customer key therefore makes every
// item unreadable ("crypto-shredding") without touching storage.
//
// AAD binds each ciphertext to its tenant + row + column, so a ciphertext copied to
// another row or account fails authentication instead of decrypting.

export const SEAL_ALG = 'AES-256-GCM' as const;
const IV_BYTES = 12;
const KEY_BYTES = 32;

/** The only (table, column) pairs that may be sealed. Extend deliberately. */
export const SEALABLE_FIELDS = [
  { table: 'calls', column: 'transcript' },
] as const;

export function isSealableField(table: string, column: string): boolean {
  return SEALABLE_FIELDS.some((f) => f.table === table && f.column === column);
}

export class EnvelopeError extends Error {
  readonly code: 'BAD_KEY' | 'BAD_IV' | 'AUTH_FAILED';
  constructor(code: EnvelopeError['code'], message: string) {
    super(message);
    this.name = 'EnvelopeError';
    this.code = code;
  }
}

/** WebCrypto wants BufferSource; newer TS lib typings reject Uint8Array<ArrayBufferLike>. */
export const bs = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });

export function toBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface SealContext {
  userId: string;
  table: string;
  rowId: string;
  column: string;
}

/** Additional authenticated data for GCM. */
export function sealAad(ctx: SealContext): Uint8Array {
  return enc.encode(`vireek:v1|${ctx.userId.toLowerCase()}|${ctx.table}|${ctx.rowId.toLowerCase()}|${ctx.column}`);
}

/**
 * AAD for archived objects (recordings). Deliberately excludes bucket/region so a
 * region migration can move ciphertext between data planes WITHOUT re-encrypting.
 */
export function objectAad(userId: string, sourceRowId: string): Uint8Array {
  return enc.encode(`vireek:v1:object|${userId.toLowerCase()}|${sourceRowId.toLowerCase()}`);
}

async function importDek(dek: Uint8Array, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  if (dek.byteLength !== KEY_BYTES) throw new EnvelopeError('BAD_KEY', 'Data key must be 32 bytes');
  return crypto.subtle.importKey('raw', bs(dek), { name: 'AES-GCM' }, false, [usage]);
}

export interface Encrypted {
  iv: Uint8Array;
  ciphertext: Uint8Array;
}

export async function encryptBytes(plain: Uint8Array, dek: Uint8Array, aad: Uint8Array): Promise<Encrypted> {
  const key = await importDek(dek, 'encrypt');
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: bs(iv), additionalData: bs(aad), tagLength: 128 }, key, bs(plain));
  return { iv, ciphertext: new Uint8Array(ct) };
}

export async function decryptBytes(ciphertext: Uint8Array, dek: Uint8Array, iv: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  if (iv.byteLength !== IV_BYTES) throw new EnvelopeError('BAD_IV', 'Invalid IV length');
  const key = await importDek(dek, 'decrypt');
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bs(iv), additionalData: bs(aad), tagLength: 128 }, key, bs(ciphertext));
    return new Uint8Array(pt);
  } catch {
    // WebCrypto throws an opaque OperationError for wrong key / wrong AAD / tampering.
    throw new EnvelopeError('AUTH_FAILED', 'Ciphertext failed authentication');
  }
}

export async function encryptString(text: string, dek: Uint8Array, aad: Uint8Array): Promise<{ iv: string; ciphertext: string }> {
  const { iv, ciphertext } = await encryptBytes(enc.encode(text), dek, aad);
  return { iv: toBase64(iv), ciphertext: toBase64(ciphertext) };
}

export async function decryptString(ciphertextB64: string, dek: Uint8Array, ivB64: string, aad: Uint8Array): Promise<string> {
  return dec.decode(await decryptBytes(fromBase64(ciphertextB64), dek, fromBase64(ivB64), aad));
}

/** Best-effort wipe of key material once it is no longer needed. */
export function wipe(...buffers: Uint8Array[]): void {
  for (const b of buffers) b.fill(0);
}

/** Marker stored in the original column once a value is sealed. */
export const SEALED_PREFIX = 'sealed://';
export const sealedMarker = (id: string): string => `${SEALED_PREFIX}${id}`;
export const isSealedMarker = (v: unknown): v is string => typeof v === 'string' && v.startsWith(SEALED_PREFIX);
export const sealedIdFromMarker = (v: string): string | null => {
  const id = v.slice(SEALED_PREFIX.length);
  return /^[0-9a-f-]{36}$/i.test(id) ? id.toLowerCase() : null;
};
