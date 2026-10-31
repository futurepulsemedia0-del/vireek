import { describe, expect, it } from 'vitest';
import {
  attributeClaim, attributeLedgerEvent, attributionsToCsv, buildPilotResults, centsToDecimal, computeFeeCents,
  renderPilotEmail,
  type AttributionRow, type BaselineRow, type ClaimActionInput, type ClaimInput,
} from './engine';
import type { LedgerEvent } from '../money-recovered/engine';

const BASE = '2026-10-01T00:00:00.000Z';
const act = (id: string, claim: string, type: ClaimActionInput['action_type'], at: string, to: string | null = null, amt: number | null = null): ClaimActionInput =>
  ({ id, claim_id: claim, action_type: type, to_status: to, amount_cents: amt, occurred_at: at });
const claim = (id: string, over: Partial<ClaimInput> = {}): ClaimInput =>
  ({ id, job_id: null, status: 'credit_received', created_at: '2026-09-01T00:00:00Z', submitted_at: null, credit_received_cents: null, credit_received_at: null, ...over });

describe('attributeClaim', () => {
  it('counts credit with the LATEST qualifying action strictly before it', () => {
    const a = attributeClaim(claim('A'), [
      act('1', 'A', 'packet_exported', '2026-10-05T10:00:00Z'),
      act('2', 'A', 'status_change', '2026-10-10T10:00:00Z', 'submitted'),
      act('3', 'A', 'credit_recorded', '2026-10-20T10:00:00Z', null, 125000),
    ], BASE);
    expect(a).toEqual({ counted: true, amountCents: 125000, recoveredAt: '2026-10-20T10:00:00Z',
      action: { id: '2', type: 'status_change', at: '2026-10-10T10:00:00Z' } });
  });
  it('does not count money with no preceding action', () => {
    expect(attributeClaim(claim('B'), [act('1', 'B', 'credit_recorded', '2026-10-20T00:00:00Z', null, 80000)], BASE))
      .toEqual({ counted: false, reason: 'no_preceding_action' });
  });
  it('ignores actions from before the pilot baseline', () => {
    expect(attributeClaim(claim('C'), [
      act('1', 'C', 'packet_exported', '2026-09-20T00:00:00Z'),
      act('2', 'C', 'credit_recorded', '2026-10-25T00:00:00Z', null, 50000),
    ], BASE)).toEqual({ counted: false, reason: 'no_preceding_action' });
  });
  it('ignores credits recorded before the baseline', () => {
    expect(attributeClaim(claim('D'), [
      act('1', 'D', 'packet_exported', '2026-09-01T00:00:00Z'),
      act('2', 'D', 'credit_recorded', '2026-09-15T00:00:00Z', null, 9000),
    ], BASE)).toEqual({ counted: false, reason: 'before_pilot' });
  });
  it('does not let the credit transaction attribute itself (same-instant status change, or credit_received status)', () => {
    const t = '2026-10-20T10:00:00Z';
    expect(attributeClaim(claim('E'), [
      act('1', 'E', 'status_change', t, 'credit_received'),
      act('2', 'E', 'status_change', t, 'approved'),
      act('3', 'E', 'credit_recorded', t, null, 70000),
    ], BASE)).toEqual({ counted: false, reason: 'no_preceding_action' });
  });
  it('reports no_credit_event when nothing was recorded, and never mixes other claims', () => {
    expect(attributeClaim(claim('F'), [act('1', 'OTHER', 'credit_recorded', '2026-10-20T00:00:00Z', null, 5)], BASE))
      .toEqual({ counted: false, reason: 'no_credit_event' });
  });
  it('reminder_sent qualifies', () => {
    const r = attributeClaim(claim('G'), [
      act('1', 'G', 'reminder_sent', '2026-10-02T00:00:00Z'),
      act('2', 'G', 'credit_recorded', '2026-10-03T00:00:00Z', null, 1234),
    ], BASE);
    expect(r.counted && r.action.type).toBe('reminder_sent');
  });
});

describe('attributeLedgerEvent', () => {
  const ev = (over: Partial<LedgerEvent> = {}): LedgerEvent => ({
    id: 'e1', source_type: 'declined_quote', call_id: null, customer_name: 'X', occurred_at: '2026-10-01T00:00:00Z',
    estimated_value_cents: 40000, status: 'recovered', recovery_method: 'quote_resent', recovered_amount_cents: 30000,
    follow_up_count: 1, last_follow_up_at: '2026-10-10T00:00:00Z', resolved_at: '2026-10-15T00:00:00Z', ...over,
  });
  it('counts with follow-up + paid invoice link', () => {
    expect(attributeLedgerEvent(ev(), 'inv-1', BASE)).toMatchObject({ counted: true, amountCents: 30000, action: { type: 'follow_up' } });
  });
  it('requires an invoice link', () => {
    expect(attributeLedgerEvent(ev(), null, BASE)).toEqual({ counted: false, reason: 'no_invoice_link' });
  });
  it('keeps the existing conservative rules (manual entry is not counted)', () => {
    expect(attributeLedgerEvent(ev({ recovery_method: 'manual' }), 'inv-1', BASE)).toEqual({ counted: false, reason: 'owner_reported' });
  });
  it('excludes anything resolved before the baseline', () => {
    expect(attributeLedgerEvent(ev({ resolved_at: '2026-09-20T00:00:00Z', last_follow_up_at: '2026-09-19T00:00:00Z' }), 'inv-1', BASE))
      .toEqual({ counted: false, reason: 'before_pilot' });
  });
  it('caps credited cents at the estimate', () => {
    expect(attributeLedgerEvent(ev({ recovered_amount_cents: 90000 }), 'inv-1', BASE)).toMatchObject({ amountCents: 40000 });
  });
});

