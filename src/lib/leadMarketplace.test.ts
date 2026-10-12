import { describe, it, expect } from 'vitest';
import {
  buildEmailAlias,
  buildWebhookUrl,
  dollarsToCents,
  formatCents,
  formatSeconds,
  generateToken,
  percent,
  summarizeReport,
  type CostReportRow,
} from './leadMarketplace';

const row = (over: Partial<CostReportRow>): CostReportRow => ({
  provider: 'angi', leads: 10, leads_unknown_cost: 0, spend_cents: 40000, booked_leads: 4, booked_jobs: 5, revenue_cents: 300000,
  cost_per_lead_cents: 4000, cost_per_booked_job_cents: 10000, booking_rate: 0.4, responded_leads: 10, within_sla_leads: 9,
  median_response_seconds: 8, p95_response_seconds: 30, ...over,
});

describe('formatters', () => {
  it('formats cents, seconds and percentages', () => {
    expect(formatCents(4500)).toBe('$45');
    expect(formatCents(4250)).toBe('$42.50');
    expect(formatCents(null)).toBe('—');
    expect(formatSeconds(8.4)).toBe('8.4s');
    expect(formatSeconds(75)).toBe('1m 15s');
    expect(formatSeconds(null)).toBe('—');
    expect(percent(9, 10)).toBe(90);
    expect(percent(1, 0)).toBeNull();
  });
  it('parses dollar inputs', () => {
    expect(dollarsToCents('$45')).toBe(4500);
    expect(dollarsToCents('1,250.50')).toBe(125050);
    expect(dollarsToCents('')).toBeNull();
    expect(dollarsToCents('abc')).toBeUndefined();
    expect(dollarsToCents('4.505')).toBeUndefined();
  });
});

describe('urls and tokens', () => {
  it('builds the webhook url without double slashes', () => {
    expect(buildWebhookUrl('https://x.supabase.co/', 'tok')).toBe('https://x.supabase.co/functions/v1/lead-marketplace-ingest?token=tok');
  });
  it('builds provider-tagged email aliases', () => {
    expect(buildEmailAlias('abc', 'in.vireek.com', 'google_lsa')).toBe('abc+lsa@in.vireek.com');
    expect(buildEmailAlias(null, 'in.vireek.com', 'angi')).toBeNull();
    expect(buildEmailAlias('abc', undefined, 'angi')).toBeNull();
  });
  it('generates 48-hex tokens that differ', () => {
    const a = generateToken();
    expect(a).toMatch(/^[0-9a-f]{48}$/);
    expect(a).not.toBe(generateToken());
  });
});

describe('summarizeReport', () => {
  it('weights totals correctly across providers', () => {
    const t = summarizeReport([
      row({}),
      row({ provider: 'thumbtack', leads: 10, spend_cents: 20000, booked_leads: 1, booked_jobs: 1, revenue_cents: 50000, responded_leads: 10, within_sla_leads: 10 }),
    ]);
    expect(t.leads).toBe(20);
    expect(t.spendCents).toBe(60000);
    expect(t.costPerLeadCents).toBe(3000);
    expect(t.costPerBookedJobCents).toBe(12000); // 60000 / 5 booked leads
    expect(t.bookingRatePct).toBe(25);
    expect(t.withinSlaPct).toBe(95);
  });
  it('returns nulls, not NaN, for an empty report', () => {
    const t = summarizeReport([]);
    expect(t.costPerBookedJobCents).toBeNull();
    expect(t.withinSlaPct).toBeNull();
    expect(t.leads).toBe(0);
  });
  it('has no cost per booked job when nothing booked', () => {
    expect(summarizeReport([row({ booked_leads: 0 })]).costPerBookedJobCents).toBeNull();
  });
});
