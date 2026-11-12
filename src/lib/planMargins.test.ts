import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import type { CostComponent, CostRate } from './unitEconomics';
import { GROSS_MARGIN_FLOOR_PCT, buildPlanListMargins, defaultPlanInputs, estimateVoiceCost, isRateNotVerified, platformFixedMonthlyUsd, rateBadge } from './planMargins';
import { priceAiRow } from './aiRepricing';
import { priceUsageEvents } from './marginDashboard';
import { PRICING_PLANS } from './pricing';

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/20290303000000_seed_provider_cost_rates.sql'), 'utf8');
const SQL2 = readFileSync(join(process.cwd(), 'supabase/migrations/20290303000100_fixed_monthly_cost_rates.sql'), 'utf8');
const TODAY = '2026-11-11';

/** Reads the seed rows straight from the migration, so these tests break if the SQL and the expectations drift apart. */
function parseSeed(sql: string): CostRate[] {
  const date = /DATE '(\d{4}-\d{2}-\d{2})'/.exec(sql)?.[1] ?? '';
  const re = /^\s*\('([a-z_]+)', '([a-z0-9_-]+)', '([a-z0-9_]+)', ([0-9.]+), '([a-z_]+)', '([^']*)'/gm;
  const out: CostRate[] = [];
  for (const m of sql.matchAll(re)) {
    out.push({ component: m[1] as CostComponent, provider: m[2], unit: m[3], rateUsd: parseFloat(m[4]), status: m[5], source: m[6], effectiveFrom: date, effectiveTo: null });
  }
  return out;
}
const seedRates = (): CostRate[] => [...parseSeed(SQL), ...parseSeed(SQL2)];
const rate = (component: CostComponent, rateUsd: number, status: string | null = null, provider = 'p'): CostRate =>
  ({ component, provider, unit: 'per_minute', rateUsd, source: 'fixture', effectiveFrom: '2026-01-01', effectiveTo: null, status });
const flat = (platform: number, status: string | null = null): CostRate[] => [
  rate('voice_platform', platform, status), rate('carrier_inbound', 0, status), rate('carrier_outbound', 0, status), rate('asr', 0, status), rate('llm', 0, status), rate('tts', 0, status),
];

