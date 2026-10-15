import { describe, expect, it } from 'vitest';
import {
  WIDGET_CATALOG,
  buildPayload,
  computeWidgets,
  expiryLabel,
  isValidShareToken,
  periodFromDays,
  sanitizePayload,
  shareUrl,
  snapshotFilename,
  snapshotStatus,
  validateOptions,
  type CallRow,
  type JobRow,
  type LeadRow,
  type SnapshotSource,
  type WidgetData,
} from '@/lib/dashboardSnapshot';

const NOW = Date.UTC(2026, 9, 10, 15, 0, 0); // 2026-10-10 15:00 UTC
const day = (offset: number, hour = 12) => new Date(Date.UTC(2026, 9, 10 + offset, hour)).toISOString();

const call = (over: Partial<CallRow> = {}): CallRow => ({
  call_datetime: day(0),
  status: 'booked',
  is_emergency: false,
  sentiment: 'positive',
  lead_source: 'google',
  ...over,
});
const job = (over: Partial<JobRow> = {}): JobRow => ({
  created_at: day(0),
  job_status: 'completed',
  invoice_status: 'paid',
  invoice_amount: 500,
  ...over,
});
const lead = (over: Partial<LeadRow> = {}): LeadRow => ({ created_at: day(0), stage: 'won', ...over });

const kpi = (w: WidgetData[], key: string) => {
  const f = w.find((x) => x.key === key);
  if (!f || f.kind !== 'kpi') throw new Error(`no kpi ${key}`);
  return f;
};

describe('periodFromDays', () => {
  it('is UTC-day aligned and includes today', () => {
    const p = periodFromDays(7, NOW);
    expect(p.endMs - p.startMs).toBe(7 * 86_400_000);
    expect(new Date(p.startMs).toISOString()).toBe('2026-10-04T00:00:00.000Z');
    expect(new Date(p.endMs).toISOString()).toBe('2026-10-11T00:00:00.000Z');
  });
});

