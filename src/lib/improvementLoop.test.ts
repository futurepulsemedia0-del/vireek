import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import {
  LOOP,
  analyzeLoop,
  attributeCauses,
  backtestFactor,
  baselineMinutes,
  correctionsActiveAt,
  durationDirection,
  fitFactor,
  normalizeKey,
  proposalPayload,
  variancePayload,
} from './improvementLoop';
import type { CorrectionRow, LoopRecord } from './improvementLoop';

const NOW = new Date('2026-10-01T08:00:00Z').getTime();
const DAY = 86_400_000;

let seq = 0;
function rec(over: Partial<LoopRecord> = {}): LoopRecord {
  seq += 1;
  return {
    jobId: `job-${seq}`,
    customerName: `Customer ${seq}`,
    serviceType: 'AC Repair',
    jobTypeKey: 'ac-repair',
    technicianId: 't1',
    predictedTechnicianId: 't1',
    completedAt: new Date(NOW - (60 - seq) * DAY * 0.5).toISOString(),
    predictedAt: new Date(NOW - (60 - seq) * DAY * 0.5 - DAY).toISOString(),
    predictedMinutes: 126, // 2.1 h
    predictedProbability: 85,
    partsScore: 90,
    techFitScore: 85,
    diagnosisScore: 80,
    scheduleScore: 80,
    predictedIssue: null,
    actualMinutes: 126,
    resolution: 'fixed_first_visit',
    rootCauseKey: null,
    isRework: false,
    causedCallback: false,
    arrivalLateMinutes: 0,
    accessWaitMinutes: 0,
    ...over,
  };
}

function correction(over: Partial<CorrectionRow> = {}): CorrectionRow {
  return {
    id: 'c1',
    scope: 'job_type',
    job_type_key: 'ac-repair',
    technician_id: null,
    factor: 1.5,
    sample_size: 12,
    backtest: {},
    status: 'active',
    proposed_at: new Date(NOW - 40 * DAY).toISOString(),
    decided_at: new Date(NOW - 30 * DAY).toISOString(),
    activated_at: new Date(NOW - 30 * DAY).toISOString(),
    deactivated_at: null,
    decision_reason: null,
    ...over,
  };
}

describe('normalizeKey', () => {
  it('canonicalises free text', () => {
    expect(normalizeKey('AC Repair')).toBe('ac-repair');
    expect(normalizeKey('  water_heater / install ')).toBe('water-heater-install');
    expect(normalizeKey(null)).toBe('unclassified');
  });
});

describe('durationDirection', () => {
  it('uses 20% with a 15 minute floor', () => {
    expect(durationDirection(126, 228)).toBe('over');
    expect(durationDirection(126, 140)).toBe('on_target');
    expect(durationDirection(30, 44)).toBe('on_target'); // 14 min is under the floor
    expect(durationDirection(30, 50)).toBe('over');
    expect(durationDirection(120, 60)).toBe('under');
  });
});

describe('correction history', () => {
  it('finds corrections live at an instant', () => {
    const c = correction({ deactivated_at: new Date(NOW - 10 * DAY).toISOString(), status: 'superseded' });
    expect(correctionsActiveAt([c], NOW - 20 * DAY)).toHaveLength(1);
    expect(correctionsActiveAt([c], NOW - 5 * DAY)).toHaveLength(0);
    expect(correctionsActiveAt([c], NOW - 35 * DAY)).toHaveLength(0);
  });

  it('recovers the prediction as it was BEFORE the correction', () => {
    const r = rec({ predictedMinutes: 189, predictedAt: new Date(NOW - 5 * DAY).toISOString() });
    expect(baselineMinutes(r, [correction({ factor: 1.5 })])).toBeCloseTo(126, 5);
    expect(baselineMinutes(r, [])).toBe(189);
  });

  it('returns null without a prediction', () => {
    expect(baselineMinutes(rec({ predictedMinutes: null }), [])).toBeNull();
    expect(baselineMinutes(rec({ predictedAt: null }), [])).toBeNull();
  });
});

