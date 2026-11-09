import { describe, it, expect } from 'vitest';
import { createEntitlementChecker, requireEntitlement } from './requireEntitlement.ts';
import { HttpError } from '../http/core.ts';

const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';

function setup(answer: (tenant: string, module: string, call: number) => boolean | 'error' | 'bad' | 'throw') {
  let t = 0;
  let calls = 0;
  const rpc = async (_fn: string, args: Record<string, unknown>) => {
    const r = answer(String(args.p_tenant), String(args.p_module), calls);
    calls += 1;
    if (r === 'throw') throw new Error('network');
    if (r === 'error') return { data: null, error: { message: 'x' } };
    if (r === 'bad') return { data: 'yes', error: null };
    return { data: r, error: null };
  };
  return { ev: createEntitlementChecker({ rpc, now: () => t, ttlMs: 1000, maxStaleMs: 5000 }), advance: (ms: number) => { t += ms; }, calls: () => calls };
}

describe('entitlement checker (server)', () => {
  it('allows when the database says yes and denies when it says no', async () => {
    expect(await setup(() => true).ev.isEntitled(T1, 'pay')).toBe(true);
    expect(await setup(() => false).ev.isEntitled(T1, 'pay')).toBe(false);
  });
  it('denies invalid tenant ids and module ids without calling the database', async () => {
    const h = setup(() => true);
    expect(await h.ev.isEntitled('not-a-uuid', 'pay')).toBe(false);
    expect(await h.ev.isEntitled(T1, 'PAY')).toBe(false);
    expect(await h.ev.isEntitled(T1, "packs:'; drop")).toBe(false);
    expect(await h.ev.isEntitled(T1, '')).toBe(false);
    expect(h.calls()).toBe(0);
  });
  it('defaults to DENY when the service fails and nothing is cached', async () => {
    for (const mode of ['error', 'bad', 'throw'] as const) {
      expect(await setup(() => mode).ev.isEntitled(T1, 'pay')).toBe(false);
    }
  });
  it('caches per tenant AND per module (tenant A never sees tenant B result)', async () => {
    const h = setup((tenant, module) => tenant === T1 && module === 'pay');
    expect(await h.ev.isEntitled(T1, 'pay')).toBe(true);
    expect(await h.ev.isEntitled(T2, 'pay')).toBe(false);
    expect(await h.ev.isEntitled(T1, 'ai')).toBe(false);
    expect(await h.ev.isEntitled(T1, 'pay')).toBe(true);
    expect(h.calls()).toBe(3);
  });
  it('refreshes after the ttl so a revoke takes effect', async () => {
    const h = setup((_t, _m, call) => call === 0);
    expect(await h.ev.isEntitled(T1, 'pay')).toBe(true);
    h.advance(1500);
    expect(await h.ev.isEntitled(T1, 'pay')).toBe(false);
  });
  it('keeps a recent TRUE during an outage, then denies once too stale', async () => {
    const h = setup((_t, _m, call) => (call === 0 ? true : 'error'));
    expect(await h.ev.isEntitled(T1, 'pay')).toBe(true);
    h.advance(2000);
    expect(await h.ev.isEntitled(T1, 'pay')).toBe(true);
    h.advance(5000);
    expect(await h.ev.isEntitled(T1, 'pay')).toBe(false);
  });
  it('never reuses a cached FALSE as an allow during an outage', async () => {
    const h = setup((_t, _m, call) => (call === 0 ? false : 'error'));
    expect(await h.ev.isEntitled(T1, 'pay')).toBe(false);
    h.advance(2000);
    expect(await h.ev.isEntitled(T1, 'pay')).toBe(false);
  });
  it('shares one request across concurrent callers', async () => {
    const h = setup(() => true);
    await Promise.all([h.ev.isEntitled(T1, 'pay'), h.ev.isEntitled(T1, 'pay'), h.ev.isEntitled(T1, 'pay')]);
    expect(h.calls()).toBe(1);
  });
  it('requireEntitlement resolves when entitled and throws a 403-style HttpError when not', async () => {
    await expect(requireEntitlement(setup(() => true).ev, T1, 'pay')).resolves.toBeUndefined();
    const err = await requireEntitlement(setup(() => false).ev, T1, 'pay').catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).code).toBe('forbidden');
    expect((err as HttpError).details).toEqual({ code: 'module_not_entitled', module: 'pay' });
  });
});
