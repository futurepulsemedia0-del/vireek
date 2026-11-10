import { describe, it, expect } from 'vitest';
import {
  classifyAiError,
  createKeyPool,
  parseKeyEntries,
  shouldPersist,
  withKeyFailover,
} from './keyPool.ts';
import type { KeyEvent } from './keyPool.ts';
import { AiCoreError } from './types.ts';

const K1 = 'AIzaSyAAAAAAAAAAAAAA1';
const K2 = 'AIzaSyBBBBBBBBBBBBBB2';
const K3 = 'AIzaSyCCCCCCCCCCCCCC3';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('parseKeyEntries', () => {
  it('puts the legacy single key first and keeps order', () => {
    const keys = parseKeyEntries(`${K2}, ${K3}`, K1);
    expect(keys.map((k) => k.secret)).toEqual([K1, K2, K3]);
    expect(keys[0].label).toBe('default');
  });

  it('supports label=secret and bare secrets, newline or comma separated', () => {
    const keys = parseKeyEntries(`main=${K1}\n${K2}`, undefined);
    expect(keys[0]).toEqual({ label: 'main', secret: K1 });
    expect(keys[1].secret).toBe(K2);
  });

  it('dedupes identical secrets and ignores empty/too-short entries', () => {
    const keys = parseKeyEntries(`${K1},${K1}, ,short`, K1);
    expect(keys).toHaveLength(1);
  });

  it('keeps labels unique', () => {
    const keys = parseKeyEntries(`a=${K1},a=${K2}`, undefined);
    expect(new Set(keys.map((k) => k.label)).size).toBe(2);
  });

  it('treats base64-style padding as part of a bare secret, not a label', () => {
    const secret = 'abcdefghijkl==';
    const keys = parseKeyEntries(secret, undefined);
    expect(keys[0].secret).toBe(secret);
  });

  it('returns an empty list when nothing is configured', () => {
    expect(parseKeyEntries(undefined, undefined)).toEqual([]);
  });
});

describe('createKeyPool.acquire', () => {
  it('is sticky: always returns the first usable key', () => {
    const pool = createKeyPool('gemini', parseKeyEntries(`${K2}`, K1));
    for (let i = 0; i < 5; i++) {
      const r = pool.acquire();
      expect(r.ok && r.key.secret).toBe(K1);
    }
  });

  it('reports no_keys for an empty pool', () => {
    const r = createKeyPool('gemini', []).acquire();
    expect(r).toMatchObject({ ok: false, reason: 'no_keys' });
  });

  it('quarantines a key after AUTH and moves to the next key', () => {
    const c = clock();
    const pool = createKeyPool('gemini', parseKeyEntries(K2, K1), { now: c.now });
    pool.reportFailure('default', 'AUTH');
    const r = pool.acquire();
    expect(r.ok && r.key.secret).toBe(K2);
  });

  it('restores the quarantined key after the cool-down', () => {
    const c = clock();
    const pool = createKeyPool('gemini', parseKeyEntries(K2, K1), { now: c.now, authCooldownMs: 60_000 });
    pool.reportFailure('default', 'AUTH');
    c.advance(60_001);
    const r = pool.acquire();
    expect(r.ok && r.key.secret).toBe(K1);
  });

  it('NEVER switches to a sibling key on RATE_LIMIT (no quota bypass)', () => {
    const c = clock();
    const pool = createKeyPool('gemini', parseKeyEntries(K2, K1), { now: c.now });
    pool.reportFailure('default', 'RATE_LIMIT');
    const r = pool.acquire();
    expect(r).toMatchObject({ ok: false, reason: 'rate_limited' });
    expect(r.ok).toBe(false);
  });

  it('allows the same key again once the rate-limit cool-down ends', () => {
    const c = clock();
    const pool = createKeyPool('gemini', parseKeyEntries(K2, K1), { now: c.now, defaultRateLimitCooldownMs: 30_000 });
    pool.reportFailure('default', 'RATE_LIMIT');
    c.advance(30_001);
    const r = pool.acquire();
    expect(r.ok && r.key.label).toBe('default');
  });

  it('caps the cool-down and honours a shorter retry-after hint', () => {
    const c = clock();
    const pool = createKeyPool('gemini', parseKeyEntries(undefined, K1), { now: c.now, maxRateLimitCooldownMs: 120_000 });
    pool.reportFailure('default', 'RATE_LIMIT', 10 * 60_000);
    const r = pool.acquire();
    expect(!r.ok && r.retryAfterMs).toBeLessThanOrEqual(120_000);
  });

  it('reports all_quarantined when every key was rejected', () => {
    const pool = createKeyPool('gemini', parseKeyEntries(K2, K1));
    pool.reportFailure('default', 'AUTH');
    pool.reportFailure('k1', 'AUTH');
    expect(pool.acquire()).toMatchObject({ ok: false, reason: 'all_quarantined' });
  });

  it('OTHER failures neither quarantine nor cool down', () => {
    const pool = createKeyPool('gemini', parseKeyEntries(K2, K1));
    pool.reportFailure('default', 'OTHER');
    const r = pool.acquire();
    expect(r.ok && r.key.label).toBe('default');
  });

  it('snapshot never contains secrets', () => {
    const pool = createKeyPool('gemini', parseKeyEntries(K2, K1));
    expect(JSON.stringify(pool.snapshot())).not.toContain('AIza');
  });

  it('a throwing onEvent hook cannot break the pool', () => {
    const pool = createKeyPool('gemini', parseKeyEntries(undefined, K1), { onEvent: () => { throw new Error('boom'); } });
    expect(() => pool.reportFailure('default', 'AUTH')).not.toThrow();
  });
});