describe('attributeCauses', () => {
  it('blames parts when the job closed as parts pending', () => {
    const c = attributeCauses(rec({ resolution: 'parts_pending' }), 1.8, 100, null);
    expect(c[0].key).toBe('parts');
    expect(c[0].evidence).toBe('measured');
  });

  it('shares sum to 1 and minutes to the overrun', () => {
    const c = attributeCauses(rec({ partsScore: 30, techFitScore: 40, accessWaitMinutes: 45 }), 1.8, 100, null);
    expect(c.length).toBeGreaterThan(1);
    expect(c.reduce((s, x) => s + x.share, 0)).toBeCloseTo(1, 1);
    expect(c.reduce((s, x) => s + x.minutes, 0)).toBeCloseTo(100, 0);
  });

  it('flags a diagnosis miss from the recorded root cause', () => {
    const c = attributeCauses(rec({ predictedIssue: 'Dirty air filter restricting airflow', rootCauseKey: 'refrigerant_leak' }), 1.6, 80, null);
    expect(c.some((x) => x.key === 'diagnosis')).toBe(true);
  });

  it('does not flag diagnosis when the root cause matches', () => {
    const c = attributeCauses(rec({ predictedIssue: 'Failed capacitor on the condenser', rootCauseKey: 'capacitor_failed' }), 1.6, 80, null);
    expect(c.some((x) => x.key === 'diagnosis')).toBe(false);
  });

  it('uses a hidden issue only when nothing else explains a big overrun', () => {
    const c = attributeCauses(rec(), 1.9, 100, null);
    expect(c[0].key).toBe('hidden_issue');
    expect(c[0].evidence).toBe('inferred');
  });

  it('refuses to guess: small unexplained overrun stays unexplained', () => {
    const c = attributeCauses(rec(), 1.3, 40, null);
    expect(c).toHaveLength(1);
    expect(c[0].key).toBe('unexplained');
  });

  it('uses a consistently slow technician as evidence', () => {
    const c = attributeCauses(rec(), 1.4, 50, Math.log(1.4));
    expect(c[0].key).toBe('technician_skill');
  });
});

describe('fitFactor', () => {
  const s = (ratio: number, n: number) => Array.from({ length: n }, (_, i) => ({ at: i, base: 100, actual: 100 * ratio }));
  it('shrinks small samples toward 1', () => {
    const small = fitFactor(s(1.8, 3));
    const large = fitFactor(s(1.8, 60));
    expect(small).toBeGreaterThan(1);
    expect(small).toBeLessThan(1.3);
    expect(large).toBeGreaterThan(1.6);
    expect(large).toBeLessThanOrEqual(1.8);
  });
  it('is bounded', () => {
    expect(fitFactor(s(20, 500))).toBeLessThanOrEqual(LOOP.factorMax);
    expect(fitFactor(s(0.01, 500))).toBeGreaterThanOrEqual(LOOP.factorMin);
  });
  it('is neutral with no data', () => {
    expect(fitFactor([])).toBe(1);
  });
});

describe('backtestFactor', () => {
  it('needs enough fit and test samples', () => {
    expect(backtestFactor(Array.from({ length: 5 }, (_, i) => ({ at: i, base: 100, actual: 180 })))).toBeNull();
  });
  it('proves a real bias helps on unseen jobs', () => {
    const bt = backtestFactor(Array.from({ length: 12 }, (_, i) => ({ at: i, base: 100, actual: 175 + (i % 3) * 5 })));
    expect(bt).not.toBeNull();
    expect(bt!.improvementPct).toBeGreaterThan(10);
    expect(bt!.maeAfter).toBeLessThan(bt!.maeBefore);
  });
});

