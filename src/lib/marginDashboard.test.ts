import { describe, it, expect } from 'vitest';
import {
  parseUeReport, parseExtras, buildTenantMargins, buildPlanStats, summarizeMargins, measuredCostPerMinute,
  topCostDrivers, negativeMarginOrgs, freeTierSummary, cohortStats, monthlyMinutesSamples, defaultAssumptions, type UeTenantRow,
  parseUsageEvents, priceUsageEvents, planAdvice,
} from './marginDashboard';
import { buildReportHtml, esc, buildReconciliation } from './unitEconomicsReportHtml';
import { projectPlan } from './marginModel';
import type { CostRate } from './unitEconomics';
import { validateRateInput, validateLimitInput, validateInvoiceInput, isIsoDate } from './unitEconomicsInputs';

const row = (o: Partial<UeTenantRow>): UeTenantRow => ({
  account_id: 'a1', email: 'a@x.com', company_name: 'Acme', plan: 'starter', voice_seconds: 0, voice_calls: 0,
  reported_voice_cost_usd: 0, calls_with_cost: 0, ai_cost_usd: 0, ...o,
});

describe('parseUeReport / parseExtras', () => {
  it('rejects malformed input and drops rows without an id', () => {
    expect(parseUeReport(null)).toBeNull();
    expect(parseUeReport({ tenants: 'x' })).toBeNull();
    const r = parseUeReport({ tenants: [{ account_id: 'a', voice_seconds: 60 }, { nope: 1 }, 5], components: [{ component: 'llm', cost_usd: 1, calls: 2 }] });
    expect(r?.tenants).toHaveLength(1);
    expect(r?.components[0].cost_usd).toBe(1);
    expect(r?.truncated).toBe(false);
  });
  it('parses extras defensively', () => {
    expect(parseExtras(undefined)).toEqual({ signupByAccount: {}, features: [] });
    const e = parseExtras({ cohorts: [{ account_id: 'a', signup_month: '2026-09' }, { account_id: 'b' }], features: [{ task: 't', cost_usd: 2, calls: 3 }] });
    expect(e.signupByAccount).toEqual({ a: '2026-09' });
    expect(e.features[0].task).toBe('t');
  });
});

describe('buildTenantMargins', () => {
  it('uses reported cost only when every call is covered (measured)', () => {
    const [m] = buildTenantMargins([row({ voice_seconds: 6000, voice_calls: 10, calls_with_cost: 10, reported_voice_cost_usd: 10, ai_cost_usd: 2 })], { fallbackVoiceCpm: 0.5, days: 30 });
    expect(m.voiceBasis).toBe('provider_reported');
    expect(m.voiceEstimatedUsd).toBe(0);
    expect(m.totalCostUsd).toBe(12);
    expect(m.revenueUsd).toBe(79);
  });
  it('prices only the uncovered share with the fallback and labels it mixed', () => {
    const [m] = buildTenantMargins([row({ voice_seconds: 6000, voice_calls: 10, calls_with_cost: 5, reported_voice_cost_usd: 5 })], { fallbackVoiceCpm: 0.1, days: 30 });
    expect(m.voiceBasis).toBe('mixed');
    expect(m.voiceEstimatedUsd).toBeCloseTo(5); // 100 min * 50% uncovered * $0.10
  });
  it('never turns missing cost into $0: no fallback -> unpriced flag', () => {
    const [m] = buildTenantMargins([row({ voice_seconds: 600, voice_calls: 2, calls_with_cost: 0 })], { fallbackVoiceCpm: null, days: 30 });
    expect(m.voiceUnpriced).toBe(true);
    expect(m.voiceBasis).toBe('estimated');
  });
  it('flags loss, thin and unpriced plans; free tier has no margin %', () => {
    const [loss, free, ent] = buildTenantMargins([
      row({ ai_cost_usd: 100 }), row({ account_id: 'f', plan: 'free', ai_cost_usd: 1 }), row({ account_id: 'e', plan: 'enterprise' }),
    ], { fallbackVoiceCpm: 0.1, days: 30 });
    expect(loss.health).toBe('loss');
    expect(free.marginPct).toBeNull();
    expect(ent.health).toBe('unpriced');
  });
  it('adds overage revenue beyond prorated included minutes', () => {
    const [m] = buildTenantMargins([row({ voice_seconds: 500 * 60, voice_calls: 1, calls_with_cost: 1 })], { fallbackVoiceCpm: null, days: 30 });
    expect(m.revenueUsd).toBeCloseTo(79 + 100 * 0.2);
  });
});

