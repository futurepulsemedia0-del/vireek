import { describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => {
  const state = {
    session: { access_token: 't' } as unknown,
    aal: { data: { currentLevel: 'aal1', nextLevel: 'aal2' } as unknown, error: null as unknown },
    factors: { data: { totp: [{ id: 'f1', status: 'verified' }] } as unknown, error: null as unknown },
    challenge: { data: { id: 'c1' } as unknown, error: null as unknown },
    verify: { error: null as unknown },
    invoke: { data: null as unknown, error: null as unknown },
    refresh: { error: null as unknown },
    calls: [] as string[],
  };
  const supabase = {
    auth: {
      getSession: () => Promise.resolve({ data: { session: state.session } }),
      refreshSession: () => {
        state.calls.push('refresh');
        return Promise.resolve(state.refresh);
      },
      signOut: () => {
        state.calls.push('signOut');
        return Promise.resolve({});
      },
      mfa: {
        getAuthenticatorAssuranceLevel: () => Promise.resolve(state.aal),
        listFactors: () => Promise.resolve(state.factors),
        challenge: (a: unknown) => {
          state.calls.push(`challenge:${JSON.stringify(a)}`);
          return Promise.resolve(state.challenge);
        },
        verify: (a: unknown) => {
          state.calls.push(`verify:${JSON.stringify(a)}`);
          return Promise.resolve(state.verify);
        },
      },
    },
    functions: {
      invoke: (name: string, opts: { body: unknown }) => {
        state.calls.push(`invoke:${name}:${JSON.stringify(opts.body)}`);
        return Promise.resolve(state.invoke);
      },
    },
  };
  return { state, supabase };
});

vi.mock('@/lib/supabase', () => ({ supabase: fake.supabase }));

import {
  RECOVERY_ALPHABET,
  formatRecoveryInput,
  generateRecoveryCodes,
  getMfaGate,
  getRecoveryCodeCount,
  isRecoveryComplete,
  isTotpComplete,
  normalizeRecoveryCode,
  recoveryCodesFile,
  redeemRecoveryCode,
  safeNextPath,
  sanitizeTotp,
  toMfaError,
  verifyTotp,
} from '@/lib/mfaChallenge';
import * as server from '../../supabase/functions/_shared/mfa/recoveryCodes';

const reset = () => {
  const s = fake.state;
  s.session = { access_token: 't' };
  s.aal = { data: { currentLevel: 'aal1', nextLevel: 'aal2' }, error: null };
  s.factors = { data: { totp: [{ id: 'f1', status: 'verified' }] }, error: null };
  s.challenge = { data: { id: 'c1' }, error: null };
  s.verify = { error: null };
  s.invoke = { data: null, error: null };
  s.refresh = { error: null };
  s.calls = [];
};

describe('input helpers', () => {
  it('sanitises TOTP input to at most six digits', () => {
    expect(sanitizeTotp('12a 34-56789')).toBe('123456');
    expect(isTotpComplete('123456')).toBe(true);
    expect(isTotpComplete('12345')).toBe(false);
  });

  it('normalises and formats recovery codes while typing', () => {
    expect(normalizeRecoveryCode(' abcde-fghjk ')).toBe('ABCDEFGHJK');
    expect(normalizeRecoveryCode('ABCDEFGHJKMNP')).toBe('ABCDEFGHJK');
    expect(formatRecoveryInput('abcd')).toBe('ABCD');
    expect(formatRecoveryInput('abcdefgh')).toBe('ABCDE-FGH');
    expect(formatRecoveryInput('abcdefghjk')).toBe('ABCDE-FGHJK');
  });

  it('only accepts well-formed recovery codes (no ambiguous characters)', () => {
    expect(isRecoveryComplete('ABCDE-FGHJK')).toBe(true);
    expect(isRecoveryComplete('ABCDE-FGHJ')).toBe(false);
    expect(isRecoveryComplete('ABCDE-FGHJ0')).toBe(false); // 0 is not in the alphabet
    expect(isRecoveryComplete('ABCDE-FGHJO')).toBe(false);
  });
});

