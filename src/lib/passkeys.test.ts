import { beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  registerPasskey: vi.fn(),
  signInWithPasskey: vi.fn(),
  passkey: { list: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));

vi.mock('@/lib/supabase', () => ({ supabase: { auth } }));

import {
  PasskeyError,
  classifyPasskeyError,
  deletePasskey,
  listPasskeys,
  normalizeFriendlyName,
  registerNewPasskey,
  renamePasskey,
  signInWithPasskey,
  suggestPasskeyName,
} from '@/lib/passkeys';

function enableWebAuthn() {
  vi.stubGlobal('PublicKeyCredential', function PublicKeyCredential() {});
  Object.defineProperty(navigator, 'credentials', {
    configurable: true,
    value: { create: vi.fn(), get: vi.fn() },
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  enableWebAuthn();
});

describe('classifyPasskeyError', () => {
  it('treats user cancellation / abort as cancelled (never shown as an error)', () => {
    expect(classifyPasskeyError({ name: 'NotAllowedError' }).kind).toBe('cancelled');
    expect(classifyPasskeyError({ name: 'AbortError' }).kind).toBe('cancelled');
    expect(classifyPasskeyError({ code: 'ERROR_CEREMONY_ABORTED' }).kind).toBe('cancelled');
    expect(classifyPasskeyError({ code: 'ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY', cause: { name: 'NotAllowedError' } }).kind).toBe('cancelled');
  });

  it.each([
    ['passkey_disabled', 'disabled'],
    ['too_many_passkeys', 'limit'],
    ['webauthn_credential_exists', 'duplicate'],
    ['email_not_confirmed', 'unconfirmed'],
    ['user_banned', 'banned'],
    ['webauthn_credential_not_found', 'not_found'],
    ['webauthn_challenge_expired', 'expired'],
    ['webauthn_challenge_not_found', 'expired'],
  ])('maps server code %s to %s', (code, kind) => {
    expect(classifyPasskeyError({ code }).kind).toBe(kind);
    expect(classifyPasskeyError({ error_code: code }).kind).toBe(kind);
  });

  it('maps InvalidStateError to duplicate and NotSupportedError to unsupported', () => {
    expect(classifyPasskeyError({ name: 'InvalidStateError' }).kind).toBe('duplicate');
    expect(classifyPasskeyError({ name: 'NotSupportedError' }).kind).toBe('unsupported');
  });

  it('falls back to the original message, then a generic one', () => {
    expect(classifyPasskeyError(new Error('boom'))).toEqual({ kind: 'unknown', message: 'boom' });
    expect(classifyPasskeyError(undefined).message).toMatch(/something went wrong/i);
  });
});

describe('naming', () => {
  it('suggests a readable default from the user agent', () => {
    expect(suggestPasskeyName('Mozilla/5.0 (Macintosh) AppleWebKit Safari/605')).toBe('Safari on Mac');
    expect(suggestPasskeyName(null)).toBe('My passkey');
  });
  it('normalises whitespace and caps length at 120', () => {
    expect(normalizeFriendlyName('  My   laptop \n')).toBe('My laptop');
    expect(normalizeFriendlyName('x'.repeat(300))).toHaveLength(120);
  });
});

describe('registerNewPasskey', () => {
  it('registers, then applies the friendly name', async () => {
    auth.registerPasskey.mockResolvedValue({ data: { id: 'p1', friendly_name: null, created_at: '2027-04-01T00:00:00Z' }, error: null });
    auth.passkey.update.mockResolvedValue({ data: {}, error: null });
    const row = await registerNewPasskey('Work laptop');
    expect(auth.passkey.update).toHaveBeenCalledWith({ passkeyId: 'p1', friendlyName: 'Work laptop' });
    expect(row).toMatchObject({ id: 'p1', friendly_name: 'Work laptop' });
  });

  it('still succeeds if the cosmetic rename fails', async () => {
    auth.registerPasskey.mockResolvedValue({ data: { id: 'p1', created_at: '2027-04-01T00:00:00Z' }, error: null });
    auth.passkey.update.mockRejectedValue(new Error('nope'));
    await expect(registerNewPasskey('Name')).resolves.toMatchObject({ id: 'p1', friendly_name: null });
  });

  it('surfaces a classified error from the SDK envelope', async () => {
    auth.registerPasskey.mockResolvedValue({ data: null, error: { code: 'too_many_passkeys', message: 'x' } });
    await expect(registerNewPasskey()).rejects.toMatchObject({ name: 'PasskeyError', kind: 'limit' });
  });

  it('surfaces a thrown browser cancellation as cancelled', async () => {
    auth.registerPasskey.mockRejectedValue(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
    await expect(registerNewPasskey()).rejects.toMatchObject({ kind: 'cancelled' });
  });

  it('fails fast as unsupported without WebAuthn', async () => {
    vi.unstubAllGlobals();
    Object.defineProperty(window, 'PublicKeyCredential', { configurable: true, value: undefined });
    await expect(registerNewPasskey()).rejects.toBeInstanceOf(PasskeyError);
    expect(auth.registerPasskey).not.toHaveBeenCalled();
  });
});

describe('signInWithPasskey', () => {
  it('resolves when a session comes back', async () => {
    auth.signInWithPasskey.mockResolvedValue({ data: { session: { access_token: 't' }, user: {} }, error: null });
    await expect(signInWithPasskey()).resolves.toBeUndefined();
    expect(auth.signInWithPasskey).toHaveBeenCalledWith(undefined);
  });

  it('forwards conditional mediation and the abort signal', async () => {
    auth.signInWithPasskey.mockResolvedValue({ data: { session: {} }, error: null });
    const signal = new AbortController().signal;
    await signInWithPasskey({ mediation: 'conditional', signal });
    expect(auth.signInWithPasskey).toHaveBeenCalledWith({ options: { mediation: 'conditional', signal } });
  });

  it('rejects with a classified error and when no session is returned', async () => {
    auth.signInWithPasskey.mockResolvedValue({ data: null, error: { code: 'webauthn_credential_not_found' } });
    await expect(signInWithPasskey()).rejects.toMatchObject({ kind: 'not_found' });
    auth.signInWithPasskey.mockResolvedValue({ data: {}, error: null });
    await expect(signInWithPasskey()).rejects.toBeInstanceOf(PasskeyError);
  });
});

describe('management calls', () => {
  it('lists newest first and fills missing fields (envelope or bare array)', async () => {
    const rows = [
      { id: 'a', friendly_name: 'Old', created_at: '2027-01-01T00:00:00Z' },
      { id: 'b', friendly_name: null, created_at: '2027-03-01T00:00:00Z', last_used_at: '2027-03-02T00:00:00Z' },
    ];
    auth.passkey.list.mockResolvedValueOnce({ data: rows, error: null });
    expect((await listPasskeys()).map((p) => p.id)).toEqual(['b', 'a']);
    auth.passkey.list.mockResolvedValueOnce(rows);
    expect((await listPasskeys())[1]).toMatchObject({ id: 'a', last_used_at: null });
  });

  it('rename trims, rejects empty names, and delete passes the id', async () => {
    auth.passkey.update.mockResolvedValue({ data: {}, error: null });
    await renamePasskey('p1', '  Phone  ');
    expect(auth.passkey.update).toHaveBeenCalledWith({ passkeyId: 'p1', friendlyName: 'Phone' });
    await expect(renamePasskey('p1', '   ')).rejects.toBeInstanceOf(PasskeyError);

    auth.passkey.delete.mockResolvedValue({ data: null, error: null });
    await deletePasskey('p1');
    expect(auth.passkey.delete).toHaveBeenCalledWith({ passkeyId: 'p1' });
    auth.passkey.delete.mockResolvedValue({ data: null, error: { code: 'webauthn_credential_not_found' } });
    await expect(deletePasskey('p1')).rejects.toMatchObject({ kind: 'not_found' });
  });
});
