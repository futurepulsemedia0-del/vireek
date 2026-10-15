import { describe, expect, it } from 'vitest';
import { buildSnapshotPdf } from '@/lib/dashboardSnapshotPdf';
import { WIDGET_CATALOG, buildPayload, periodFromDays } from '@/lib/dashboardSnapshot';

describe('buildSnapshotPdf', () => {
  const now = Date.UTC(2026, 9, 10, 15);
  const calls = Array.from({ length: 40 }, (_, i) => ({
    call_datetime: new Date(now - i * 3_600_000).toISOString(),
    status: i % 3 === 0 ? 'missed' : 'booked',
    is_emergency: false,
    sentiment: 'positive',
    lead_source: i % 2 ? 'google' : 'referral',
  }));

  it('renders every widget type into a valid PDF', () => {
    const payload = buildPayload({ calls, jobs: [], leads: [] }, WIDGET_CATALOG.map((w) => w.key), periodFromDays(30, now), now);
    const doc = buildSnapshotPdf({ title: 'Q3 update', audience: 'Accountant', businessName: 'Acme HVAC' }, payload);
    expect(doc.getNumberOfPages()).toBeGreaterThanOrEqual(1);
    expect(doc.output('arraybuffer').byteLength).toBeGreaterThan(1000);
  });

  it('handles empty data and long titles without throwing', () => {
    const payload = buildPayload({ calls: [], jobs: [], leads: [] }, WIDGET_CATALOG.map((w) => w.key), periodFromDays(90, now), now);
    expect(() => buildSnapshotPdf({ title: 'x '.repeat(40), audience: null, businessName: '' }, payload)).not.toThrow();
  });
});
