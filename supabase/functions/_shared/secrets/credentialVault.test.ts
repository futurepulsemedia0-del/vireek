import { describe, expect, it } from 'vitest';
import { buildAad, openJson, parseKeyList, sealJson } from './credentialVault';

const keyA = Buffer.alloc(32, 1).toString('base64');
const keyB = Buffer.alloc(32, 2).toString('base64');
const AAD = buildAad('user-1', 'jobber');

describe('credentialVault', () => {
  it('round-trips a secret bag', async () => {
    const t = await sealJson({ access_token: 'a', refresh_token: 'r' }, keyA, AAD);
    expect(t.startsWith('v2.')).toBe(true);
    expect(await openJson(t, [keyA], AAD)).toEqual({ access_token: 'a', refresh_token: 'r' });
  });
  it('uses a fresh IV every time and never leaks plaintext', async () => {
    const a = await sealJson({ k: 'secret-value' }, keyA, AAD);
    const b = await sealJson({ k: 'secret-value' }, keyA, AAD);
    expect(a).not.toBe(b);
    expect(a).not.toContain('secret-value');
  });
  it('rejects a ciphertext moved to another tenant or provider (AAD binding)', async () => {
    const t = await sealJson({ k: 'v' }, keyA, AAD);
    await expect(openJson(t, [keyA], buildAad('user-2', 'jobber'))).rejects.toThrow('credential_decrypt_failed');
    await expect(openJson(t, [keyA], buildAad('user-1', 'hubspot'))).rejects.toThrow('credential_decrypt_failed');
  });
  it('rejects tampering and wrong keys', async () => {
    const t = await sealJson({ k: 'v' }, keyA, AAD);
    const tampered = t.slice(0, -2) + (t.endsWith('AA') ? 'BB' : 'AA');
    await expect(openJson(tampered, [keyA], AAD)).rejects.toThrow('credential_decrypt_failed');
    await expect(openJson(t, [keyB], AAD)).rejects.toThrow('credential_decrypt_failed');
  });
  it('supports key rotation (previous key still opens, new key seals)', async () => {
    const old = await sealJson({ k: 'v' }, keyB, AAD);
    expect(await openJson(old, [keyA, keyB], AAD)).toEqual({ k: 'v' });
  });
  it('validates key length and token format', async () => {
    await expect(sealJson({ k: 'v' }, 'short', AAD)).rejects.toThrow('credential_key_invalid');
    await expect(openJson('v1.a.b', [keyA], AAD)).rejects.toThrow('credential_format_unrecognised');
    await expect(openJson('garbage', [keyA], AAD)).rejects.toThrow('credential_format_unrecognised');
    await expect(openJson((await sealJson({ k: 'v' }, keyA, AAD)), [], AAD)).rejects.toThrow('credential_key_missing');
  });
  it('parseKeyList drops empty values', () => {
    expect(parseKeyList(' a ', undefined)).toEqual(['a']);
    expect(parseKeyList('a', 'b')).toEqual(['a', 'b']);
    expect(parseKeyList('', null)).toEqual([]);
  });
});
