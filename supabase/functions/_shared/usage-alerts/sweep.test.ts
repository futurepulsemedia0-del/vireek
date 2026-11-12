import { describe, it, expect } from 'vitest';
import { runUsageAlertSweep } from './sweep';
import { acct, makeFake } from './testkit';

const NOW = new Date('2026-11-11T10:00:00Z');
const opts = { now: NOW, siteUrl: 'https://app.example.com' };
const many = (n: number) => Array.from({ length: n }, (_, i) => acct(`u${String(i).padStart(5, '0')}`, i % 10 === 0 ? 340 : 10));

describe('keyset pagination across >1,000 accounts', () => {
  it('visits every account exactly once, in id order, with a keyset cursor', async () => {
    const f = makeFake({ accounts: many(2500) });
    const s = await runUsageAlertSweep(f.ports, { ...opts, mode: 'live' });
    expect(s.scanned).toBe(2500);
    expect(s.pages).toBe(3);
    expect(s.candidates).toBe(250);
    expect(f.calls.emails).toHaveLength(250);
    expect(f.calls.pages[0]).toBeNull();
    expect(f.calls.pages[1]).toBe('u00999');
    expect(f.calls.pages[2]).toBe('u01999');
  });

  it('keeps going when the API caps rows below the page size (does not stop on a short page)', async () => {
    const f = makeFake({ accounts: many(2500), maxRows: 400 });
    const s = await runUsageAlertSweep(f.ports, { ...opts, mode: 'live' });
    expect(s.scanned).toBe(2500);
    expect(f.calls.emails).toHaveLength(250);
  });

  it('a second run in the same period sends nothing new', async () => {
    const f = makeFake({ accounts: many(1200) });
    await runUsageAlertSweep(f.ports, { ...opts, mode: 'live' });
    const before = f.calls.emails.length;
    await runUsageAlertSweep(f.ports, { ...opts, mode: 'live' });
    expect(f.calls.emails).toHaveLength(before);
  });
});

describe('modes, budget and isolation', () => {
  it('shadow mode reports what would be sent and sends/claims nothing', async () => {
    const f = makeFake({ accounts: many(100) });
    const s = await runUsageAlertSweep(f.ports, { ...opts, mode: 'shadow' });
    expect(s.would_send.minutes_80).toBe(10);
    expect(f.calls.emails).toHaveLength(0);
    expect(f.events.size).toBe(0);
  });

  it('stops at the time budget and reports truncated', async () => {
    const f = makeFake({ accounts: many(3000) });
    let t = 0;
    const s = await runUsageAlertSweep(f.ports, { ...opts, mode: 'live', budgetMs: 1000, clock: () => (t += 600) });
    expect(s.truncated).toBe(true);
    expect(s.pages).toBeGreaterThan(0);
    expect(s.pages).toBeLessThan(3);
  });

  it("one account's failure never aborts the run", async () => {
    const f = makeFake({ accounts: many(30), failClaimFor: 'u00010' });
    const s = await runUsageAlertSweep(f.ports, { ...opts, mode: 'live' });
    expect(s.errors).toBe(1);
    expect(f.calls.emails).toHaveLength(2); // u00000 and u00020
  });

  it('ignores suspended, enterprise and unlimited accounts', async () => {
    const f = makeFake({ accounts: [acct('a', 400, 400, { status: 'suspended' }), acct('b', 400, 400, { plan: 'enterprise' }), acct('c', 400, 0)] });
    const s = await runUsageAlertSweep(f.ports, { ...opts, mode: 'live' });
    expect(s.candidates).toBe(0);
  });
});
