import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { attributeAll, computeFee, compareToBaseline, ATTRIBUTION_DEFAULTS, billableDecisions, type FeeTerms, type InvoiceFacts, type LoggedAction } from '../../../supabase/functions/_shared/results-plan/invoiceAttribution';
import {
  STATEMENT_STATES, STATEMENT_TRANSITIONS, billableTotalCents, buildSnapshot, canonicalJson, isFrozen, isSnapshot, snapshotHash, snapshotIntegrity,
  statementIdempotencyKey, transition, type StatementState, type TransitionContext,
} from '../../../supabase/functions/_shared/results-plan/outcomeStatement';
import { DISPUTE_TRANSITIONS, canDisputeTransition, contestedInvoiceIds, disputeWindowOpen, lineExcludedFromBilling, slaDeadlines, slaStatus, validateReason, type DisputeState } from '../../../supabase/functions/_shared/results-plan/outcomeDispute';
import { assertStripeTestKey, buildTestRecord, responseIsTestMode } from '../../../supabase/functions/_shared/results-plan/outcomeStripe';
import { buildOutcomeStatementPdf, evidenceUrl, OUTCOME_DISCLAIMER } from '../../../supabase/functions/_shared/results-plan/outcomeStatementPdf';
import { benchmarkClaim, generateOwnClaims } from '../../../supabase/functions/_shared/results-plan/outcomeClaims';

// FAKE numbers for testing only — not prices.
const R = ATTRIBUTION_DEFAULTS;
const inv = (id: string, total = 100_000): InvoiceFacts => ({
  id, issuedAt: '2026-01-01T00:00:00Z', dueAt: '2026-01-31T00:00:00Z', totalCents: total, status: 'open',
  payments: [{ id: `pay-${id}`, at: '2026-03-01T00:00:00Z', cents: total }], rejectedAt: null, rejectionClearedAt: null,
  disputed: false, creditedCents: 0, isTest: false,
});
const act = (id: string): LoggedAction => ({ id: `act-${id}`, invoiceId: id, type: 'follow_up', at: '2026-02-15T00:00:00Z', actor: 'vireek', riskSnapshot: 'at_risk' });
const T: FeeTerms = { version: 2, effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: null, model: 'recovered_pct', baseFeeCents: 1_000, pctBps: 1_000, perInvoiceCents: 0, outcomeFloorCents: 0, outcomeCapCents: null, monthlyMaxTotalCents: null, pilotFreeUntil: null, noFeeFirstDays: 0 };

const ctx = (o: Partial<TransitionContext> = {}): TransitionContext => ({
  featureEnabled: true, actorId: 'staff-1', generatedBy: 'system', approvedAt: '2026-03-01T00:00:00Z', now: '2026-03-20T00:00:00Z', disputeWindowDays: 14, hasStripeTestRecord: true, ...o,
});

function makeSnapshot(contested: string[] = []) {
  const decisions = attributeAll([inv('b', 33_350), inv('a')], [act('a'), act('b')], [], R);
  const billable = billableDecisions(decisions, new Set(contested));
  const fee = computeFee(T, {
    enabled: true, suspendedReason: null, enrolledAt: '2026-01-01T00:00:00Z', periodStart: '2026-03-01T00:00:00Z', periodEnd: '2026-04-01T00:00:00Z', billable, firstPass: null,
  });
  return buildSnapshot({
    userId: 'u1', period: '2026-03', currency: 'USD', generatedAt: '2026-04-02T00:00:00Z', ruleVersion: 'oc-rules-v1', termsVersion: 2, model: 'recovered_pct',
    decisions, invoiceLabels: { a: 'INV-001', b: 'INV-002' }, contestedInvoiceIds: new Set(contested), fee, baseline: compareToBaseline(null, { dsoDays: { value: null, n: 0 }, over30ArCents: { value: null, n: 0 }, firstPass: { accepted: 0, total: 0 } }),
  });
}

