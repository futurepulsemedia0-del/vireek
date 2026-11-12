import { describe, it, expect } from 'vitest';
import { buildMinutesAlert } from './copy';
import { deliverAlert, recordSuperseded } from './dispatch';
import { runUsageAlertSweep } from './sweep';
import { acct, makeFake } from './testkit';

const NOV = new Date('2026-11-11T10:00:00Z');
const sweep = (f: ReturnType<typeof makeFake>, now = NOV, mode: 'live' | 'shadow' = 'live') =>
  runUsageAlertSweep(f.ports, { now, siteUrl: 'https://app.example.com', mode });

describe('ACCEPTANCE: crossing 80% and 100% in one period', () => {
  it('sends exactly one email each, and SMS + push only at 100%', async () => {
    const a = acct('u1', 330);
    const f = makeFake({ accounts: [a] });

    await sweep(f); await sweep(f);                       // 82%, run twice: still one 80% alert
    expect(f.calls.emails).toHaveLength(1);
    expect(f.calls.sms).toHaveLength(0);
    expect(f.calls.notifications).toHaveLength(0);

    a.minutes_used_this_month = 400;                      // crosses 100%
    await sweep(f); await sweep(f); await sweep(f);
    expect(f.calls.emails).toHaveLength(2);
    expect(f.calls.sms).toHaveLength(1);
    expect(f.calls.notifications).toHaveLength(1);
    expect(f.calls.insights).toHaveLength(2);
    expect(f.calls.emails[0].subject).toContain('82%');
    expect(f.calls.emails[1].subject).toContain('all 400');
  });

  it('a new billing period resets the ledger', async () => {
    const f = makeFake({ accounts: [acct('u1', 340)] });
    await sweep(f);
    await sweep(f, new Date('2026-12-02T10:00:00Z'));
    expect(f.calls.emails).toHaveLength(2);
    expect(f.calls.insights).toHaveLength(2);
    expect(f.calls.insights[0]).toContain('2026-11');
    expect(f.calls.insights[1]).toContain('2026-12');
  });
});

describe('same-run jump and superseding', () => {
  it('sends only the 100% alert and records 80% as superseded', async () => {
    const f = makeFake({ accounts: [acct('u1', 420)] });
    const s = await sweep(f);
    expect(f.calls.emails).toHaveLength(1);
    expect(s.superseded).toBe(1);
    expect(f.events.get('u1|2026-11|minutes_80')?.channels.email).toBe('skipped:superseded');
    await sweep(f);
    expect(f.calls.emails).toHaveLength(1);
  });
});

describe('channels', () => {
  it('quiet-hours deferral counts as a terminal outcome (no re-send, no duplicate SMS)', async () => {
    const f = makeFake({ accounts: [acct('u1', 400)], smsOutcome: () => ({ status: 'deferred' }) });
    await sweep(f); await sweep(f);
    expect(f.events.get('u1|2026-11|minutes_100')?.channels.sms).toBe('deferred');
    expect(f.events.get('u1|2026-11|minutes_100')?.done).toBe(true);
    expect(f.calls.sms).toHaveLength(1);
  });

  it('retries only the failed channel on the next run', async () => {
    let failEmail = true;
    const f = makeFake({ accounts: [acct('u1', 400)], emailFails: () => failEmail });
    const first = await sweep(f);
    expect(first.partial).toBe(1);
    expect(f.calls.sms).toHaveLength(1);
    failEmail = false;
    await sweep(f);
    expect(f.calls.emails).toHaveLength(1);
    expect(f.calls.sms).toHaveLength(1);
    expect(f.calls.notifications).toHaveLength(1);
    expect(f.events.get('u1|2026-11|minutes_100')?.done).toBe(true);
  });

  it('skips SMS when the owner configured routing rules, or has no phone', async () => {
    const f1 = makeFake({ accounts: [acct('u1', 400)], routingRules: true });
    await sweep(f1);
    expect(f1.calls.sms).toHaveLength(0);
    expect(f1.events.get('u1|2026-11|minutes_100')?.channels.sms).toBe('skipped:owner_routing_rules');
    const f2 = makeFake({ accounts: [acct('u2', 400, 400, { phone: null })] });
    await sweep(f2);
    expect(f2.events.get('u2|2026-11|minutes_100')?.channels.sms).toBe('skipped:no_phone');
  });

  it('treats missing A2P approval / opt-out as skipped, not retried', async () => {
    const f = makeFake({ accounts: [acct('u1', 400)], smsOutcome: () => ({ status: 'skipped', reason: 'a2p_not_approved' }) });
    await sweep(f); await sweep(f);
    expect(f.events.get('u1|2026-11|minutes_100')?.done).toBe(true);
  });

  it('does not re-insert an in-app alert that already exists for the period', async () => {
    const a = acct('u1', 340);
    const f = makeFake({ accounts: [a] });
    const title = buildMinutesAlert('minutes_80', a, '2026-11').insight!.title;
    await f.ports.insertInsight('u1', { title, description: 'legacy', priority: 3 });
    await sweep(f);
    expect(f.calls.insights).toHaveLength(1);
  });
});

describe('direct dispatch', () => {
  it('a second deliverAlert for the same key is not claimed', async () => {
    const a = acct('u1', 340);
    const f = makeFake({ accounts: [a] });
    const content = buildMinutesAlert('minutes_80', a, '2026-11');
    const ctx = { periodKey: '2026-11', siteUrl: 'https://app.example.com' };
    expect((await deliverAlert(f.ports, a, 'minutes_80', content, ctx)).status).toBe('delivered');
    expect((await deliverAlert(f.ports, a, 'minutes_80', content, ctx)).status).toBe('not_claimed');
    expect(await recordSuperseded(f.ports, 'u1', 'minutes_80', '2026-11')).toBe(false);
  });
});
