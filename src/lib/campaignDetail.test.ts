import { describe, it, expect } from 'vitest';
import type { MarketingCampaignEnrollment, MarketingCampaignStep } from '@/lib/marketing';
import {
  attributeRevenue,
  buildFunnel,
  buildRecipientRows,
  buildStepStats,
  cloneName,
  filterRecipients,
  paginate,
  summarizeCampaign,
  toggleTarget,
  type CampaignSend,
  type PaidJob,
} from './campaignDetail';

const enrollment = (o: Partial<MarketingCampaignEnrollment> & { id: string }): MarketingCampaignEnrollment => ({
  campaign_id: 'camp-1',
  customer_id: null,
  lead_id: null,
  contact_email: null,
  contact_phone: null,
  current_step: 0,
  status: 'active',
  enrolled_at: '2026-09-01T00:00:00.000Z',
  next_send_at: null,
  converted_at: null,
  ...o,
});

const step = (o: Partial<MarketingCampaignStep> & { id: string; step_order: number }): MarketingCampaignStep => ({
  campaign_id: 'camp-1',
  delay_hours: 0,
  channel: 'email',
  subject: `Subject ${o.step_order}`,
  body: 'Hello {{name}}',
  ...o,
});

const send = (o: Partial<CampaignSend> & { enrollment_id: string; step_id: string }): CampaignSend => ({
  channel: 'email',
  status: 'sent',
  error: null,
  sent_at: '2026-09-02T10:00:00.000Z',
  ...o,
});

const job = (o: Partial<PaidJob> & { id: string }): PaidJob => ({
  customer_id: null,
  lead_id: null,
  invoice_amount: 100,
  created_at: '2026-09-10T10:00:00.000Z',
  ...o,
});

describe('attributeRevenue', () => {
  const enrollments = [enrollment({ id: 'e1', customer_id: 'c1' })];
  const sends = [send({ enrollment_id: 'e1', step_id: 's1' })];

  it('credits a paid job created after the first message', () => {
    const result = attributeRevenue(enrollments, sends, [job({ id: 'j1', customer_id: 'c1', invoice_amount: 250 })]);
    expect(result.get('e1')).toEqual({ revenue: 250, jobs: 1 });
  });

  it('ignores jobs created before the first message', () => {
    const result = attributeRevenue(enrollments, sends, [job({ id: 'j1', customer_id: 'c1', created_at: '2026-09-01T00:00:00.000Z' })]);
    expect(result.size).toBe(0);
  });

  it('ignores jobs outside the attribution window', () => {
    const result = attributeRevenue(enrollments, sends, [job({ id: 'j1', customer_id: 'c1', created_at: '2027-03-01T00:00:00.000Z' })]);
    expect(result.size).toBe(0);
  });

  it('never credits enrollments that were never successfully messaged', () => {
    const failedOnly = [send({ enrollment_id: 'e1', step_id: 's1', status: 'failed' })];
    expect(attributeRevenue(enrollments, failedOnly, [job({ id: 'j1', customer_id: 'c1' })]).size).toBe(0);
  });

  it('ignores zero, null and invalid amounts', () => {
    const jobs = [
      job({ id: 'j1', customer_id: 'c1', invoice_amount: 0 }),
      job({ id: 'j2', customer_id: 'c1', invoice_amount: null }),
      job({ id: 'j3', customer_id: 'c1', created_at: 'not-a-date' }),
    ];
    expect(attributeRevenue(enrollments, sends, jobs).size).toBe(0);
  });

  it('credits a job once (last touch) when a person is enrolled as both lead and customer', () => {
    const both = [
      enrollment({ id: 'eLead', lead_id: 'l1' }),
      enrollment({ id: 'eCust', customer_id: 'c1', lead_id: null }),
    ];
    const bothSends = [
      send({ enrollment_id: 'eLead', step_id: 's1', sent_at: '2026-09-02T10:00:00.000Z' }),
      send({ enrollment_id: 'eCust', step_id: 's1', sent_at: '2026-09-05T10:00:00.000Z' }),
    ];
    const result = attributeRevenue(both, bothSends, [job({ id: 'j1', customer_id: 'c1', lead_id: 'l1', invoice_amount: 400 })]);
    expect(result.get('eCust')).toEqual({ revenue: 400, jobs: 1 });
    expect(result.has('eLead')).toBe(false);
  });
});

