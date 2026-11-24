import { describe, expect, it } from 'vitest';
import {
  approvedCeiling, buildForecast, canDecide, canWithdraw, dealDeskMetrics, dominantCurrency, elapsedBusinessDays,
  isCurrencyCode, monthWindow, parseAmount, parseMatchNames, parsePct, parseProbability, percentile, requiredApprovalLevel, resolveStage, validateDiscountDraft, validateThresholds,
  type DiscountRequest, type PipelineDeal, type PipelineStage,
} from './salesPipeline';

const stage = (over: Partial<PipelineStage> & Pick<PipelineStage, 'id' | 'stage_key'>): PipelineStage => ({
  label: over.stage_key, position: 10, win_probability_pct: 50, forecast_category: 'pipeline', match_names: [], ...over,
});
const STAGES: PipelineStage[] = [
  stage({ id: 's1', stage_key: 'qualified', label: 'Qualified', position: 10, win_probability_pct: 10, match_names: ['Qualification'] }),
  stage({ id: 's2', stage_key: 'proposal', label: 'Proposal', position: 30, win_probability_pct: 50, forecast_category: 'best_case', match_names: ['Proposal Sent'] }),
  stage({ id: 's3', stage_key: 'negotiation', label: 'Negotiation', position: 40, win_probability_pct: 75, forecast_category: 'commit' }),
  stage({ id: 's4', stage_key: 'parked', label: 'Parked', position: 60, win_probability_pct: 0, forecast_category: 'omitted' }),
];
const deal = (over: Partial<PipelineDeal> & Pick<PipelineDeal, 'id'>): PipelineDeal => ({
  title: 'Acme', amount: 1000, currency: 'USD', status: 'open', stage: 'Proposal', close_date: '2026-12-15', discount_pct: 0,
  updated_at: '2026-11-01T00:00:00Z', ...over,
});
const NOW = new Date('2026-11-19T10:00:00Z');

describe('resolveStage', () => {
  it('matches key, label and CRM names case-insensitively, ignoring extra spaces', () => {
    expect(resolveStage('PROPOSAL', STAGES)?.id).toBe('s2');
    expect(resolveStage('  proposal   sent ', STAGES)?.id).toBe('s2');
    expect(resolveStage('qualification', STAGES)?.id).toBe('s1');
  });
  it('returns null for blank or unknown stages', () => {
    expect(resolveStage('', STAGES)).toBeNull();
    expect(resolveStage(null, STAGES)).toBeNull();
    expect(resolveStage('Closed Lost', STAGES)).toBeNull();
  });
});

describe('requiredApprovalLevel', () => {
  const s = { auto_approve_max_pct: 10, manager_max_pct: 20 };
  it('uses inclusive limits', () => {
    expect(requiredApprovalLevel(10, s)).toBe('auto');
    expect(requiredApprovalLevel(10.01, s)).toBe('manager');
    expect(requiredApprovalLevel(20, s)).toBe('manager');
    expect(requiredApprovalLevel(20.01, s)).toBe('owner');
  });
});

describe('parsePct / validateDiscountDraft', () => {
  it('parses plain numbers and decimal commas', () => {
    expect(parsePct('12')).toBe(12);
    expect(parsePct('12,5')).toBe(12.5);
    expect(parsePct('  ')).toBeNull();
  });
  it('rejects junk and more than 2 decimals', () => {
    for (const v of ['abc', '-5', '1.234', '1e2', '12%', '1000']) expect(parsePct(v)).toBeNaN();
  });
  it('accepts a valid draft and trims the reason', () => {
    const r = validateDiscountDraft('15', '  Multi-location rollout, competing quote  ');
    expect(r).toEqual({ ok: true, pct: 15, reason: 'Multi-location rollout, competing quote' });
  });
  it('reports every problem at once', () => {
    const r = validateDiscountDraft('0', 'short');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toEqual({ pct: 'range', reason: 'too_short' });
    const r2 = validateDiscountDraft('', '');
    if (!r2.ok) expect(r2.errors).toEqual({ pct: 'required', reason: 'required' });
    const r3 = validateDiscountDraft('101', 'x'.repeat(1001));
    if (!r3.ok) expect(r3.errors).toEqual({ pct: 'range', reason: 'too_long' });
  });
});