describe('fee + money formatting', () => {
  it('is integer floor(cents * bps / 10000)', () => {
    expect(computeFeeCents(155000, 1000)).toBe(15500);
    expect(computeFeeCents(155001, 1000)).toBe(15500);
    expect(computeFeeCents(100, 0)).toBe(0);
    expect(computeFeeCents(-5, 1000)).toBe(0);
    expect(computeFeeCents(100, 99999)).toBe(100); // bps clamped to 100%
  });
  it('formats cents without floats', () => {
    expect(centsToDecimal(123456)).toBe('1234.56');
    expect(centsToDecimal(5)).toBe('0.05');
  });
});

describe('synthetic pilot matches the hand calculation', () => {
  const baseline: BaselineRow = {
    captured_at: BASE, window_start: '2026-04-01T00:00:00Z', window_end: BASE, eligible_jobs_count: 12, claims_filed_count: 3,
    claims_paid_count: 2, claims_paid_cents: 90000, unfiled_eligible_estimate_cents: 600000, qb_findings_count: null,
    qb_findings_cents: null, admin_hours_per_week: 10,
  };
  const attrs: AttributionRow[] = [
    { source_type: 'warranty_claim', source_id: 'A', claim_id: 'A', invoice_id: null, job_id: 'J1', amount_cents: 125000, action_type: 'status_change', action_at: '2026-10-10T10:00:00Z', recovered_at: '2026-10-20T10:00:00Z' },
    { source_type: 'recovery_event', source_id: 'e1', claim_id: null, invoice_id: 'inv-1', job_id: 'J2', amount_cents: 30000, action_type: 'follow_up', action_at: '2026-10-10T00:00:00Z', recovered_at: '2026-10-15T00:00:00Z' },
  ];
  const claims: ClaimInput[] = [
    claim('A', { status: 'credit_received', submitted_at: '2026-10-10T10:00:00Z', credit_received_cents: 125000, credit_received_at: '2026-10-20T00:00:00Z' }),
    claim('H', { status: 'submitted', created_at: '2026-08-01T00:00:00Z', submitted_at: '2026-10-12T00:00:00Z' }),
    claim('I', { status: 'eligible', created_at: '2026-10-25T00:00:00Z' }),
  ];
  const r = buildPilotResults({
    nowIso: '2026-10-31T00:00:00Z', baseline, settings: { current_admin_hours_per_week: 6.5, fee_bps: 1000 }, claims, attributions: attrs,
    eligibleUnfiled: [
      { job_id: 'J9', invoice_amount: 250.5, completed_at: '2026-10-02T00:00:00Z' },
      { job_id: 'J9', invoice_amount: 250.5, completed_at: '2026-10-02T00:00:00Z' }, // duplicate unit of the same job
      { job_id: 'J8', invoice_amount: 100, completed_at: '2025-01-01T00:00:00Z' },   // outside 6 months
    ],
  });
  it('recovered = 125000 + 30000 and fee = 10% of it', () => {
    expect(r.recovered).toEqual({ cents: 155000, count: 2, warrantyCents: 125000, ledgerCents: 30000 });
    expect(r.fee).toEqual({ bps: 1000, cents: 15500, displayOnly: true });
  });
  it('claims since baseline, aging and hours', () => {
    expect(r.now.claimsFiledSinceBaseline).toBe(2); // A and H
    expect(r.now.claimsPaidSinceBaseline).toBe(1);
    expect(r.claimsByStatus.submitted).toEqual({ count: 1, cents: 0 });
    expect(r.aging).toEqual({ '0-30': 1, '31-60': 0, '61-90': 0, '90+': 1 }); // I = 6 days, H = 91 days
    expect(r.hours).toEqual({ baselinePerWeek: 10, currentPerWeek: 6.5, savedPerWeek: 3.5, source: 'manual' });
  });
  it('unfiled eligible value counts each job once, inside 6 months only (estimate)', () => {
    expect(r.now.unfiledEligibleJobs).toBe(1);
    expect(r.now.unfiledEligibleEstimateCents).toBe(25050);
  });
  it('QB findings are explicitly unavailable, never zero', () => {
    expect(r.findings.available).toBe(false);
    expect(r.baseline?.qb_findings_count).toBeNull();
  });
  it('without a baseline nothing since-baseline is claimed', () => {
    const n = buildPilotResults({ nowIso: BASE, baseline: null, settings: null, claims, attributions: [], eligibleUnfiled: [] });
    expect(n.hasBaseline).toBe(false);
    expect(n.now.claimsFiledSinceBaseline).toBe(0);
    expect(n.hours.savedPerWeek).toBeNull();
  });
  it('CSV: one row per attribution, integer dollars, injection-safe', () => {
    const csv = attributionsToCsv([{ ...attrs[0], job_id: '=HYPERLINK("x")' }, attrs[1]]).trim().split('\r\n');
    expect(csv).toHaveLength(3);
    expect(csv[1]).toContain(',1250.00,');
    expect(csv[1]).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv[2]).toContain(',300.00,');
  });
  it('email shows the same numbers and escapes the company name', () => {
    const m = renderPilotEmail({ companyName: '<b>Acme</b>', results: r, currency: 'USD', periodLabel: 'Oct 2026', siteUrl: 'https://x.test' });
    expect(m.text).toContain('Recovered (attributed): $1,550.00');
    expect(m.html).not.toContain('<b>Acme</b>');
    expect(m.text).toContain('(estimate)');
  });
});
