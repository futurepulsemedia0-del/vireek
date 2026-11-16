import { describe, expect, it } from 'vitest';
import { signState, verifyState } from './oauthState';
import { consumeOAuthStateNonce, stateNonce } from './oauthStateNonce';

const SECRET = 'a'.repeat(64);
const USER = '8f6a3c1e-0000-4000-8000-000000000001';

/** In-memory stand-in for the oauth_state_consume RPC: first call per nonce -> true, replay -> false. */
function fakeRpc() {
  const seen = new Set<string>();
  return async (_fn: string, args: Record<string, unknown>) => {
    const n = String(args.p_nonce);
    if (seen.has(n)) return { data: false, error: null };
    seen.add(n);
    return { data: true, error: null };
  };
}

describe('oauth state single use', () => {
  it('extracts the nonce of a real signed state and rejects malformed ones', async () => {
    const s = await signState(USER, SECRET);
    expect(stateNonce(s)).toMatch(/^[0-9a-f]{24}$/);
    expect(stateNonce('garbage')).toBeNull();
    expect(stateNonce(`${USER}.1.nothex.sig`)).toBeNull();
  });
  it('accepts a verified state once and rejects the replay', async () => {
    const rpc = fakeRpc();
    const s = await signState(USER, SECRET);
    expect(await verifyState(s, SECRET)).toBe(USER);
    expect(await consumeOAuthStateNonce(s, 'jobber', rpc)).toBe(true);
    expect(await consumeOAuthStateNonce(s, 'jobber', rpc)).toBe(false);
  });
  it('two different states are independent', async () => {
    const rpc = fakeRpc();
    expect(await consumeOAuthStateNonce(await signState(USER, SECRET), 'jobber', rpc)).toBe(true);
    expect(await consumeOAuthStateNonce(await signState(USER, SECRET), 'jobber', rpc)).toBe(true);
  });
  it('fails closed on RPC error, thrown error, or non-true data', async () => {
    const s = await signState(USER, SECRET);
    expect(await consumeOAuthStateNonce(s, 'jobber', async () => ({ data: null, error: { message: 'x' } }))).toBe(false);
    expect(await consumeOAuthStateNonce(s, 'jobber', async () => { throw new Error('net'); })).toBe(false);
    expect(await consumeOAuthStateNonce(s, 'jobber', async () => ({ data: 'true', error: null }))).toBe(false);
    expect(await consumeOAuthStateNonce('garbage', 'jobber', fakeRpc())).toBe(false);
  });
});