describe('computeWidgets', () => {
  const p = periodFromDays(30, NOW);

  it('computes overview KPIs using the Overview page definitions', () => {
    const src: SnapshotSource = {
      calls: [call(), call({ status: 'missed', sentiment: null }), call({ is_emergency: true, sentiment: 'negative' }), call({ status: 'missed', sentiment: 'positive' })],
      jobs: [job(), job({ invoice_amount: 250.4 }), job({ invoice_status: 'sent', job_status: 'scheduled', invoice_amount: 9999 })],
      leads: [lead(), lead({ stage: 'new' }), lead({ stage: 'lost' }), lead({ stage: 'won' })],
    };
    const w = computeWidgets(src, ['calls_total', 'missed_call_rate', 'emergency_calls', 'jobs_completed', 'revenue_collected', 'lead_conversion', 'positive_sentiment'], p);
    expect(kpi(w, 'calls_total').value).toBe('4');
    expect(kpi(w, 'missed_call_rate').value).toBe('50%');
    expect(kpi(w, 'emergency_calls').value).toBe('1');
    expect(kpi(w, 'jobs_completed').value).toBe('2');
    expect(kpi(w, 'revenue_collected').value).toBe('$750');
    expect(kpi(w, 'lead_conversion').value).toBe('50%');
    expect(kpi(w, 'positive_sentiment').value).toBe('67%');
  });

  it('shows an em dash instead of dividing by zero', () => {
    const w = computeWidgets({ calls: [], jobs: [], leads: [] }, ['missed_call_rate', 'lead_conversion', 'positive_sentiment', 'revenue_collected'], p);
    expect(kpi(w, 'missed_call_rate').value).toBe('—');
    expect(kpi(w, 'lead_conversion').value).toBe('—');
    expect(kpi(w, 'positive_sentiment').value).toBe('—');
    expect(kpi(w, 'revenue_collected').value).toBe('$0');
  });

  it('ignores rows outside the period (both ends)', () => {
    const src: SnapshotSource = {
      calls: [call({ call_datetime: day(-31) }), call({ call_datetime: day(1) }), call({ call_datetime: day(-29, 0) }), call()],
      jobs: [],
      leads: [],
    };
    expect(kpi(computeWidgets(src, ['calls_total'], p), 'calls_total').value).toBe('2');
  });

  it('ignores rows with unparseable dates', () => {
    const src: SnapshotSource = { calls: [call({ call_datetime: 'not-a-date' })], jobs: [], leads: [] };
    expect(kpi(computeWidgets(src, ['calls_total'], p), 'calls_total').value).toBe('0');
  });

  it('buckets the trend daily for short periods and weekly for long ones', () => {
    const src: SnapshotSource = { calls: [call({ call_datetime: day(0) }), call({ call_datetime: day(0, 1) }), call({ call_datetime: day(-1) })], jobs: [], leads: [] };
    const daily = computeWidgets(src, ['call_volume_trend'], periodFromDays(7, NOW))[0];
    if (daily.kind !== 'series') throw new Error('series expected');
    expect(daily.points).toHaveLength(7);
    expect(daily.points[6]).toEqual({ label: 'Oct 10', value: 2 });
    expect(daily.points[5].value).toBe(1);

    const weekly = computeWidgets(src, ['call_volume_trend'], periodFromDays(90, NOW))[0];
    if (weekly.kind !== 'series') throw new Error('series expected');
    expect(weekly.points).toHaveLength(13);
    expect(weekly.points.reduce((s, x) => s + x.value, 0)).toBe(3);
  });

  it('ranks lead sources by bookings and labels unknowns', () => {
    const src: SnapshotSource = {
      calls: [call({ lead_source: 'google' }), call({ lead_source: 'google', status: 'missed' }), call({ lead_source: 'facebook_ads' }), call({ lead_source: 'facebook_ads' }), call({ lead_source: null, status: 'missed' })],
      jobs: [],
      leads: [],
    };
    const t = computeWidgets(src, ['lead_sources'], p)[0];
    if (t.kind !== 'table') throw new Error('table expected');
    expect(t.rows[0]).toEqual(['Facebook Ads', '2', '2', '100%']);
    expect(t.rows[1]).toEqual(['Google', '2', '1', '50%']);
    expect(t.rows[2][0]).toBe('Unknown');
  });

  it('summarises call outcomes with shares', () => {
    const src: SnapshotSource = { calls: [call(), call(), call({ status: 'missed' }), call({ status: null })], jobs: [], leads: [] };
    const t = computeWidgets(src, ['call_outcomes'], p)[0];
    if (t.kind !== 'table') throw new Error('table expected');
    expect(t.rows[0]).toEqual(['Booked', '2', '50%']);
  });

  it('contains no personal data: output holds only aggregates', () => {
    const src: SnapshotSource = { calls: [call()], jobs: [job()], leads: [lead()] };
    const json = JSON.stringify(computeWidgets(src, WIDGET_CATALOG.map((w) => w.key), p));
    expect(json).not.toMatch(/phone|email|transcript|customer/i);
  });
});

describe('buildPayload', () => {
  it('stamps version, period and widgets', () => {
    const p = periodFromDays(7, NOW);
    const payload = buildPayload({ calls: [call()], jobs: [], leads: [] }, ['calls_total'], p, NOW);
    expect(payload.version).toBe(1);
    expect(payload.generatedAt).toBe(new Date(NOW).toISOString());
    expect(payload.period.days).toBe(7);
    expect(payload.widgets).toHaveLength(1);
  });
});

describe('validateOptions', () => {
  const base = { title: ' Q3 update ', audience: ' Accountant ', periodDays: 30, expiryDays: 14, widgetKeys: ['revenue_collected', 'calls_total'] };
  it('accepts valid input, trims, and orders widgets by catalog', () => {
    const r = validateOptions(base);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.title).toBe('Q3 update');
      expect(r.value.audience).toBe('Accountant');
      expect(r.value.widgetKeys).toEqual(['calls_total', 'revenue_collected']);
    }
  });
  it('rejects bad input with specific errors', () => {
    const r = validateOptions({ title: '', audience: 'x'.repeat(81), periodDays: 5, expiryDays: 0, widgetKeys: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBe(5);
  });
  it('rejects unknown widgets and non-integer expiry', () => {
    expect(validateOptions({ ...base, widgetKeys: ['calls_total', 'customer_list'] }).ok).toBe(false);
    expect(validateOptions({ ...base, expiryDays: 1.5 }).ok).toBe(false);
    expect(validateOptions({ ...base, expiryDays: 91 }).ok).toBe(false);
  });
});

