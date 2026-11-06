import { describe, it, expect } from 'vitest';
import { createKillSwitchGuard, parseSnapshot } from './killSwitch.ts';

const T1 = '11111111-1111-1111-1111-111111111111';
const T2 = '22222222-2222-2222-2222-222222222222';

function harness(responses: Array<unknown | Error>) {
  let t = 0;
  let calls = 0;
  const load = async () => {
    const r = responses[Math.min(calls, responses.length - 1)];
    calls += 1;
    if (r instanceof Error) throw r;
    return r;
  };
  const guard = createKillSwitchGuard({ load, now: () => t, ttlMs: 1000, maxStaleMs: 5000 });
  return { guard, advance: (ms: number) => { t += ms; }, calls: () => calls };
}

describe('kill switch guard', () => {
  it('stops a capability globally', async () => {
    const h = harness([{ global: ['outbound_dialer'], orgs: [] }]);
    expect(await h.guard.isStopped('outbound_dialer', T1)).toBe(true);
    expect(await h.guard.isStopped('sms_campaigns', T1)).toBe(false);
  });

  it('stops only the targeted org', async () => {
    const h = harness([{ global: [], orgs: [{ key: 'auto_replies', tenant_id: T1 }] }]);
    expect(await h.guard.isStopped('auto_replies', T1)).toBe(true);
    expect(await h.guard.isStopped('auto_replies', T2)).toBe(false);
    expect(await h.guard.isStopped('auto_replies')).toBe(false);
  });

  it('caches within the ttl and refreshes after it', async () => {
    const h = harness([{ global: [], orgs: [] }, { global: ['sms_campaigns'], orgs: [] }]);
    expect(await h.guard.isStopped('sms_campaigns')).toBe(false);
    h.advance(500);
    expect(await h.guard.isStopped('sms_campaigns')).toBe(false);
    expect(h.calls()).toBe(1);
    h.advance(600);
    expect(await h.guard.isStopped('sms_campaigns')).toBe(true);
    expect(h.calls()).toBe(2);
  });

  it('shares one request across concurrent callers', async () => {
    const h = harness([{ global: [], orgs: [] }]);
    await Promise.all([h.guard.isStopped('voice_cloning'), h.guard.isStopped('auto_replies'), h.guard.isStopped('sms_campaigns')]);
    expect(h.calls()).toBe(1);
  });

  it('fails closed when the first load fails', async () => {
    const h = harness([new Error('db down')]);
    expect(await h.guard.isStopped('outbound_dialer', T1)).toBe(true);
  });

  it('keeps the last good state during a blip, then fails closed once too stale', async () => {
    const h = harness([{ global: [], orgs: [] }, new Error('db down')]);
    expect(await h.guard.isStopped('price_auto_apply')).toBe(false);
    h.advance(2000);
    expect(await h.guard.isStopped('price_auto_apply')).toBe(false); // blip: last known good
    h.advance(4000);
    expect(await h.guard.isStopped('price_auto_apply')).toBe(true); // stale > maxStaleMs
  });

  it('keeps a known stop in place when the refresh fails', async () => {
    const h = harness([{ global: ['agent_auto_actions'], orgs: [] }, new Error('db down')]);
    expect(await h.guard.isStopped('agent_auto_actions')).toBe(true);
    h.advance(2000);
    expect(await h.guard.isStopped('agent_auto_actions')).toBe(true);
  });

  it('treats a malformed payload as a failed load (fail closed)', async () => {
    const h = harness([{ global: 'nope' }]);
    expect(await h.guard.isStopped('marketplace_ingestion')).toBe(true);
    expect(parseSnapshot({ global: [1], orgs: [] })).toBeNull();
    expect(parseSnapshot({ global: [], orgs: [{ key: 'x' }] })).toBeNull();
  });
});