describe('seed migration', () => {
  const rows = parseSeed(SQL);
  it('seeds exactly the 9 verified/assumed rates with the agreed values and statuses', () => {
    const got = rows.map((r) => `${r.component}|${r.provider}|${r.unit}|${r.rateUsd}|${r.status}`).sort();
    expect(got).toEqual([
      'asr|deepgram|per_minute|0.0097|unverified',
      'carrier_inbound|twilio|per_minute|0.0085|official',
      'carrier_outbound|twilio|per_minute|0.014|official',
      'llm|gemini|per_1m_input_tokens|0.3|secondary_source',
      'llm|gemini|per_1m_output_tokens|2.5|secondary_source',
      'llm|voice_llm_assumed|per_minute|0.02|assumption',
      'sms_segment|twilio|per_segment|0.0118|official',
      'tts|elevenlabs|per_minute|0.0192|unverified',
      'voice_platform|vapi|per_minute|0.05|official',
    ].sort());
  });
  it('has one provider per component+unit (no "ambiguous" pricing) and only valid statuses', () => {
    const keys = rows.map((r) => `${r.component}|${r.unit}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const r of rows) expect(['official', 'secondary_source', 'unverified', 'assumption']).toContain(r.status);
  });
  it('is guarded so human-entered rates are never shadowed, and re-runs are no-ops', () => {
    expect(SQL).toMatch(/WHERE NOT EXISTS/);
    expect(SQL).toMatch(/ON CONFLICT \(component, provider, unit, effective_from\) DO NOTHING/);
    expect(SQL).toMatch(/to_regclass\('public\.plan_cost_limits'\) IS NOT NULL/);
    expect(SQL).toMatch(/NOT EXISTS \(SELECT 1 FROM public\.plan_cost_limits\)/);
  });
});
describe('fixed monthly cost migration', () => {
  it('seeds the phone number and the platform fixed cost, and widens the CHECKs', () => {
    expect(parseSeed(SQL2).map((r) => `${r.component}|${r.provider}|${r.unit}|${r.rateUsd}|${r.status}`).sort()).toEqual([
      'phone_number|twilio|per_month|1.15|official',
      'platform_fixed|supabase|per_month|25|secondary_source',
    ]);
    expect(SQL2).toMatch(/'phone_number','platform_fixed'\)\)/);
    expect(SQL2).toMatch(/'per_event','per_month'\)\)/);
    expect(SQL2).toMatch(/WHERE NOT EXISTS/);
    expect(SQL2).toMatch(/DO NOTHING/);
  });
  it('uses the phone number rate per tenant and platform cost as overhead only', () => {
    const p = [{ id: 'starter', name: 'Starter', monthlyPrice: 79, includedMinutes: 400 }];
    const none = buildPlanListMargins(seedRates(), TODAY, { plans: p })[0];
    expect(none.fixedCostUsd).toBe(0);
    expect(none.status).toBe('ok');
    const one = buildPlanListMargins(seedRates(), TODAY, { plans: p, phoneNumbersPerTenant: 1 })[0];
    expect(one.fixedCostUsd).toBeCloseTo(1.15, 6);
    expect(one.costAtFullUseUsd).toBeCloseTo(44.11, 6);
    expect(one.marginPct).toBeCloseTo(44.16, 1);
    expect(one.status).toBe('below_floor'); // 45.6% -> 44.2% once the number is counted
    expect(platformFixedMonthlyUsd(seedRates(), TODAY)).toEqual({ usd: 25, unverified: true });
    expect(platformFixedMonthlyUsd([], TODAY)).toEqual({ usd: null, unverified: false });
  });
  it('a missing phone number rate makes the plan unpriced when numbers are counted', () => {
    const p = [{ id: 'x', name: 'X', monthlyPrice: 100, includedMinutes: 10 }];
    const r = buildPlanListMargins(flat(0.1), TODAY, { plans: p, phoneNumbersPerTenant: 1 })[0];
    expect(r.status).toBe('unpriced');
    expect(r.missing).toEqual(['phone_number']);
    expect(r.marginPct).toBeNull();
  });
});
describe('sample call with the seeded rates', () => {
  const rates = seedRates();
  it('produces non-zero cost components (inbound, 3 min)', () => {
    const e = estimateVoiceCost(rates, { minutes: 3, direction: 'inbound' }, TODAY);
    expect(e.lines.map((l) => l.component)).toEqual(['voice_platform', 'carrier_inbound', 'asr', 'llm', 'tts']);
    for (const l of e.lines) { expect(l.amountUsd).toBeGreaterThan(0); expect(l.basis).toBe('estimated'); }
    expect(e.costPerMinuteUsd).toBeCloseTo(0.1074, 6);
    expect(e.totalUsd).toBeCloseTo(0.3222, 6);
    expect(e.unverified).toEqual(['asr', 'llm', 'tts']);
  });
  it('uses the outbound carrier rate for outbound calls', () => {
    expect(estimateVoiceCost(rates, { minutes: 1, direction: 'outbound' }, TODAY).costPerMinuteUsd).toBeCloseTo(0.1129, 6);
  });
  it('stays unpriced before the rates take effect (never $0)', () => {
    const e = estimateVoiceCost(rates, { minutes: 3 }, '2026-11-08');
    expect(e.totalUsd).toBeNull();
    expect(e.missing).toHaveLength(5);
  });
  it('rejects bad minutes; a second provider for one component is ambiguous, not summed', () => {
    expect(() => estimateVoiceCost(rates, { minutes: -1 }, TODAY)).toThrow(RangeError);
    const e = estimateVoiceCost([...rates, rate('asr', 0.5, null, 'other')], { minutes: 1 }, TODAY);
    expect(e.ambiguous).toEqual(['asr']);
    expect(e.totalUsd).toBeNull();
  });
  it('is picked up by the existing AI and metered-usage pricing', () => {
    const ai = priceAiRow({ account_id: 'a', provider: 'gemini', model: 'gemini-2.5-flash', input_tokens: 1_000_000, output_tokens: 1_000_000, calls: 1, estimated_calls: 0, logged_cost_usd: 0 }, rates, TODAY);
    expect(ai.basis).toBe('rate_table');
    expect(ai.costUsd).toBeCloseTo(2.8, 6);
    const [sms] = priceUsageEvents([{ component: 'sms_segment', unit: 'per_segment', quantity: 100, events: 10, estimated_events: 0 }], rates, TODAY);
    expect(sms.status).toBe('priced');
    expect(sms.costUsd).toBeCloseTo(1.18, 6);
  });
});

describe('plan list-price margin', () => {
  const plans = [
    { id: 'free', name: 'Free', monthlyPrice: 0, includedMinutes: 50 },
    { id: 'starter', name: 'Starter', monthlyPrice: 79, includedMinutes: 400 },
    { id: 'professional', name: 'Professional', monthlyPrice: 199, includedMinutes: 1500 },
    { id: 'business', name: 'Business', monthlyPrice: 399, includedMinutes: 4000 },
    { id: 'enterprise', name: 'Enterprise', monthlyPrice: null, includedMinutes: Infinity },
  ];
  const by = (r: ReturnType<typeof buildPlanListMargins>) => Object.fromEntries(r.map((x) => [x.plan, x]));

  it('computes margin at 100% utilisation and flags plans below the floor', () => {
    const m = by(buildPlanListMargins(seedRates(), TODAY, { plans }));
    expect(GROSS_MARGIN_FLOOR_PCT).toBe(45);
    expect(m.starter.costAtFullUseUsd).toBeCloseTo(42.96, 6);
    expect(m.starter.marginPct).toBeCloseTo(45.62, 1);
    expect(m.starter.status).toBe('ok');
    expect(m.professional.marginPct).toBeCloseTo(19.05, 1);
    expect(m.professional.status).toBe('below_floor');
    expect(m.business.marginUsd).toBeCloseTo(-30.6, 6); // negative margin is flagged too
    expect(m.business.status).toBe('below_floor');
  });
  it('free and custom plans are not applicable', () => {
    const m = by(buildPlanListMargins(seedRates(), TODAY, { plans }));
    expect(m.free.status).toBe('not_applicable');
    expect(m.enterprise.status).toBe('not_applicable');
    expect(m.enterprise.marginPct).toBeNull();
  });
  it('exactly at the floor is OK; just under is flagged', () => {
    const p = [{ id: 'x', name: 'X', monthlyPrice: 100, includedMinutes: 100 }];
    expect(buildPlanListMargins(flat(0.55), TODAY, { plans: p })[0].status).toBe('ok'); // cost 55 -> 45.0%
    expect(buildPlanListMargins(flat(0.5501), TODAY, { plans: p })[0].status).toBe('below_floor');
  });
  it('a missing rate makes the plan unpriced instead of looking profitable', () => {
    const r = buildPlanListMargins(flat(0.1).filter((x) => x.component !== 'tts'), TODAY, { plans: [plans[1]] })[0];
    expect(r.status).toBe('unpriced');
    expect(r.missing).toEqual(['tts']);
    expect(r.marginPct).toBeNull();
  });
  it('adds an SMS allowance cost when one is supplied', () => {
    const p = [{ id: 'x', name: 'X', monthlyPrice: 100, includedMinutes: 100 }];
    expect(buildPlanListMargins(flat(0.1), TODAY, { plans: p, smsAllowanceCostUsd: 5 })[0].costAtFullUseUsd).toBeCloseTo(15, 6);
  });
  it('default plans follow PRICING_PLANS', () => {
    expect(defaultPlanInputs().map((p) => p.id)).toEqual(PRICING_PLANS.map((p) => p.id));
    const rows = buildPlanListMargins(seedRates(), TODAY);
    expect(rows).toHaveLength(PRICING_PLANS.length);
    expect(rows.find((r) => r.plan === 'enterprise')?.status).toBe('not_applicable');
  });
});

describe('"rate not verified" badge', () => {
  it('maps status to a badge; human-entered and official rates show none', () => {
    expect(rateBadge(null)).toBeNull();
    expect(rateBadge(undefined)).toBeNull();
    expect(rateBadge('official')).toBeNull();
    expect(rateBadge('assumption')).toEqual({ label: 'Assumption', tone: 'warn' });
    expect(rateBadge('unverified')).toEqual({ label: 'Rate not verified', tone: 'warn' });
    expect(rateBadge('secondary_source')).toEqual({ label: 'Secondary source', tone: 'info' });
    expect(rateBadge('something_new')?.label).toBe('Rate not verified'); // unknown value: conservative
    expect(isRateNotVerified('official')).toBe(false);
    expect(isRateNotVerified('assumption')).toBe(true);
  });
  it('a plan row is flagged only while an unverified/assumed rate feeds it', () => {
    const p = [{ id: 'x', name: 'X', monthlyPrice: 100, includedMinutes: 10 }];
    expect(buildPlanListMargins(flat(0.1, 'official'), TODAY, { plans: p })[0].rateNotVerified).toBe(false);
    expect(buildPlanListMargins(flat(0.1, null), TODAY, { plans: p })[0].rateNotVerified).toBe(false);
    const seeded = buildPlanListMargins(seedRates(), TODAY, { plans: p })[0];
    expect(seeded.rateNotVerified).toBe(true);
    expect(seeded.unverified).toEqual(['asr', 'llm', 'tts']);
  });
});