describe('analyzeLoop', () => {
  it('detects the 2.1h predicted vs 3.8h actual miss and explains it', () => {
    const r = rec({ actualMinutes: 228, resolution: 'parts_pending', partsScore: 40 });
    const a = analyzeLoop([r], [], new Map(), NOW);
    expect(a.durationVariances).toHaveLength(1);
    const v = a.durationVariances[0];
    expect(v.direction).toBe('over');
    expect(v.ratio).toBeCloseTo(1.81, 1);
    expect(v.primaryCause).toBe('parts');
    expect(a.duration.hitRate).toBe(0);
  });

  it('excludes rework and jobs without a prediction', () => {
    const a = analyzeLoop([rec({ isRework: true, actualMinutes: 300 }), rec({ predictedAt: null, predictedMinutes: null })], [], new Map(), NOW);
    expect(a.durationVariances).toHaveLength(0);
    expect(a.totals.unpredicted).toBe(1);
    expect(a.totals.rework).toBe(1);
  });

  it('learns a validated correction from consistent under-prediction', () => {
    const records = Array.from({ length: 14 }, (_, i) => rec({ actualMinutes: 215 + (i % 4) * 6, technicianId: `t${(i % 3) + 1}` }));
    const a = analyzeLoop(records, [], new Map(), NOW);
    const p = a.proposals.find((x) => x.scope === 'job_type');
    expect(p).toBeDefined();
    expect(p!.factor).toBeGreaterThan(1.3);
    expect(p!.factor).toBeLessThanOrEqual(LOOP.factorMax);
    expect(p!.backtest.improvementPct).toBeGreaterThanOrEqual(LOOP.minImprovement * 100);
  });

  it('does not propose anything when predictions are already accurate', () => {
    const records = Array.from({ length: 14 }, (_, i) => rec({ actualMinutes: 126 + (i % 2 ? 6 : -6) }));
    const a = analyzeLoop(records, [], new Map(), NOW);
    expect(a.proposals).toHaveLength(0);
  });

  it('keeps small groups on a watch list instead of proposing', () => {
    const records = Array.from({ length: 5 }, () => rec({ actualMinutes: 230 }));
    const a = analyzeLoop(records, [], new Map(), NOW);
    expect(a.proposals).toHaveLength(0);
    expect(a.watching.some((w) => w.reason === 'collecting')).toBe(true);
  });

  it('learns from the un-corrected baseline, never on top of an active correction', () => {
    // Engine already applies x1.5 (126 -> 189); reality is ~2x the baseline (252).
    const history = [correction({ factor: 1.5, activated_at: new Date(NOW - 80 * DAY).toISOString() })];
    const records = Array.from({ length: 14 }, (_, i) =>
      rec({ predictedMinutes: 189, actualMinutes: 250 + (i % 3) * 4, technicianId: `t${(i % 3) + 1}` }),
    );
    const a = analyzeLoop(records, history, new Map(), NOW);
    const p = a.proposals.find((x) => x.scope === 'job_type');
    expect(p).toBeDefined();
    // Absolute factor vs baseline (~1.9-2.0), not an incremental ~1.3.
    expect(p!.factor).toBeGreaterThan(1.6);
  });

  it('flags an active correction that makes predictions worse', () => {
    // Correction x1.8 is active, but jobs actually run at baseline.
    const since = new Date(NOW - 50 * DAY).toISOString();
    const history = [correction({ factor: 1.8, activated_at: since })];
    const records = Array.from({ length: 8 }, () => rec({ predictedMinutes: 227, actualMinutes: 126 }));
    const a = analyzeLoop(records, history, new Map(), NOW);
    const perf = a.performance.find((x) => x.id === 'c1');
    expect(perf).toBeDefined();
    expect(perf!.underperforming).toBe(true);
    expect(perf!.improvementPct!).toBeLessThan(0);
  });

  it('marks a helpful active correction as improving', () => {
    const history = [correction({ factor: 1.5, activated_at: new Date(NOW - 60 * DAY).toISOString() })];
    const records = Array.from({ length: 8 }, () => rec({ predictedMinutes: 189, actualMinutes: 190 }));
    const a = analyzeLoop(records, history, new Map(), NOW);
    const perf = a.performance.find((x) => x.id === 'c1');
    expect(perf!.underperforming).toBe(false);
    expect(perf!.improvementPct!).toBeGreaterThan(50);
  });

  it('judges first-time-fix only on matured outcomes', () => {
    const fresh = rec({ completedAt: new Date(NOW - 2 * DAY).toISOString(), resolution: 'unresolved' });
    const old = rec({ completedAt: new Date(NOW - 40 * DAY).toISOString(), resolution: 'fixed_first_visit' });
    const a = analyzeLoop([fresh, old], [], new Map(), NOW);
    expect(a.ftfVariances).toHaveLength(1);
    expect(a.ftfVariances[0].success).toBe(true);
  });

  it('measures over-confidence in first-time-fix predictions', () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      rec({
        predictedProbability: 92,
        completedAt: new Date(NOW - 30 * DAY - i * DAY).toISOString(),
        resolution: i < 6 ? 'fixed_first_visit' : 'fixed_followup',
      }),
    );
    const a = analyzeLoop(rows, [], new Map(), NOW);
    expect(a.ftf.n).toBe(10);
    expect(a.ftf.actualRate).toBe(60);
    expect(a.ftf.gapPoints!).toBeGreaterThan(25);
  });

  it('builds a workflow action from a recurring cause', () => {
    const records = Array.from({ length: 6 }, () => rec({ actualMinutes: 240, resolution: 'parts_pending', partsScore: 30 }));
    const a = analyzeLoop(records, [], new Map(), NOW);
    expect(a.actions.length).toBeGreaterThan(0);
    expect(a.actions[0].cause).toBe('parts');
    expect(a.actions[0].href).toBe('/dashboard/parts-market');
  });

  it('returns 8 trend weeks', () => {
    expect(analyzeLoop([rec()], [], new Map(), NOW).trend).toHaveLength(LOOP.trendWeeks);
  });
});

describe('payloads', () => {
  it('only emits proposals the server will accept', () => {
    const records = Array.from({ length: 14 }, (_, i) => rec({ actualMinutes: 215 + (i % 4) * 6 }));
    const a = analyzeLoop(records, [], new Map(), NOW);
    const props = proposalPayload(a);
    expect(props.length).toBeGreaterThan(0);
    for (const p of props) {
      expect((p.backtest as { improvementPct: number }).improvementPct).toBeGreaterThanOrEqual(5);
      expect(p.factor as number).toBeGreaterThanOrEqual(0.5);
      expect(p.factor as number).toBeLessThanOrEqual(2);
    }
    const vars = variancePayload(a);
    expect(vars.every((v) => v.metric === 'duration' || v.metric === 'first_time_fix')).toBe(true);
  });
});