describe('sanitizePayload', () => {
  const good = buildPayload({ calls: [call()], jobs: [job()], leads: [lead()] }, WIDGET_CATALOG.map((w) => w.key), periodFromDays(30, NOW), NOW);

  it('round-trips a valid payload', () => {
    expect(sanitizePayload(JSON.parse(JSON.stringify(good)))?.widgets).toHaveLength(WIDGET_CATALOG.length);
  });
  it('rejects garbage', () => {
    expect(sanitizePayload(null)).toBeNull();
    expect(sanitizePayload('x')).toBeNull();
    expect(sanitizePayload({ version: 2, widgets: [], period: { days: 7 } })).toBeNull();
    expect(sanitizePayload({ version: 1, widgets: 'no', period: { days: 7 } })).toBeNull();
    expect(sanitizePayload({ version: 1, widgets: [] })).toBeNull();
  });
  it('drops unknown widgets and kind mismatches', () => {
    const r = sanitizePayload({
      version: 1,
      generatedAt: 'x',
      period: { start: 'a', end: 'b', days: 7 },
      widgets: [{ key: 'evil', kind: 'kpi', value: '1' }, { key: 'calls_total', kind: 'table', columns: [], rows: [] }, { key: 'calls_total', kind: 'kpi', value: '5' }],
    });
    expect(r?.widgets).toEqual([{ key: 'calls_total', kind: 'kpi', value: '5', hint: undefined }]);
  });
  it('caps sizes and strips non-numeric series points', () => {
    const r = sanitizePayload({
      version: 1,
      generatedAt: 'x',
      period: { start: 'a', end: 'b', days: 9999 },
      widgets: [
        { key: 'call_volume_trend', kind: 'series', points: [{ label: 'a', value: 1 }, { label: 'b', value: 'NaN' }, { label: 'c', value: -3 }] },
        { key: 'lead_sources', kind: 'table', columns: ['A'], rows: Array.from({ length: 80 }, () => ['x'.repeat(200), 'extra']) },
      ],
    });
    expect(r?.period.days).toBe(366);
    const series = r?.widgets[0];
    expect(series && series.kind === 'series' ? series.points : []).toEqual([{ label: 'a', value: 1 }]);
    const table = r?.widgets[1];
    if (!table || table.kind !== 'table') throw new Error('table expected');
    expect(table.rows).toHaveLength(50);
    expect(table.rows[0]).toHaveLength(1);
    expect(table.rows[0][0]).toHaveLength(60);
  });
});

describe('links and status', () => {
  it('validates token shape (64 lowercase hex)', () => {
    expect(isValidShareToken('a'.repeat(64))).toBe(true);
    expect(isValidShareToken('A'.repeat(64))).toBe(false);
    expect(isValidShareToken('a'.repeat(63))).toBe(false);
    expect(isValidShareToken('../../etc/passwd')).toBe(false);
    expect(isValidShareToken(undefined)).toBe(false);
  });
  it('builds a share URL without double slashes', () => {
    expect(shareUrl('https://app.vireek.com/', 'a'.repeat(64))).toBe(`https://app.vireek.com/shared/dashboard/${'a'.repeat(64)}`);
  });
  it('derives status; revoked wins over expired', () => {
    const future = new Date(NOW + 86_400_000).toISOString();
    const past = new Date(NOW - 1000).toISOString();
    expect(snapshotStatus({ expires_at: future, revoked_at: null }, NOW)).toBe('active');
    expect(snapshotStatus({ expires_at: past, revoked_at: null }, NOW)).toBe('expired');
    expect(snapshotStatus({ expires_at: future, revoked_at: past }, NOW)).toBe('revoked');
    expect(snapshotStatus({ expires_at: past, revoked_at: past }, NOW)).toBe('revoked');
    expect(snapshotStatus({ expires_at: new Date(NOW).toISOString(), revoked_at: null }, NOW)).toBe('expired');
  });
  it('labels expiry', () => {
    expect(expiryLabel(new Date(NOW + 30 * 60_000).toISOString(), NOW)).toBe('Expires in 30m');
    expect(expiryLabel(new Date(NOW + 5 * 3_600_000).toISOString(), NOW)).toBe('Expires in 5h');
    expect(expiryLabel(new Date(NOW + 10 * 86_400_000).toISOString(), NOW)).toBe('Expires in 10d');
    expect(expiryLabel(new Date(NOW - 3 * 86_400_000).toISOString(), NOW)).toBe('Expired 3d ago');
  });
  it('builds safe filenames', () => {
    expect(snapshotFilename('Q3 — Partner / Update!', NOW)).toBe('q3-partner-update-2026-10-10.pdf');
    expect(snapshotFilename('!!!', NOW)).toBe('dashboard-2026-10-10.pdf');
  });
});