describe('canDecide / canWithdraw (mirror of the database guard)', () => {
  const req = (over: Partial<DiscountRequest> = {}) => ({ status: 'pending' as const, required_level: 'manager' as const, requested_by: 'rep', ...over });
  it('blocks self-approval at manager level unless owner', () => {
    expect(canDecide(req(), { userId: 'rep', isOwner: false, canManage: true })).toBe(false);
    expect(canDecide(req(), { userId: 'mgr', isOwner: false, canManage: true })).toBe(true);
    expect(canDecide(req({ requested_by: 'own' }), { userId: 'own', isOwner: true, canManage: true })).toBe(true);
  });
  it('requires the owner at owner level and a manager permission otherwise', () => {
    expect(canDecide(req({ required_level: 'owner' }), { userId: 'mgr', isOwner: false, canManage: true })).toBe(false);
    expect(canDecide(req({ required_level: 'owner' }), { userId: 'own', isOwner: true, canManage: true })).toBe(true);
    expect(canDecide(req(), { userId: 'x', isOwner: false, canManage: false })).toBe(false);
  });
  it('never allows decisions on closed requests or without a user', () => {
    expect(canDecide(req({ status: 'approved' }), { userId: 'own', isOwner: true, canManage: true })).toBe(false);
    expect(canDecide(req(), { userId: null, isOwner: true, canManage: true })).toBe(false);
  });
  it('lets the requester or owner withdraw only pending requests', () => {
    expect(canWithdraw(req(), { userId: 'rep', isOwner: false, canManage: false })).toBe(true);
    expect(canWithdraw(req(), { userId: 'other', isOwner: false, canManage: true })).toBe(false);
    expect(canWithdraw(req({ status: 'rejected' }), { userId: 'rep', isOwner: false, canManage: false })).toBe(false);
  });
});

describe('approvedCeiling', () => {
  const r = (over: Partial<DiscountRequest>): DiscountRequest => ({
    id: 'r', deal_id: 'd1', requested_pct: 15, reason: 'x'.repeat(12), required_level: 'manager', status: 'approved', requested_by: 'rep',
    decided_by: 'mgr', decided_at: '2026-11-02T00:00:00Z', decision_note: null, created_at: '2026-11-01T00:00:00Z', ...over,
  });
  it('is the auto limit unless an approved request for that deal is higher', () => {
    const s = { auto_approve_max_pct: 10 };
    expect(approvedCeiling('d1', [], s)).toBe(10);
    expect(approvedCeiling('d1', [r({}), r({ requested_pct: 18 })], s)).toBe(18);
    expect(approvedCeiling('d1', [r({ status: 'rejected', requested_pct: 30 }), r({ deal_id: 'd2', requested_pct: 40 })], s)).toBe(10);
  });
});

describe('buildForecast', () => {
  it('weights open deals by stage probability in cents', () => {
    const f = buildForecast([deal({ id: 'a', amount: 1000 }), deal({ id: 'b', amount: 200.5, stage: 'negotiation' })], STAGES, { now: NOW });
    expect(f.open).toEqual({ count: 2, amountCents: 120050, weightedCents: 50000 + 15038 });
    expect(f.byCategory.best_case.weightedCents).toBe(50000);
    expect(f.byCategory.commit.weightedCents).toBe(15038); // 20050 * 0.75 = 15037.5 -> 15038
    expect(f.byCategory.pipeline.count).toBe(0);
  });
  it('ignores won and lost deals', () => {
    const f = buildForecast([deal({ id: 'a', status: 'won' }), deal({ id: 'b', status: 'lost' })], STAGES, { now: NOW });
    expect(f.open.count).toBe(0);
    expect(f.excluded).toEqual({ unmappedStage: 0, omittedStage: 0, noAmount: 0, otherCurrency: 0 });
  });
  it('counts every exclusion instead of dropping deals silently', () => {
    const f = buildForecast([
      deal({ id: 'a' }),
      deal({ id: 'b', stage: 'Mystery' }),
      deal({ id: 'c', stage: 'Parked' }),
      deal({ id: 'd', amount: null }),
      deal({ id: 'e', currency: 'EUR' }),
      deal({ id: 'f', currency: null }),
    ], STAGES, { now: NOW });
    expect(f.open.count).toBe(1);
    expect(f.excluded).toEqual({ unmappedStage: 1, omittedStage: 1, noAmount: 1, otherCurrency: 2 });
  });
  it('builds a 6-month window starting at the current month', () => {
    const f = buildForecast([], STAGES, { now: NOW, horizonMonths: 6 });
    expect(f.byMonth.map((m) => m.month)).toEqual(['2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04']);
  });
  it('treats today as not overdue and the last window month as inside', () => {
    const f = buildForecast([
      deal({ id: 'b', close_date: '2026-11-19' }),
      deal({ id: 'e', close_date: '2027-04-30' }),
      deal({ id: 'f', close_date: '2027-05-01' }),
    ], STAGES, { now: NOW, horizonMonths: 6 });
    expect(f.overdue.count).toBe(0);
    expect(f.byMonth[0].count).toBe(1);
    expect(f.byMonth[5].count).toBe(1);
    expect(f.later.count).toBe(1);
  });
  it('puts months inside the window and everything else in the right bucket', () => {
    const f = buildForecast([
      deal({ id: 'a', close_date: '2026-11-30' }),
      deal({ id: 'c', close_date: '2026-11-18' }),
      deal({ id: 'd', close_date: null }),
      deal({ id: 'f', close_date: '2028-01-01' }),
    ], STAGES, { now: NOW, horizonMonths: 6 });
    expect(f.byMonth[0]).toMatchObject({ month: '2026-11', best_case: 100000, count: 1 });
    expect(f.overdue.count).toBe(1);
    expect(f.noCloseDate.count).toBe(1);
    expect(f.later.count).toBe(1);
  });
  it('forecasts only the chosen currency', () => {
    const deals = [deal({ id: 'a', currency: 'EUR' }), deal({ id: 'b', currency: 'EUR' }), deal({ id: 'c', currency: 'USD' })];
    expect(dominantCurrency(deals)).toBe('EUR');
    const usd = buildForecast(deals, STAGES, { now: NOW, currency: 'USD' });
    expect(usd.open.count).toBe(1);
    expect(usd.excluded.otherCurrency).toBe(2);
  });
  it('is stable on an empty pipeline', () => {
    const f = buildForecast([], [], { now: NOW });
    expect(f.currency).toBeNull();
    expect(f.open).toEqual({ count: 0, amountCents: 0, weightedCents: 0 });
    expect(f.byMonth).toHaveLength(6);
  });
});

