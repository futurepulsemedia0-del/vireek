import { describe, it, expect } from 'vitest';
import { buildChangeRows, computeSnapshot, invoiceTotalCents, DAY_MS, type RawData } from './changesSinceYesterday';

const NOW = new Date(2026, 9, 2, 15, 0, 0).getTime();
const ago = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const empty: RawData = {
  invoices: [], calls: [], jobsCreated: [], jobsScheduled: [], reviews: [], dailyCapacity: null,
};
const inv = (o: Partial<RawData['invoices'] extends (infer U)[] | null ? U : never> = {}) => ({
  status: 'sent', sent_at: ago(100), paid_at: null, created_at: ago(100),
  line_items: [{ quantity: 1, unit_price_cents: 100_000 }], tax_percent: 0, ...o,
});

describe('invoiceTotalCents', () => {
  it('adds tax and ignores malformed lines', () => {
    expect(invoiceTotalCents({ line_items: [{ quantity: 2, unit_price_cents: 5000 }], tax_percent: 10 })).toBe(11_000);
    expect(invoiceTotalCents({ line_items: null, tax_percent: null })).toBe(0);
  });
});

describe('computeSnapshot + buildChangeRows', () => {
  it('shows nothing when nothing moved', () => {
    expect(buildChangeRows(computeSnapshot(empty, NOW))).toEqual([]);
  });

  it('hides unavailable sources instead of showing zero', () => {
    const snap = computeSnapshot({ ...empty, invoices: null, calls: null }, NOW);
    expect(snap.revenueCents).toBeNull();
    expect(snap.arCents).toBeNull();
    expect(snap.complaints).toBeNull();
  });

  it('computes revenue % from invoices paid in each 24h window', () => {
    const raw = { ...empty, invoices: [
      inv({ status: 'paid', paid_at: ago(5) }), inv({ status: 'paid', paid_at: ago(5) }),
      inv({ status: 'paid', paid_at: ago(30) }),
    ] };
    const rows = buildChangeRows(computeSnapshot(raw, NOW));
    expect(rows.find((r) => r.key === 'revenue')).toMatchObject({ display: '+100%', tone: 'good' });
  });

  it('AR: unpaid-now minus unpaid-24h-ago, paid invoices drop out', () => {
    const raw = { ...empty, invoices: [
      inv({ sent_at: ago(2) }),                              // new -> +1000
      inv({ status: 'paid', paid_at: ago(3) }),              // settled today -> -1000
      inv({ status: 'draft' }), inv({ status: 'void' }),     // ignored
    ] };
    const snap = computeSnapshot(raw, NOW);
    expect(snap.arCents).toEqual({ current: 100_000, previous: 100_000 });
  });

  it('flags a new complaint (low review or negative call) as bad', () => {
    const raw = { ...empty,
      calls: [{ call_datetime: ago(2), sentiment: 'negative' }],
      reviews: [{ rating: 1, completed_at: ago(3) }, { rating: 5, completed_at: ago(3) }] };
    const row = buildChangeRows(computeSnapshot(raw, NOW)).find((r) => r.key === 'complaints');
    expect(row).toMatchObject({ display: '+2', tone: 'bad', direction: 'up' });
  });

  it('uses count (not %) when the call baseline is tiny', () => {
    const raw = { ...empty, calls: Array.from({ length: 4 }, () => ({ call_datetime: ago(1), sentiment: null })) };
    expect(buildChangeRows(computeSnapshot(raw, NOW)).find((r) => r.key === 'calls')?.display).toBe('+4');
  });

  it('capacity: open-capacity change in points, ignores cancelled', () => {
    const today = new Date(2026, 9, 2, 10).toISOString();
    const yday = new Date(2026, 9, 1, 10).toISOString();
    const raw = { ...empty, dailyCapacity: 10, jobsScheduled: [
      ...Array.from({ length: 8 }, () => ({ scheduled_datetime: today, job_status: 'scheduled' })),
      { scheduled_datetime: today, job_status: 'cancelled' },
      ...Array.from({ length: 2 }, () => ({ scheduled_datetime: yday, job_status: 'completed' })),
    ] };
    const row = buildChangeRows(computeSnapshot(raw, NOW)).find((r) => r.key === 'capacity');
    expect(row).toMatchObject({ display: '−60 pts', tone: 'neutral' });
  });

  it('window length sanity', () => expect(DAY_MS).toBe(86_400_000));
});