describe('aggregates', () => {
  const ms = buildTenantMargins([
    row({ account_id: '1', voice_seconds: 3000, voice_calls: 5, calls_with_cost: 5, reported_voice_cost_usd: 6 }),
    row({ account_id: '2', ai_cost_usd: 200 }),
    row({ account_id: '3', plan: 'free', ai_cost_usd: 1 }),
    row({ account_id: '4', plan: 'free', ai_cost_usd: 3 }),
  ], { fallbackVoiceCpm: 0.1, days: 30 });
  it('plan stats, summary and negative list', () => {
    const stats = buildPlanStats(ms);
    expect(stats.find((s) => s.plan === 'starter')?.tenants).toBe(2);
    expect(stats.find((s) => s.plan === 'starter')?.lossTenants).toBe(1);
    const sum = summarizeMargins(ms);
    expect(sum.revenueUsd).toBe(158);
    expect(sum.totalCostUsd).toBeCloseTo(6 + 200 + 1 + 3);
    expect(negativeMarginOrgs(ms).map((m) => m.accountId)).toEqual(['2']);
  });
  it('free-tier cost per org', () => expect(freeTierSummary(ms)).toEqual({ orgs: 2, avgCostUsd: 2 }));
  it('measured cost per minute needs covered minutes', () => {
    expect(measuredCostPerMinute(ms)).toBeCloseTo(6 / 50);
    expect(measuredCostPerMinute(ms.slice(1))).toBeNull();
  });
  it('cohorts, samples, drivers, assumptions', () => {
    expect(cohortStats(ms, { '1': '2026-09' }).find((c) => c.cohort === '2026-09')?.tenants).toBe(1);
    expect(cohortStats(ms, {}).find((c) => c.cohort === 'unknown')?.tenants).toBe(4);
    expect(monthlyMinutesSamples(ms, 'starter', 15)[0]).toBeCloseTo(100);
    const report = parseUeReport({ tenants: [], components: [{ component: 'llm', cost_usd: 4, calls: 1 }, { component: 'tts', cost_usd: 9, calls: 1 }] })!;
    const d = topCostDrivers(report, summarizeMargins(ms));
    expect(d[0].label).toBe('ai_llm_list_price');
    expect(d.find((x) => x.label === 'tts')?.basis).toBe('provider_reported');
    expect(defaultAssumptions({ fallbackVoiceCpm: null, days: 30, callsTotal: 10, callsWithCost: 5 }).join(' ')).toContain('UNPRICED');
  });
});

describe('report html', () => {
  it('escapes untrusted names and labels estimates vs measured', () => {
    expect(esc('<img src=x onerror="a">')).toBe('&lt;img src=x onerror=&quot;a&quot;&gt;');
    const ms = buildTenantMargins([row({ company_name: '<script>alert(1)</script>', ai_cost_usd: 500 })], { fallbackVoiceCpm: 0.1, days: 30 });
    const html = buildReportHtml({
      title: 'T', periodLabel: 'Oct', generatedAtIso: '2026-11-02T00:00:00Z', coverage: { callsTotal: 2, callsWithCost: 1 },
      totals: summarizeMargins(ms), planStats: buildPlanStats(ms), negative: negativeMarginOrgs(ms), drivers: [{ label: 'x', usd: 1, basis: 'estimated' }],
      freeTier: { orgs: 0, avgCostUsd: null }, reconciliation: null, assumptions: ['a < b'],
    });
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Estimate');
    expect(html).toContain('a &lt; b');
    expect(html).toContain('Cost data coverage');
  });
});