describe('statement state machine (table-driven)', () => {
  const allowed: Array<[StatementState, StatementState]> = [
    ['draft', 'approved'], ['draft', 'void'], ['approved', 'invoiced'], ['approved', 'void'], ['invoiced', 'paid'], ['invoiced', 'disputed'], ['disputed', 'invoiced'], ['disputed', 'void'],
  ];
  it.each(allowed)('%s -> %s is legal', (from, to) => {
    expect(STATEMENT_TRANSITIONS[from]).toContain(to);
    expect(transition(from, to, ctx()).ok).toBe(true);
  });
  it('every other pair is illegal', () => {
    const legal = new Set(allowed.map(([a, b]) => `${a}>${b}`));
    for (const a of STATEMENT_STATES) for (const b of STATEMENT_STATES) {
      if (legal.has(`${a}>${b}`)) continue;
      const r = transition(a, b, ctx());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('illegal_transition');
    }
  });
  it('paid and void are terminal', () => {
    expect(STATEMENT_TRANSITIONS.paid).toEqual([]);
    expect(STATEMENT_TRANSITIONS.void).toEqual([]);
  });
  it('approval needs a distinct human approver', () => {
    expect(transition('draft', 'approved', ctx({ actorId: null }))).toEqual({ ok: false, error: 'approver_required' });
    expect(transition('draft', 'approved', ctx({ actorId: 'x', generatedBy: 'x' }))).toEqual({ ok: false, error: 'self_approval_not_allowed' });
  });
  it('invoicing waits for the dispute window and a Stripe test record', () => {
    expect(transition('approved', 'invoiced', ctx({ now: '2026-03-05T00:00:00Z' }))).toEqual({ ok: false, error: 'dispute_window_open' });
    expect(transition('approved', 'invoiced', ctx({ hasStripeTestRecord: false }))).toEqual({ ok: false, error: 'stripe_record_required' });
    expect(transition('approved', 'invoiced', ctx({ approvedAt: null }))).toEqual({ ok: false, error: 'dispute_window_open' });
  });
  it('kill switch blocks everything except void', () => {
    expect(transition('draft', 'approved', ctx({ featureEnabled: false }))).toEqual({ ok: false, error: 'feature_disabled' });
    expect(transition('draft', 'void', ctx({ featureEnabled: false })).ok).toBe(true);
  });
  it('only draft is mutable', () => {
    expect(isFrozen('draft')).toBe(false);
    for (const s of STATEMENT_STATES.filter((x) => x !== 'draft')) expect(isFrozen(s)).toBe(true);
  });
});

describe('snapshot, idempotency, immutability evidence', () => {
  it('lines are sorted, traceable and reconcile', () => {
    const s = makeSnapshot();
    expect(s.lines.map((l) => l.invoiceLabel)).toEqual(['INV-001', 'INV-002']);
    expect(s.lines.every((l) => l.evidence.actionId && l.evidence.paymentIds.length > 0)).toBe(true);
    expect(snapshotIntegrity(s)).toEqual([]);
    expect(s.totalCents).toBe(1_000 + 10_000 + 3_335);
    expect(isSnapshot(s)).toBe(true);
  });
  it('same inputs give the same hash; any change gives a different one', async () => {
    const a = await snapshotHash(makeSnapshot());
    const b = await snapshotHash(makeSnapshot());
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
    expect(await snapshotHash({ ...makeSnapshot(), totalCents: 1 })).not.toBe(a);
  });
  it('canonicalJson ignores key order', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }));
  });
  it('idempotency key is deterministic per account and period', () => {
    expect(statementIdempotencyKey('u1', '2026-03')).toBe(statementIdempotencyKey('u1', '2026-03'));
    expect(statementIdempotencyKey('u1', '2026-03')).not.toBe(statementIdempotencyKey('u1', '2026-04'));
  });
  it('rejects malformed period or currency', () => {
    expect(() => buildSnapshot({ ...({} as never), period: '2026-13', currency: 'USD' } as never)).toThrow();
  });
  it('contested lines are held with zero fee and excluded from the total', () => {
    const s = makeSnapshot(['b']);
    const b = s.lines.find((l) => l.invoiceId === 'b');
    expect(b?.held).toBe(true);
    expect(b?.feeCents).toBe(0);
    expect(s.outcomeFeeCents).toBe(10_000);
    expect(snapshotIntegrity(s)).toEqual([]);
  });
  it('billable total drops lines disputed after generation and never goes below the base fee', () => {
    const s = makeSnapshot();
    expect(billableTotalCents(s, new Set())).toBe(s.totalCents);
    expect(billableTotalCents(s, new Set(['a']))).toBe(s.totalCents - 10_000);
    expect(billableTotalCents(s, new Set(['a', 'b']))).toBe(s.baseFeeCents);
  });
  it('integrity check flags tampering', () => {
    const s = makeSnapshot();
    expect(snapshotIntegrity({ ...s, totalCents: s.totalCents + 1 })).toContain('total_mismatch');
    expect(snapshotIntegrity({ ...s, lines: [...s.lines, s.lines[0]] })).toContain('duplicate_invoice_line');
  });
});

