import { createHash, pbkdf2Sync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TOKEN_RE, hmacHex, pbkdf2Hex, randomHex, randomToken, sha256Hex, timingSafeEqualHex } from './crypto';

describe('doc-share crypto', () => {
  it('pbkdf2Hex matches node:crypto', async () => {
    const salt = randomHex(16);
    const expected = pbkdf2Sync('correct horse', Buffer.from(salt, 'hex'), 1000, 32, 'sha256').toString('hex');
    expect(await pbkdf2Hex('correct horse', salt, 1000)).toBe(expected);
    expect(await pbkdf2Hex('other', salt, 1000)).not.toBe(expected);
  });
  it('sha256Hex matches node:crypto', async () => {
    expect(await sha256Hex('abc')).toBe(createHash('sha256').update('abc').digest('hex'));
  });
  it('tokens are 43-char base64url and unique', () => {
    const a = randomToken();
    expect(TOKEN_RE.test(a)).toBe(true);
    expect(a).not.toBe(randomToken());
  });
  it('timingSafeEqualHex', () => {
    expect(timingSafeEqualHex('abcd', 'abcd')).toBe(true);
    expect(timingSafeEqualHex('abcd', 'abce')).toBe(false);
    expect(timingSafeEqualHex('abcd', 'abc')).toBe(false);
  });
  it('hmac depends on the secret', async () => {
    expect(await hmacHex('a', 'x')).not.toBe(await hmacHex('b', 'x'));
  });
});