describe('summary and funnel', () => {
  const enrollments = [
    enrollment({ id: 'e1', customer_id: 'c1', status: 'completed', current_step: 2 }),
    enrollment({ id: 'e2', customer_id: 'c2', status: 'active', current_step: 1 }),
    enrollment({ id: 'e3', lead_id: 'l3', status: 'stopped' }),
    enrollment({ id: 'e4', customer_id: 'c4', status: 'converted', current_step: 1 }),
  ];
  const sends = [
    send({ enrollment_id: 'e1', step_id: 's1' }),
    send({ enrollment_id: 'e1', step_id: 's2' }),
    send({ enrollment_id: 'e2', step_id: 's1' }),
    send({ enrollment_id: 'e3', step_id: 's1', status: 'failed', error: 'Invalid number' }),
    send({ enrollment_id: 'e4', step_id: 's1' }),
  ];
  const attribution = attributeRevenue(enrollments, sends, [job({ id: 'j1', customer_id: 'c1', invoice_amount: 300 })]);
  const summary = summarizeCampaign(enrollments, sends, attribution);

  it('counts statuses, sends and revenue', () => {
    expect(summary).toMatchObject({ enrolled: 4, messaged: 3, active: 1, completed: 1, stopped: 1, sent: 4, failed: 1, skipped: 0, revenue: 300 });
    expect(summary.deliveryRate).toBe(80);
  });

  it('counts converted by attributed revenue or converted status, only among messaged', () => {
    expect(summary.converted).toBe(2);
    expect(summary.conversionRate).toBe(50);
    expect(summary.revenuePerRecipient).toBe(75);
  });

  it('builds a monotonic funnel with percentages', () => {
    const funnel = buildFunnel(summary);
    expect(funnel.map((f) => f.count)).toEqual([4, 3, 2]);
    expect(funnel[1].pctOfEnrolled).toBe(75);
    expect(funnel[2].pctOfPrevious).toBe(66.7);
  });

  it('handles an empty campaign without dividing by zero', () => {
    const empty = summarizeCampaign([], [], new Map());
    expect(empty.deliveryRate).toBe(0);
    expect(empty.revenuePerRecipient).toBe(0);
    expect(buildFunnel(empty).every((f) => f.pctOfEnrolled === 0 && f.pctOfPrevious === 0)).toBe(true);
  });
});

describe('buildStepStats', () => {
  const steps = [step({ id: 's2', step_order: 2, channel: 'sms', body: 'Hi there' }), step({ id: 's1', step_order: 1 })];
  const enrollments = [
    enrollment({ id: 'e1', status: 'active', current_step: 1 }),
    enrollment({ id: 'e2', status: 'active', current_step: 0 }),
  ];
  const sends = [
    send({ enrollment_id: 'e1', step_id: 's1' }),
    send({ enrollment_id: 'e2', step_id: 's1' }),
    send({ enrollment_id: 'e3', step_id: 's1', status: 'failed', error: 'Bounced' }),
    send({ enrollment_id: 'e4', step_id: 's1', status: 'failed', error: 'Bounced' }),
    send({ enrollment_id: 'e5', step_id: 's1', status: 'skipped' }),
    send({ enrollment_id: 'e1', step_id: 's2', channel: 'sms' }),
  ];

  it('orders steps and computes per-step numbers', () => {
    const stats = buildStepStats(steps, sends, enrollments);
    expect(stats.map((s) => s.stepOrder)).toEqual([1, 2]);
    expect(stats[0]).toMatchObject({ sent: 2, failed: 2, skipped: 1, reached: 2, deliveryRate: 50, retentionFromPrevious: null, topError: 'Bounced', waiting: 1 });
    expect(stats[1]).toMatchObject({ sent: 1, reached: 1, retentionFromPrevious: 50, waiting: 1, label: 'Hi there' });
  });
});

