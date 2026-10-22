// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  EnvelopeError, decryptBytes, decryptString, encryptBytes, encryptString, fromBase64, isSealableField, isSealedMarker,
  objectAad, sealAad, sealedIdFromMarker, sealedMarker, toBase64, wipe,
} from './envelope';

const dek = () => crypto.getRandomValues(new Uint8Array(32));
const ctx = { userId: 'AAAAAAAA-1111-4111-8111-111111111111', table: 'calls', rowId: 'BBBBBBBB-2222-4222-8222-222222222222', column: 'transcript' };

describe('base64', () => {
  it('round-trips large buffers without blowing the stack', () => {
    const big = new Uint8Array(300_000).map((_, i) => (i * 31 + 7) & 255); // getRandomValues caps at 64 KiB
    expect(Array.from(fromBase64(toBase64(big)).slice(0, 50))).toEqual(Array.from(big.slice(0, 50)));
    expect(fromBase64(toBase64(big)).length).toBe(big.length);
  });
});

describe('string sealing', () => {
  it('round-trips unicode text', async () => {
    const k = dek();
    const text = 'سلام — caller said: "my AC is broken" 🔧';
    const sealed = await encryptString(text, k, sealAad(ctx));
    expect(sealed.ciphertext).not.toContain('AC');
    expect(await decryptString(sealed.ciphertext, k, sealed.iv, sealAad(ctx))).toBe(text);
  });
  it('uses a fresh IV every time', async () => {
    const k = dek();
    const a = await encryptString('same', k, sealAad(ctx));
    const b = await encryptString('same', k, sealAad(ctx));
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });
  it('fails authentication with the wrong key', async () => {
    const sealed = await encryptString('secret', dek(), sealAad(ctx));
    await expect(decryptString(sealed.ciphertext, dek(), sealed.iv, sealAad(ctx))).rejects.toThrow('failed authentication');
  });
  it('binds ciphertext to its tenant, row and column (AAD)', async () => {
    const k = dek();
    const sealed = await encryptString('secret', k, sealAad(ctx));
    for (const other of [{ ...ctx, userId: 'cccccccc-3333-4333-8333-333333333333' }, { ...ctx, rowId: 'dddddddd-4444-4444-8444-444444444444' }, { ...ctx, column: 'summary' }]) {
      await expect(decryptString(sealed.ciphertext, k, sealed.iv, sealAad(other))).rejects.toThrow('failed authentication');
    }
  });
  it('treats AAD case-insensitively for ids', async () => {
    const k = dek();
    const sealed = await encryptString('x', k, sealAad(ctx));
    expect(await decryptString(sealed.ciphertext, k, sealed.iv, sealAad({ ...ctx, userId: ctx.userId.toLowerCase() }))).toBe('x');
  });
  it('detects tampering', async () => {
    const k = dek();
    const { iv, ciphertext } = await encryptBytes(new TextEncoder().encode('hello world'), k, sealAad(ctx));
    ciphertext[0] ^= 0xff;
    await expect(decryptBytes(ciphertext, k, iv, sealAad(ctx))).rejects.toThrow('failed authentication');
  });
});

describe('guards', () => {
  it('rejects wrong-size keys and IVs', async () => {
    await expect(encryptBytes(new Uint8Array(1), new Uint8Array(16), sealAad(ctx))).rejects.toThrow('32 bytes');
    await expect(decryptBytes(new Uint8Array(20), dek(), new Uint8Array(8), sealAad(ctx))).rejects.toThrow('IV');
    try { await encryptBytes(new Uint8Array(1), new Uint8Array(5), sealAad(ctx)); } catch (e) { expect((e as EnvelopeError).code).toBe('BAD_KEY'); }
  });
  it('object AAD is region-independent but tenant/row specific', () => {
    expect(Array.from(objectAad('A', 'B'))).toEqual(Array.from(objectAad('a', 'b')));
    expect(Array.from(objectAad('a', 'b'))).not.toEqual(Array.from(objectAad('a', 'c')));
  });
  it('wipes key material', () => {
    const k = new Uint8Array([1, 2, 3]);
    wipe(k);
    expect(Array.from(k)).toEqual([0, 0, 0]);
  });
  it('only allows allow-listed fields to be sealed', () => {
    expect(isSealableField('calls', 'transcript')).toBe(true);
    expect(isSealableField('calls', 'caller_number')).toBe(false);
    expect(isSealableField('profiles', 'email')).toBe(false);
  });
  it('round-trips sealed markers', () => {
    const id = 'eeeeeeee-5555-4555-8555-555555555555';
    expect(isSealedMarker(sealedMarker(id))).toBe(true);
    expect(sealedIdFromMarker(sealedMarker(id))).toBe(id);
    expect(sealedIdFromMarker('sealed://unavailable')).toBeNull();
    expect(isSealedMarker('plain text')).toBe(false);
  });
});