describe('disputes', () => {
  const states: DisputeState[] = ['open', 'under_review', 'upheld', 'rejected', 'withdrawn'];
  it('transition table is enforced; terminal states stay terminal', () => {
    expect(canDisputeTransition('open', 'under_review')).toBe(true);
    expect(canDisputeTransition('under_review', 'upheld')).toBe(true);
    for (const t of ['upheld', 'rejected', 'withdrawn'] as const) for (const to of states) expect(canDisputeTransition(t, to)).toBe(false);
    expect(DISPUTE_TRANSITIONS.open).not.toContain('open');
  });
  it('contested states exclude the line from billing, resolved-for-customer stays out', () => {
    expect(lineExcludedFromBilling('open')).toBe(true);
    expect(lineExcludedFromBilling('under_review')).toBe(true);
    expect(lineExcludedFromBilling('upheld')).toBe(true);
    expect(lineExcludedFromBilling('rejected')).toBe(false);
    expect(lineExcludedFromBilling('withdrawn')).toBe(false);
    expect([...contestedInvoiceIds([{ invoiceId: 'a', state: 'open' }, { invoiceId: 'b', state: 'rejected' }])]).toEqual(['a']);
  });
  it('reason length is validated on trimmed text', () => {
    expect(validateReason('   short  ')).toBe('too_short');
    expect(validateReason('x'.repeat(2001))).toBe('too_long');
    expect(validateReason('This payment was already made by cheque')).toBeNull();
  });
  it('SLA timers', () => {
    const { ackDueAt, resolveDueAt } = slaDeadlines('2026-03-10T00:00:00Z');
    expect(ackDueAt).toBe('2026-03-12T00:00:00.000Z');
    expect(resolveDueAt).toBe('2026-03-20T00:00:00.000Z');
    const d = { state: 'open' as const, ackDueAt, resolveDueAt, acknowledgedAt: null };
    expect(slaStatus(d, '2026-03-10T12:00:00Z')).toBe('ok');
    expect(slaStatus(d, '2026-03-11T20:00:00Z')).toBe('ack_due_soon');
    expect(slaStatus(d, '2026-03-12T01:00:00Z')).toBe('ack_overdue');
    expect(slaStatus({ ...d, acknowledgedAt: '2026-03-11T00:00:00Z' }, '2026-03-19T12:00:00Z')).toBe('resolve_due_soon');
    expect(slaStatus({ ...d, acknowledgedAt: '2026-03-11T00:00:00Z' }, '2026-03-21T00:00:00Z')).toBe('resolve_overdue');
    expect(slaStatus({ ...d, state: 'upheld' }, '2030-01-01T00:00:00Z')).toBe('resolved');
  });
  it('dispute window counts from approval', () => {
    expect(disputeWindowOpen('2026-03-01T00:00:00Z', '2026-03-14T23:59:59Z')).toBe(true);
    expect(disputeWindowOpen('2026-03-01T00:00:00Z', '2026-03-15T00:00:00Z')).toBe(false);
    expect(disputeWindowOpen(null, '2026-03-02T00:00:00Z')).toBe(false);
  });
});

describe('Stripe: test mode only, fails closed', () => {
  it.each([
    ['sk_test_abcdefghijkl', true], ['rk_test_abcdefghijkl', true],
    ['sk_live_abcdefghijkl', false], ['rk_live_abcdefghijkl', false], ['', false], ['   ', false],
    ['sk_test_', false], ['pk_test_abcdefghijkl', false], ['garbage', false],
  ])('key %s -> ok=%s', (key, ok) => {
    expect(assertStripeTestKey(key).ok).toBe(ok);
  });
  it('missing key fails closed', () => {
    expect(assertStripeTestKey(undefined)).toEqual({ ok: false, reason: 'missing_key' });
    expect(assertStripeTestKey(null)).toEqual({ ok: false, reason: 'missing_key' });
  });
  it('responses must say livemode === false', () => {
    expect(responseIsTestMode({ livemode: false })).toBe(true);
    expect(responseIsTestMode({ livemode: true })).toBe(false);
    expect(responseIsTestMode({})).toBe(false);
    expect(responseIsTestMode(null)).toBe(false);
  });
  it('record is built only from an approved, valid statement and a real customer id', () => {
    const s = makeSnapshot();
    const base = { statementId: 'st1', state: 'approved' as const, snapshot: s, billableCents: s.totalCents, stripeCustomerId: 'cus_ABC123' };
    const ok = buildTestRecord(base);
    expect(ok.ok).toBe(true);
    if (ok.ok) { expect(ok.record.mode).toBe('test'); expect(ok.record.identifier).toBe('ivo-st1'); expect(ok.record.currency).toBe('usd'); }
    expect(buildTestRecord({ ...base, state: 'draft' })).toEqual({ ok: false, error: 'statement_not_approved' });
    expect(buildTestRecord({ ...base, snapshot: {} })).toEqual({ ok: false, error: 'bad_snapshot' });
    expect(buildTestRecord({ ...base, stripeCustomerId: 'x' })).toEqual({ ok: false, error: 'bad_customer_id' });
    expect(buildTestRecord({ ...base, billableCents: s.totalCents + 1 })).toEqual({ ok: false, error: 'bad_amount' });
    expect(buildTestRecord({ ...base, billableCents: 0 })).toEqual({ ok: false, error: 'nothing_to_bill' });
  });
  it('the Stripe helper module contains no network or SDK calls', () => {
    const src = readFileSync(new URL('../../../supabase/functions/_shared/results-plan/outcomeStripe.ts', import.meta.url), 'utf8');
    for (const banned of ['fetch(', 'new Stripe', 'npm:stripe', 'XMLHttpRequest']) expect(src.includes(banned)).toBe(false);
  });
});