describe('safeNextPath', () => {
  it('allows same-site paths', () => {
    expect(safeNextPath('/dashboard/leads?x=1')).toBe('/dashboard/leads?x=1');
  });
  it('rejects open-redirect shapes, non-strings and the /mfa loop', () => {
    for (const bad of ['//evil.com', 'https://evil.com', '/\\evil.com', 'javascript:alert(1)', '/a\nb', 42, null, undefined, '/mfa', '/mfa?x=1', '/mfa/']) {
      expect(safeNextPath(bad, '/fallback')).toBe('/fallback');
    }
  });
});

describe('toMfaError', () => {
  it('classifies the common failures', () => {
    expect(toMfaError({ status: 429, message: 'x' }, 'totp').kind).toBe('rate-limited');
    expect(toMfaError({ message: 'Too many requests' }, 'totp').kind).toBe('rate-limited');
    expect(toMfaError({ name: 'AuthRetryableFetchError', message: 'Failed to fetch' }, 'totp').kind).toBe('network');
    expect(toMfaError({ message: 'MFA factor not found' }, 'totp').kind).toBe('expired');
    expect(toMfaError({ message: 'MFA challenge expired' }, 'totp').kind).toBe('expired');
    expect(toMfaError({ code: 'mfa_verification_failed', message: 'Invalid TOTP code entered', status: 400 }, 'totp').kind).toBe('invalid-code');
    expect(toMfaError({ message: 'weird' }, 'totp')).toEqual({ kind: 'unknown', message: 'weird' });
  });
  it('words invalid-code differently per mode', () => {
    expect(toMfaError({ status: 400 }, 'totp').message).toMatch(/authenticator/i);
    expect(toMfaError({ status: 400 }, 'recovery').message).toMatch(/already been used/i);
  });
});

describe('getMfaGate', () => {
  it('reports no session', async () => {
    reset();
    fake.state.session = null;
    expect(await getMfaGate()).toEqual({ kind: 'no-session' });
  });
  it('is ok when there is no second factor or the session is already AAL2', async () => {
    reset();
    fake.state.aal = { data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null };
    expect(await getMfaGate()).toEqual({ kind: 'ok' });
    fake.state.aal = { data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null };
    expect(await getMfaGate()).toEqual({ kind: 'ok' });
  });
  it('asks for a challenge using the verified TOTP factor only', async () => {
    reset();
    fake.state.factors = { data: { totp: [{ id: 'pending', status: 'unverified' }, { id: 'f9', status: 'verified' }] }, error: null };
    expect(await getMfaGate()).toEqual({ kind: 'challenge', factorId: 'f9' });
  });
  it('throws when the assurance level cannot be read (callers fail closed)', async () => {
    reset();
    fake.state.aal = { data: null, error: new Error('boom') };
    await expect(getMfaGate()).rejects.toThrow('boom');
  });
});

describe('verifyTotp / redeemRecoveryCode', () => {
  it('challenges then verifies with the same factor and challenge id', async () => {
    reset();
    await verifyTotp('f1', '123456');
    expect(fake.state.calls).toEqual(['challenge:{"factorId":"f1"}', 'verify:{"factorId":"f1","challengeId":"c1","code":"123456"}']);
  });
  it('propagates a wrong-code error and never claims success', async () => {
    reset();
    fake.state.verify = { error: Object.assign(new Error('Invalid TOTP code entered'), { status: 400 }) };
    await expect(verifyTotp('f1', '000000')).rejects.toThrow(/invalid/i);
  });
  it('sends the NORMALISED recovery code and refreshes the session on success', async () => {
    reset();
    fake.state.invoke = { data: { ok: true }, error: null };
    await redeemRecoveryCode('abcde-fghjk');
    expect(fake.state.calls).toEqual(['invoke:mfa-recovery:{"action":"redeem","code":"ABCDEFGHJK"}', 'refresh']);
  });
  it('unwraps edge-function error bodies and keeps the status', async () => {
    reset();
    fake.state.invoke = {
      data: null,
      error: { message: 'non-2xx', context: { status: 429, json: () => Promise.resolve({ detail: 'Too many incorrect codes.' }) } },
    };
    await expect(redeemRecoveryCode('ABCDEFGHJK')).rejects.toMatchObject({ message: 'Too many incorrect codes.', status: 429 });
    expect(fake.state.calls).not.toContain('refresh');
  });
  it('treats a body without ok:true as failure', async () => {
    reset();
    fake.state.invoke = { data: { ok: false }, error: null };
    await expect(redeemRecoveryCode('ABCDEFGHJK')).rejects.toThrow();
  });
});

