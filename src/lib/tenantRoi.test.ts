import { describe, it, expect } from 'vitest';
import { parseRoiInputs, planCostCents } from './tenantRoi';
import { computeRoi } from '../../supabase/functions/_shared/economics/roi';

describe('tenant ROI inputs', () => {
  it('free/enterprise/unknown plans have no cost basis -> not enough data', () => {
    expect(planCostCents('free', 90)).toBeNull(); expect(planCostCents('enterprise', 90)).toBeNull(); expect(planCostCents('nope', 90)).toBeNull();
    expect(computeRoi([], planCostCents('free', 90)).status).toBe('not_enough_data');
  });
  it('paid plan cost scales with the window and is an integer', () => {
    const c = planCostCents('starter', 90); expect(Number.isInteger(c)).toBe(true); expect(c).toBe(Math.round(79 * 100 * 3));
  });
  it('parses rows, tags the attribution rule, ignores malformed rows', () => {
    const p = parseRoiInputs({ outcomes_total: 7, rows: [{ id: 'a', action_slug: 'send_invoice_reminder', action_at: '2026-01-01T00:00:00Z', outcome_at: '2026-01-02T00:00:00Z', value_cents: 5000, confidence: 0.9 }, { nope: 1 }] });
    expect(p.outcomesTotal).toBe(7); expect(p.outcomes).toHaveLength(1); expect(p.outcomes[0].rule).toBe('agent_action_outcome:send_invoice_reminder');
  });
  it('end to end: outcome before action is excluded, enough confident outcomes produce a range', () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({ id: `o${i}`, action_slug: 's', action_at: '2026-01-01T00:00:00Z', outcome_at: '2026-01-05T00:00:00Z', value_cents: 20000, confidence: 0.8 }));
    rows.push({ id: 'early', action_slug: 's', action_at: '2026-02-01T00:00:00Z', outcome_at: '2026-01-05T00:00:00Z', value_cents: 99999, confidence: 1 });
    const { outcomes } = parseRoiInputs({ rows });
    const r = computeRoi(outcomes, planCostCents('starter', 90));
    expect(r.status).toBe('ok');
    if (r.status === 'ok') { expect(r.excluded.preceded_action).toBe(1); expect(r.valueCentsHigh).toBe(120000); expect(r.valueCentsLow).toBe(96000); expect(r.inputIds).toHaveLength(6); }
  });
});
