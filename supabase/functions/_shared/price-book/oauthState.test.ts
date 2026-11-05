import { describe, expect, it } from 'vitest';
import { signState, verifyState } from './oauthState';

const SECRET = 'a'.repeat(64);
const USER = '8f6a3c1e-0000-4000-8000-000000000001';

describe('oauthState', () => {
  it('round-trips the user id', async () => {
    expect(await verifyState(await signState(USER, SECRET), SECRET)).toBe(USER);
  });
  it('produces a different state each time (nonce)', async () => {
    expect(await signState(USER, SECRET)).not.toBe(await signState(USER, SECRET));
  });
  it('rejects a wrong secret, an empty secret and a tampered user id', async () => {
    const s = await signState(USER, SECRET);
    expect(await verifyState(s, 'b'.repeat(64))).toBeNull();
    expect(await verifyState(s, '')).toBeNull();
    expect(await verifyState(s.replace(USER, USER.replace('1', '2')), SECRET)).toBeNull();
  });
  it('rejects malformed and legacy 3-part states', async () => {
    expect(await verifyState('garbage', SECRET)).toBeNull();
    expect(await verifyState(`${USER}.${Date.now()}.deadbeef`, SECRET)).toBeNull();
  });
  it('rejects an expired state', async () => {
    const real = Date.now;
    try {
      const s = await signState(USER, SECRET);
      Date.now = () => real() + 11 * 60 * 1000;
      expect(await verifyState(s, SECRET)).toBeNull();
    } finally {
      Date.now = real;
    }
  });
});