describe('recovery code management', () => {
  it('reads the remaining count', async () => {
    reset();
    fake.state.invoke = { data: { remaining: 7 }, error: null };
    expect(await getRecoveryCodeCount()).toBe(7);
  });
  it('returns generated codes and tags AAL2_REQUIRED failures', async () => {
    reset();
    fake.state.invoke = { data: { codes: ['ABCDE-FGHJK'] }, error: null };
    expect(await generateRecoveryCodes()).toEqual(['ABCDE-FGHJK']);
    fake.state.invoke = {
      data: null,
      error: { message: 'x', context: { status: 403, json: () => Promise.resolve({ error: 'AAL2_REQUIRED', detail: 'Sign in again.' }) } },
    };
    await expect(generateRecoveryCodes()).rejects.toMatchObject({ code: 'AAL2_REQUIRED', message: 'Sign in again.' });
  });
  it('builds a download file without double blank lines', () => {
    const text = recoveryCodesFile(['AAAAA-BBBBB'], undefined, new Date('2026-10-09T00:00:00Z'));
    expect(text).toContain('Generated: 2026-10-09');
    expect(text).toContain('AAAAA-BBBBB');
    expect(text).not.toContain('Account:');
    expect(text).not.toMatch(/\n\n\n/);
  });
});

describe('server recovery helpers', () => {
  it('stays in sync with the browser alphabet and normaliser', () => {
    expect(server.ALPHABET).toBe(RECOVERY_ALPHABET);
    expect(server.CODE_LENGTH).toBe(10);
    for (const s of ['abcde-fghjk', ' ab cd ', 'ABC_123']) {
      expect(server.normalizeCode(s)).toBe(normalizeRecoveryCode(s));
    }
    expect(server.normalizeCode('abcde-fghjk')).toBe('ABCDEFGHJK');
  });

  it('generates well-formed, unique, unbiased codes', () => {
    const codes = server.generateCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(server.isWellFormed(c)).toBe(true);
    expect(server.formatCode(codes[0])).toMatch(/^[A-Z0-9]{5}-[A-Z0-9]{5}$/);

    // Bytes at or above the rejection limit (240) must never be used.
    const biased = server.generateCode((n) => new Uint8Array(n).fill(255).map((v, i) => (i < 12 ? v : 0)));
    expect(biased).toBe('AAAAAAAAAA');
    expect(server.isWellFormed('ABCDEFGHJ0')).toBe(false);
  });

  it('hashes deterministically, bound to the user and the pepper', async () => {
    const a = await server.hashCode('pepper', 'user-1', 'ABCDEFGHJK');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await server.hashCode('pepper', 'user-1', 'ABCDEFGHJK')).toBe(a);
    expect(await server.hashCode('pepper', 'user-2', 'ABCDEFGHJK')).not.toBe(a);
    expect(await server.hashCode('other', 'user-1', 'ABCDEFGHJK')).not.toBe(a);
  });

  it('reads JWT claims and tolerates garbage', () => {
    const payload = btoa(JSON.stringify({ aal: 'aal2' })).replace(/=+$/, '');
    expect(server.jwtClaim(`h.${payload}.s`, 'aal')).toBe('aal2');
    expect(server.jwtClaim('not-a-jwt', 'aal')).toBeUndefined();
  });
});