describe('withKeyFailover', () => {
  const authErr = () => new AiCoreError('AUTH', 'bad key', 'gemini');
  const rlErr = () => new AiCoreError('RATE_LIMIT', 'slow down', 'gemini');

  it('returns the result and uses only the first key on success', async () => {
    const pool = createKeyPool('gemini', parseKeyEntries(K2, K1));
    const used: string[] = [];
    const out = await withKeyFailover(pool, 'gemini', async (k) => { used.push(k); return 'ok'; });
    expect(out).toBe('ok');
    expect(used).toEqual([K1]);
  });

  it('fails over to the next key after AUTH, exactly once per key', async () => {
    const pool = createKeyPool('gemini', parseKeyEntries(K2, K1));
    const used: string[] = [];
    const out = await withKeyFailover(pool, 'gemini', async (k) => {
      used.push(k);
      if (k === K1) throw authErr();
      return 'ok';
    });
    expect(out).toBe('ok');
    expect(used).toEqual([K1, K2]);
  });

  it('does NOT try another key after RATE_LIMIT and surfaces the error for provider fallback', async () => {
    const pool = createKeyPool('gemini', parseKeyEntries(K2, K1));
    const used: string[] = [];
    await expect(
      withKeyFailover(pool, 'gemini', async (k) => { used.push(k); throw rlErr(); }),
    ).rejects.toMatchObject({ code: 'RATE_LIMIT' });
    expect(used).toEqual([K1]);
  });

  it('short-circuits without a network call while cooling down', async () => {
    const pool = createKeyPool('gemini', parseKeyEntries(K2, K1));
    pool.reportFailure('default', 'RATE_LIMIT');
    let called = 0;
    await expect(withKeyFailover(pool, 'gemini', async () => { called++; return 'x'; })).rejects.toMatchObject({ code: 'RATE_LIMIT' });
    expect(called).toBe(0);
  });

  it('does not retry on non-auth provider errors', async () => {
    const pool = createKeyPool('gemini', parseKeyEntries(K2, K1));
    let called = 0;
    await expect(
      withKeyFailover(pool, 'gemini', async () => { called++; throw new AiCoreError('PROVIDER_ERROR', '500', 'gemini'); }),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(called).toBe(1);
  });

  it('terminates and rethrows AUTH when every key is rejected', async () => {
    const pool = createKeyPool('gemini', parseKeyEntries(`${K2},${K3}`, K1));
    let called = 0;
    await expect(withKeyFailover(pool, 'gemini', async () => { called++; throw authErr(); })).rejects.toMatchObject({ code: 'AUTH' });
    expect(called).toBe(3);
  });

  it('throws NOT_CONFIGURED for an empty pool', async () => {
    const pool = createKeyPool('gemini', []);
    await expect(withKeyFailover(pool, 'gemini', async () => 'x')).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
  });

  it('emits health events without secrets', async () => {
    const events: KeyEvent[] = [];
    const pool = createKeyPool('gemini', parseKeyEntries(undefined, K1), { onEvent: (e) => events.push(e) });
    await withKeyFailover(pool, 'gemini', async () => 'ok');
    expect(events[0]).toMatchObject({ provider: 'gemini', label: 'default', kind: 'success' });
    expect(JSON.stringify(events)).not.toContain('AIza');
  });
});

describe('classifyAiError / shouldPersist', () => {
  it('classifies AiCoreError codes and unknown errors', () => {
    expect(classifyAiError(new AiCoreError('AUTH', 'x'))).toBe('AUTH');
    expect(classifyAiError(new AiCoreError('RATE_LIMIT', 'x'))).toBe('RATE_LIMIT');
    expect(classifyAiError(new AiCoreError('TIMEOUT', 'x'))).toBe('OTHER');
    expect(classifyAiError(new Error('x'))).toBe('OTHER');
  });

  it('throttles repeated persistence', () => {
    const ev = (kind: KeyEvent['kind'], at: number): KeyEvent => ({ provider: 'gemini', label: 'a', kind, at, cooldownUntil: null });
    expect(shouldPersist(ev('success', 1000), undefined)).toBe(true);
    expect(shouldPersist(ev('success', 2000), 1000)).toBe(false);
    expect(shouldPersist(ev('success', 1000 + 300_000), 1000)).toBe(true);
    expect(shouldPersist(ev('AUTH', 5000), 1000)).toBe(false);
    expect(shouldPersist(ev('AUTH', 11_000), 1000)).toBe(true);
  });
});