describe('recipients', () => {
  const enrollments = [
    enrollment({ id: 'e1', customer_id: 'c1', contact_email: 'ann@example.com', status: 'converted', current_step: 3 }),
    enrollment({ id: 'e2', lead_id: 'l2', contact_phone: '+15550001', status: 'active', current_step: 1, next_send_at: '2026-10-09T00:00:00.000Z' }),
  ];
  const contacts = new Map([
    ['c:c1', { name: 'Ann Lee' }],
    ['l:l2', { name: 'Bob Ray' }],
  ]);
  const sends = [
    send({ enrollment_id: 'e1', step_id: 's1', sent_at: '2026-09-02T00:00:00.000Z' }),
    send({ enrollment_id: 'e1', step_id: 's2', sent_at: '2026-09-04T00:00:00.000Z' }),
    send({ enrollment_id: 'e2', step_id: 's1', status: 'failed' }),
  ];
  const rows = buildRecipientRows(enrollments, contacts, sends, new Map([['e1', { revenue: 120, jobs: 1 }]]), 3);

  it('joins names, progress, last send, failures and revenue', () => {
    expect(rows[0]).toMatchObject({ name: 'Ann Lee', stepsDone: 3, stepsTotal: 3, lastSentAt: '2026-09-04T00:00:00.000Z', revenue: 120, converted: true, nextSendAt: null });
    expect(rows[1]).toMatchObject({ name: 'Bob Ray', kind: 'lead', failedCount: 1, nextSendAt: '2026-10-09T00:00:00.000Z', converted: false });
  });

  it('clamps progress to the number of steps', () => {
    const [r] = buildRecipientRows([enrollment({ id: 'x', customer_id: 'c1', current_step: 9 })], contacts, [], new Map(), 3);
    expect(r.stepsDone).toBe(3);
  });

  it('falls back when a contact record is missing', () => {
    const [r] = buildRecipientRows([enrollment({ id: 'x', customer_id: 'gone' })], contacts, [], new Map(), 1);
    expect(r.name).toBe('Unknown contact');
  });

  it('filters by text and status', () => {
    expect(filterRecipients(rows, 'ann', 'all')).toHaveLength(1);
    expect(filterRecipients(rows, '5550001', 'all')).toHaveLength(1);
    expect(filterRecipients(rows, '', 'active')).toHaveLength(1);
    expect(filterRecipients(rows, '', 'failed')).toHaveLength(1);
    expect(filterRecipients(rows, 'zzz', 'all')).toHaveLength(0);
  });

  it('paginates and clamps out-of-range pages', () => {
    const items = Array.from({ length: 53 }, (_, i) => i);
    expect(paginate(items, 1, 25)).toMatchObject({ pageCount: 3, page: 1 });
    expect(paginate(items, 3, 25).rows).toHaveLength(3);
    expect(paginate(items, 99, 25).page).toBe(3);
    expect(paginate([], 1, 25)).toMatchObject({ pageCount: 1, rows: [] });
  });
});

describe('actions', () => {
  it('pauses active campaigns, resumes paused ones, and blocks activation without steps', () => {
    expect(toggleTarget('active', 0)).toBe('paused');
    expect(toggleTarget('paused', 2)).toBe('active');
    expect(toggleTarget('draft', 2)).toBe('active');
    expect(toggleTarget('draft', 0)).toBeNull();
    expect(toggleTarget('paused', 0)).toBeNull();
  });

  it('does not stack "Copy of" prefixes', () => {
    expect(cloneName('Spring promo')).toBe('Copy of Spring promo');
    expect(cloneName('Copy of Copy of Spring promo')).toBe('Copy of Spring promo');
  });
});