describe('input validation', () => {
  const okRate = { component: 'asr', provider: 'p', unit: 'per_minute', rateUsd: '0.01', source: 'invoice Oct', sourceUrl: '', effectiveFrom: '2026-10-01', effectiveTo: '' };
  it('dates', () => { expect(isIsoDate('2026-02-30')).toBe(false); expect(isIsoDate('2026-02-28')).toBe(true); });
  it('accepts a sourced rate and rejects missing source / bad ranges / bad url', () => {
    expect(validateRateInput(okRate).ok).toBe(true);
    expect(validateRateInput({ ...okRate, source: ' ' }).ok).toBe(false);
    expect(validateRateInput({ ...okRate, rateUsd: '' }).ok).toBe(false);
    expect(validateRateInput({ ...okRate, rateUsd: '-1' }).ok).toBe(false);
    expect(validateRateInput({ ...okRate, effectiveTo: '2026-10-01' }).ok).toBe(false);
    expect(validateRateInput({ ...okRate, sourceUrl: 'javascript:alert(1)' }).ok).toBe(false);
    expect(validateRateInput({ ...okRate, component: 'nope' }).ok).toBe(false);
  });
  it('limits: hard >= soft, empty = no limit', () => {
    expect(validateLimitInput({ plan: 'starter', softCostUsd: '', hardCostUsd: '', maxCallSeconds: '' }).ok).toBe(true);
    expect(validateLimitInput({ plan: 'starter', softCostUsd: '30', hardCostUsd: '20', maxCallSeconds: '' }).ok).toBe(false);
    expect(validateLimitInput({ plan: 'starter', softCostUsd: '', hardCostUsd: '', maxCallSeconds: '0' }).ok).toBe(false);
    expect(validateLimitInput({ plan: 'starter', softCostUsd: '', hardCostUsd: '', maxCallSeconds: '12.5' }).ok).toBe(false);
  });
  it('invoices: first-of-month key', () => {
    const v = validateInvoiceInput({ provider: 'vapi', month: '2026-10', invoicedUsd: '123.45', invoiceRef: '' });
    expect(v.ok && v.value.periodMonth).toBe('2026-10-01');
    expect(validateInvoiceInput({ provider: 'vapi', month: '2026-13', invoicedUsd: '1', invoiceRef: '' }).ok).toBe(false);
    expect(validateInvoiceInput({ provider: 'vapi', month: '2026-10', invoicedUsd: 'x', invoiceRef: '' }).ok).toBe(false);
  });
});

describe('priceUsageEvents', () => {
  const rate = (provider: string, rateUsd: number): CostRate => ({ component: 'sms_segment', provider, unit: 'per_segment', rateUsd, source: 's', effectiveFrom: '2026-01-01', effectiveTo: null });
  const ev = parseUsageEvents([{ component: 'sms_segment', unit: 'per_segment', quantity: 1000, events: 400 }, 'x']);
  it('prices with exactly one provider rate', () => expect(priceUsageEvents(ev, [rate('twilio', 0.008)], '2026-11-01')[0].costUsd).toBeCloseTo(8));
  it('no rate -> unpriced, two providers -> ambiguous, never $0', () => {
    expect(priceUsageEvents(ev, [], '2026-11-01')[0]).toEqual({ ...ev[0], costUsd: null, status: 'unpriced' });
    expect(priceUsageEvents(ev, [rate('a', 1), rate('b', 2)], '2026-11-01')[0].status).toBe('ambiguous');
    expect(priceUsageEvents(ev, [rate('a', 1)], '2025-01-01')[0].status).toBe('unpriced');
  });
});

describe('planAdvice / reconciliation', () => {
  const starter = { planId: 'starter', priceUsd: 79, includedMinutes: 400, overageRateUsd: 0.2 };
  it('empty history gives no projection', () => expect(planAdvice(projectPlan(starter, [], 0.1), null, 400)[0]).toContain('No usage history'));
  it('flags thin margin, loss share and break-even inside included minutes', () => {
    const p = projectPlan(starter, [300, 350, 400, 400, 400], 0.25);
    const text = planAdvice(p, 316, 400).join(' ');
    expect(text).toContain('thin-margin');
    expect(text).toContain('inside the 400 included');
  });
  it('reconciliation statuses', () => {
    expect(buildReconciliation({ month: '2026-10', provider: 'vapi', reportedUsd: 100, invoicedUsd: null, thresholdPct: 5 }).status).toBe('no_invoice');
    expect(buildReconciliation({ month: '2026-10', provider: 'vapi', reportedUsd: 120, invoicedUsd: 100, thresholdPct: 5 }).status).toBe('drift');
  });
});