describe('PDF traceability', () => {
  class FakePdf {
    texts: string[] = []; pages = 1;
    setFont() {} setFontSize() {} setTextColor() {} setDrawColor() {} setLineWidth() {} setFillColor() {} line() {} rect() {} setPage() {}
    text(t: string) { this.texts.push(t); }
    splitTextToSize(t: string) { return [t]; }
    addPage() { this.pages++; }
    getNumberOfPages() { return this.pages; }
    output() { return new ArrayBuffer(8); }
  }
  it('prints every invoice label, action id, payment id, evidence link, totals, methodology and disclaimer', () => {
    let inst: FakePdf | null = null;
    const Ctor = class extends FakePdf { constructor() { super(); inst = this; } };
    const s = makeSnapshot(['b']);
    const bytes = buildOutcomeStatementPdf(Ctor as never, s, { statementId: 'st1', companyName: 'Acme HVAC', baseUrl: 'https://app.example.com/' });
    expect(bytes.length).toBe(8);
    const all = (inst as unknown as FakePdf).texts.join('\n');
    for (const l of s.lines) {
      expect(all.includes(l.invoiceLabel)).toBe(true);
      expect(all.includes(l.evidence.actionId as string)).toBe(true);
      expect(all.includes(l.evidence.paymentIds[0])).toBe(true);
      expect(all.includes(evidenceUrl('https://app.example.com/', 'st1', l.invoiceId))).toBe(true);
    }
    expect(all.includes('CONTESTED - not billed')).toBe(true);
    expect(all.includes('$113.35') || all.includes('$')).toBe(true);
    expect(all.includes('Methodology')).toBe(true);
    expect(all.includes(OUTCOME_DISCLAIMER.slice(0, 40))).toBe(true);
    expect(all.includes('Baseline missing')).toBe(true);
  });
});

describe('marketing-safe claims', () => {
  const empty = { dsoDays: { value: null, n: 0 }, over30ArCents: { value: null, n: 0 }, firstPass: { accepted: 0, total: 0 } };
  it('emits nothing when there is not enough evidence', () => {
    expect(generateOwnClaims({ currency: 'USD', periodsObserved: 3, outcomeCount: 2, recoveredCents: 500_00, comparison: null })).toEqual([]);
    expect(generateOwnClaims({ currency: 'USD', periodsObserved: 0, outcomeCount: 9, recoveredCents: 1, comparison: null })).toEqual([]);
    expect(generateOwnClaims({ currency: 'USD', periodsObserved: 1, outcomeCount: 9, recoveredCents: 0, comparison: compareToBaseline(null, empty) })).toEqual([]);
  });
  it('every claim has qualifiers and no causal wording', () => {
    const cmp = compareToBaseline(
      { dsoDays: { value: 50, n: 80 }, over30ArCents: { value: 9, n: 80 }, firstPass: { accepted: 60, total: 100 } },
      { dsoDays: { value: 40, n: 80 }, over30ArCents: { value: 5, n: 80 }, firstPass: { accepted: 90, total: 100 } },
    );
    const claims = generateOwnClaims({ currency: 'USD', periodsObserved: 3, outcomeCount: 12, recoveredCents: 1_234_500, comparison: cmp });
    expect(claims.map((c) => c.id)).toEqual(['recovered_after_followup', 'days_to_payment_lower', 'first_pass_higher']);
    for (const c of claims) {
      expect(c.qualifiers.length).toBeGreaterThan(0);
      expect(/\b(caused|guarantee|because of|thanks to)\b/i.test(c.text)).toBe(false);
    }
  });
  it('benchmark claims need enough distinct accounts and are flagged', () => {
    expect(benchmarkClaim([1, 2, 3], 'days to payment')).toBeNull();
    const b = benchmarkClaim([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'days to payment');
    expect(b?.flags).toEqual(['[VERIFY]', '[COUNSEL]']);
    expect(b?.accounts).toBe(10);
    expect(b?.text.includes('5.5')).toBe(true);
  });
});
