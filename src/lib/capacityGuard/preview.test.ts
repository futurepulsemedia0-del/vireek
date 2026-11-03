import { describe, expect, it } from 'vitest';
import { replayLastWeek, type ReplayJob } from './preview';

const dayKeyOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const base = { technicians: 3, maxJobsPerDay: 6, waitlistSize: 5, dayKeyOf, settings: { hold_share_pct: 20, trade_rules: [{ trade: 'replacement', hold_share_pct: 20 }], backfill_max_offers_per_customer_24h: 1, backfill_max_offers_per_customer_7d: 2, backfill_offer_ttl_minutes: 20, backfill_batch_size: 3 } };
const job = (o: Partial<ReplayJob>): ReplayJob => ({ service_type: 'AC replacement', created_at: '2026-10-26T10:00:00Z', scheduled_datetime: '2026-10-27T10:00:00Z', job_status: 'completed', invoice_amount: 8000, ...o });

describe('replayLastWeek', () => {
  it('is labelled simulated and counts real arrivals/value', () => {
    const r = replayLastWeek({ ...base, jobs: [job({}), job({ service_type: 'Drain' })] });
    expect(r.holds.simulated).toBe(true);
    expect(r.backfill.simulated).toBe(true);
    expect(r.holds.used).toBe(1);
    expect(r.holds.protectedCents).toBe(800_000);
  });
  it('counts cancellations as backfill gaps and never exceeds them', () => {
    const r = replayLastWeek({ ...base, jobs: [job({ job_status: 'cancelled' }), job({ job_status: 'no_show' })] });
    expect(r.cancellations).toBe(2);
    expect(r.backfill.gaps).toBe(2);
    expect(r.backfill.filled).toBeLessThanOrEqual(2);
  });
  it('no trade rules => nothing held', () => {
    const r = replayLastWeek({ ...base, settings: { ...base.settings, trade_rules: [] }, jobs: [job({})] });
    expect(r.holds.held).toBe(0);
  });
  it('empty week is safe', () => { const r = replayLastWeek({ ...base, jobs: [] }); expect(r.holds.held).toBe(0); expect(r.backfill.gaps).toBe(0); });
});
