import { describe, expect, it } from 'vitest';
import { applyIntegrity, computeScoreboard, monthWindowFor, type ValueEvent } from './engine.ts';

let seq = 0;
function ev(p: Partial<ValueEvent> = {}): ValueEvent {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    source_feature: 'after_hours_answering',
    type: 'recovered_revenue',
    amount: 10000,
    unit: 'cents',
    currency: 'USD',
    confidence: 'measured',
    method_note: 'note',
    evidence_ref: `jobs:3f2b8c1e-7a41-4d6e-9b0a-1c2d3e4f50${String(seq).padStart(2, '0')}`,
    supersedes_ref: null,
    occurred_at: '2026-10-10T15:00:00Z',
    ...p,
  };
}
const board = (events: ValueEvent[]) =>
  computeScoreboard({ events, window: monthWindowFor('2026-10', 'America/New_York')!, currency: 'USD' });

describe('third tier: experimentally measured (incremental)', () => {
  const exp = (p: Partial<ValueEvent> = {}) =>
    ev({
      confidence: 'experimental',
      source_feature: 'incrementality_holdout',
      amount: 120000,
      ci_low: 30000,
      ci_high: 210000,
      evidence_ref: 'experiment:11111111-1111-4111-8111-111111111111:itt',
      ...p,
    });

  it('never merges into measured, estimated, total, trend, features or the cost multiple', () => {
    const base = board([ev({ amount: 10000 }), ev({ amount: 5000, confidence: 'estimated' })]);
    const withExp = board([ev({ amount: 10000 }), ev({ amount: 5000, confidence: 'estimated' }), exp()]);
    expect(withExp.money).toEqual(base.money);
    expect(withExp.byFeature).toEqual(base.byFeature);
    expect(withExp.trend).toEqual(base.trend);
    expect(withExp.counts.measured).toBe(base.counts.measured);
    expect(withExp.counts.estimated).toBe(base.counts.estimated);
    expect(withExp.cost).toEqual(base.cost);
    expect(withExp.incremental).toHaveLength(1);
  });

  it('exposes the interval and flags a result that spans zero', () => {
    const b = board([exp(), exp({ amount: 5000, ci_low: -40000, ci_high: 50000, evidence_ref: 'experiment:22222222-2222-4222-8222-222222222222:itt' })]);
    const rows = b.incremental;
    expect(rows).toHaveLength(2);
    const spanning = rows.find((r) => r.pointCents === 5000);
    expect(spanning?.spansZero).toBe(true);
    expect(spanning?.ciLowCents).toBe(-40000);
    expect(rows.find((r) => r.pointCents === 120000)?.spansZero).toBe(false);
  });

  it('rejects experimental events without a valid interval, wrong evidence prefix, or wrong shape', () => {
    const bad = [
      exp({ ci_low: null }),
      exp({ ci_high: null }),
      exp({ ci_low: 130000 }), // low above point
      exp({ ci_high: 100000 }), // high below point
      exp({ evidence_ref: 'jobs:abcdef' }),
      exp({ type: 'saved_hours', unit: 'minutes', currency: null }),
    ];
    const r = applyIntegrity(bad);
    expect(r.experimental).toHaveLength(0);
    expect(r.counts.invalid).toBe(bad.length);
  });

  it('allows zero and negative incremental estimates (no selective reporting)', () => {
    const r = applyIntegrity([exp({ amount: -2000, ci_low: -9000, ci_high: 4000 })]);
    expect(r.experimental).toHaveLength(1);
  });

  it('a measured event cannot supersede an experimental one and vice versa', () => {
    const e = exp();
    const m = ev({ supersedes_ref: e.evidence_ref, confidence: 'measured' });
    const r = applyIntegrity([e, m]);
    expect(r.experimental).toHaveLength(1);
    expect(r.effective).toHaveLength(1);
  });

  it('owner "not due to Vireek" reviews do not apply to the statistical tier and never remove it', () => {
    const e = exp();
    const r = applyIntegrity([e], [{ value_event_id: e.id, decision: 'not_due_to_vireek', decided_at: '2026-10-11T00:00:00Z' }]);
    expect(r.experimental).toHaveLength(1);
    expect(r.excluded).toHaveLength(0);
  });
});
