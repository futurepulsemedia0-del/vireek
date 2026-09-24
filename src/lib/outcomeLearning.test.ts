import { describe, expect, it } from 'vitest';
import { TRADE_PLAYBOOKS, matchJobType } from '@/lib/tradePlaybookCatalog';
import { LEARNING, deriveSuggestions, median, shrink, summarize, type JobOutcome, type PriceRef } from '@/lib/outcomeLearning';

const NOW = Date.parse('2026-09-24T00:00:00Z');
const hvac = TRADE_PLAYBOOKS[0];
const ac = hvac.jobTypes[0];
const price: PriceRef = { id: 'p1', service_name: ac.price.serviceName, price_cents: 24900, price_max_cents: 64900 };

let seq = 0;
function outcome(over: Partial<JobOutcome> = {}): JobOutcome {
  seq += 1;
  return {
    id: `o${seq}`, job_id: `j${seq}`, playbook_slug: 'hvac', job_type_key: ac.key, root_cause_key: null,
    resolution: 'fixed_first_visit', checklist_done: [], checklist_total: 0, parts_used: [], notes: null,
    revenue_cents: 40000, cost_cents: 20000, duration_minutes: 90, is_rework: false, caused_callback: false,
    technician_id: null, customer_rating: null, recorded_at: '2026-08-01T00:00:00Z', ...over,
  };
}
const many = (n: number, over: Partial<JobOutcome> = {}) => Array.from({ length: n }, () => outcome(over));

describe('math helpers', () => {
  it('median handles odd, even and empty', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
  it('shrink pulls small samples toward the prior', () => {
    expect(shrink(1, 0, 0.5)).toBe(0.5);
    expect(shrink(1, 2, 0.5)).toBeLessThan(0.7);
    expect(shrink(1, 200, 0.5)).toBeGreaterThan(0.98);
  });
});

describe('matchJobType', () => {
  const plumbing = TRADE_PLAYBOOKS[1];
  it('prefers the longest matching fragment', () => {
    expect(matchJobType(plumbing, 'Water heater leak')?.key).toBe('water-heater');
    expect(matchJobType(hvac, 'AC not cooling')?.key).toBe('ac-no-cooling');
    expect(matchJobType(hvac, 'HVAC tune-up')?.key).toBe('maintenance-tuneup');
  });
  it('returns undefined for empty or unknown text', () => {
    expect(matchJobType(hvac, '')).toBeUndefined();
    expect(matchJobType(hvac, null)).toBeUndefined();
    expect(matchJobType(hvac, 'window cleaning')).toBeUndefined();
  });
});

describe('summarize', () => {
  it('excludes rework jobs and reports callback only from matured outcomes', () => {
    const rows = [...many(4), ...many(2, { is_rework: true }), outcome({ recorded_at: '2026-09-23T00:00:00Z', caused_callback: true })];
    const s = summarize(rows, ac.benchmark, NOW);
    expect(s.n).toBe(5);
    expect(s.callbackPct).not.toBeNull();
    expect(s.callbackPct as number).toBeLessThanOrEqual(ac.benchmark.maxCallbackPct + 0.001);
  });
  it('returns empty stats with no data', () => {
    expect(summarize([], ac.benchmark, NOW).n).toBe(0);
  });
});

describe('deriveSuggestions', () => {
  const base = { playbook: hvac, priceItems: [price], tuning: [], decisions: [], now: NOW };

  it('stays silent below the minimum sample size', () => {
    expect(deriveSuggestions({ ...base, outcomes: many(3, { cost_cents: 39000, duration_minutes: 200 }) })).toHaveLength(0);
  });

  it('suggests a capped price increase when margin is below target', () => {
    const list = deriveSuggestions({ ...base, outcomes: many(10, { revenue_cents: 40000, cost_cents: 30000 }) });
    const s = list.find((x) => x.kind === 'price_adjust');
    expect(s).toBeDefined();
    const p = s?.payload as { new_price_cents: number; old_price_cents: number };
    expect(p.new_price_cents).toBeGreaterThan(p.old_price_cents);
    expect(p.new_price_cents).toBeLessThanOrEqual(Math.round((p.old_price_cents * (1 + LEARNING.maxPriceStepPct / 100)) / 100) * 100);
  });

  it('does not re-suggest a price change from data that predates an accepted one', () => {
    const outcomes = many(10, { revenue_cents: 40000, cost_cents: 30000, recorded_at: '2026-08-01T00:00:00Z' });
    const decisions = [{ kind: 'price_adjust' as const, job_type_key: ac.key, status: 'accepted' as const, decided_at: '2026-09-01T00:00:00Z' }];
    expect(deriveSuggestions({ ...base, outcomes, decisions }).some((x) => x.kind === 'price_adjust')).toBe(false);
  });

  it('suggests a duration target when the median deviates by 20% or more', () => {
    const s = deriveSuggestions({ ...base, outcomes: many(10, { duration_minutes: 150 }) }).find((x) => x.kind === 'duration_adjust');
    expect(s).toBeDefined();
    expect((s?.payload as { target_duration_minutes: number }).target_duration_minutes).toBeGreaterThan(ac.benchmark.durationMinutes);
  });

  it('flags a skipped checklist step that predicts callbacks', () => {
    const done = many(5, { checklist_total: 8, checklist_done: ['thermostat', 'airflow'], caused_callback: false });
    const skipped = many(5, { checklist_total: 8, checklist_done: ['airflow'], caused_callback: true });
    const s = deriveSuggestions({ ...base, outcomes: [...done, ...skipped] }).find((x) => x.kind === 'checklist_critical');
    expect((s?.payload as { item_id: string } | undefined)?.item_id).toBe('thermostat');
  });

  it('teaches the AI the dominant root cause, with a no-phone-diagnosis guard', () => {
    const rows = [...many(6, { root_cause_key: 'failed-capacitor' }), ...many(2, { root_cause_key: 'worn-contactor' }), ...many(2, { root_cause_key: 'low-refrigerant' })];
    const s = deriveSuggestions({ ...base, outcomes: rows }).find((x) => x.kind === 'root_cause_article');
    expect(s?.suggestion_key).toBe(`cause:hvac:${ac.key}:failed-capacitor`);
    expect((s?.payload as { summary: string }).summary).toContain('never diagnose');
  });
});

describe('catalog integrity', () => {
  it('has unique ids and valid price ranges', () => {
    for (const pb of TRADE_PLAYBOOKS) {
      const keys = new Set<string>();
      for (const jt of pb.jobTypes) {
        expect(keys.has(jt.key)).toBe(false);
        keys.add(jt.key);
        expect(new Set(jt.checklist.map((i) => i.id)).size).toBe(jt.checklist.length);
        if (jt.price.priceMaxCents !== undefined) expect(jt.price.priceMaxCents).toBeGreaterThanOrEqual(jt.price.priceCents);
        expect(jt.price.estimatedCostCents).toBeLessThan(jt.price.priceCents);
        if (jt.troubleshooting) expect(new Set(jt.troubleshooting.causes.map((c) => c.key)).size).toBe(jt.troubleshooting.causes.length);
      }
    }
  });
});