describe('monthWindow', () => {
  it('rolls over the year', () => {
    expect(monthWindow(new Date('2026-11-19T00:00:00Z'), 4)).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
  });
});

describe('elapsedBusinessDays / percentile / dealDeskMetrics', () => {
  it('skips weekends (Fri 12:00 to Mon 12:00 = 1 weekday)', () => {
    expect(elapsedBusinessDays(new Date('2026-11-20T12:00:00Z'), new Date('2026-11-23T12:00:00Z'))).toBeCloseTo(1, 5);
  });
  it('is zero for a reversed or empty range', () => {
    expect(elapsedBusinessDays(NOW, NOW)).toBe(0);
    expect(elapsedBusinessDays(NOW, new Date('2026-11-01T00:00:00Z'))).toBe(0);
  });
  it('uses nearest-rank percentiles', () => {
    expect(percentile([], 90)).toBeNull();
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(percentile([5], 50)).toBe(5);
  });
  it('separates pending, human decisions and auto approvals', () => {
    const base = { deal_id: 'd', requested_pct: 15, reason: 'x'.repeat(12), requested_by: 'rep', decided_by: null, decision_note: null };
    const reqs: DiscountRequest[] = [
      { ...base, id: '1', required_level: 'auto', status: 'approved', decided_at: '2026-11-16T09:00:00Z', created_at: '2026-11-16T09:00:00Z' },
      { ...base, id: '2', required_level: 'manager', status: 'approved', decided_at: '2026-11-17T09:00:00Z', created_at: '2026-11-16T09:00:00Z' },
      { ...base, id: '3', required_level: 'manager', status: 'pending', decided_at: null, created_at: '2026-11-18T10:00:00Z' },
      { ...base, id: '4', required_level: 'manager', status: 'withdrawn', decided_at: '2026-11-18T11:00:00Z', created_at: '2026-11-18T10:00:00Z' },
    ];
    const m = dealDeskMetrics(reqs, NOW);
    expect(m).toMatchObject({ pending: 1, decided: 1, autoApproved: 1 });
    expect(m.decisionP50BusinessDays).toBeCloseTo(1, 5);
    expect(m.oldestPendingBusinessDays).toBeCloseTo(1, 5); // Wed 10:00 -> Thu 10:00
  });
});

describe('validateThresholds', () => {
  it('checks range and order', () => {
    expect(validateThresholds(10, 20)).toBe('ok');
    expect(validateThresholds(10, 10)).toBe('ok');
    expect(validateThresholds(20, 10)).toBe('order');
    expect(validateThresholds(-1, 10)).toBe('range');
    expect(validateThresholds(10, 101)).toBe('range');
    expect(validateThresholds(Number.NaN, 10)).toBe('range');
  });
});

describe('form parsers', () => {
  it('parseAmount accepts separators and 2 decimals only', () => {
    expect(parseAmount('1,200.50')).toBe(1200.5);
    expect(parseAmount('0')).toBe(0);
    expect(parseAmount(' ')).toBeNull();
    for (const v of ['abc', '-5', '1.234', '$5', '1e3', '9999999999999']) expect(parseAmount(v)).toBeNaN();
  });
  it('parseProbability allows 0 to 100', () => {
    expect(parseProbability('0')).toBe(0);
    expect(parseProbability('100')).toBe(100);
    expect(parseProbability('12,5')).toBe(12.5);
    expect(parseProbability('')).toBeNull();
    for (const v of ['101', '-1', 'x', '1.234']) expect(parseProbability(v)).toBeNaN();
  });
  it('parseMatchNames trims, drops blanks and de-duplicates case-insensitively', () => {
    expect(parseMatchNames(' Proposal ,proposal,, Quote   Sent ')).toEqual({ ok: true, names: ['Proposal', 'Quote Sent'] });
    expect(parseMatchNames('')).toEqual({ ok: true, names: [] });
  });
  it('parseMatchNames enforces limits', () => {
    expect(parseMatchNames(Array.from({ length: 21 }, (_, i) => `n${i}`).join(','))).toEqual({ ok: false, error: 'too_many' });
    expect(parseMatchNames('x'.repeat(81))).toEqual({ ok: false, error: 'too_long' });
  });
  it('isCurrencyCode wants exactly 3 letters', () => {
    expect(isCurrencyCode('usd')).toBe(true);
    expect(isCurrencyCode('US')).toBe(false);
    expect(isCurrencyCode('U$D')).toBe(false);
  });
});
