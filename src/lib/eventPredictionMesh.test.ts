import { describe, expect, it } from 'vitest';
import {
  ACTION_CATALOG,
  EMPTY_SIGNALS,
  EVENT_DRIVER_WEIGHTS,
  MESH_EDGES,
  MESH_EVENT_ORDER,
  brierScore,
  buildMeshReport,
  calibrationBuckets,
  dataCoverage,
  levelOf,
  predictEvents,
  proposeActions,
  rankPredictions,
  type MeshSignals,
} from '@/lib/eventPredictionMesh';

const NOW = new Date('2027-02-01T12:00:00Z');

const calm: MeshSignals = {
  horizonHours: 72,
  weather: { activeAlerts: 0, severeAlerts: 0, surgeModeActive: false },
  equipment: { activeCount: 40, nearEndOfLifeShare: 0.05, serviceOverdueShare: 0.05 },
  failures: { recentRatePct: 2, priorRatePct: 2, sample: 80 },
  parts: { backorderedOnUpcoming: 0, neededOnUpcoming: 0, belowReorderShare: 0, trackedParts: 50 },
  workforce: {
    activeTechnicians: 6,
    horizonCapacityJobs: 90,
    upcomingJobs: 60,
    unassignedUpcoming: 0,
  },
  demand: { recentDaily: 20, baselineDaily: 20, missedRatePct: 2, emergenciesRecent: 0 },
  sla: { upcomingSlaJobs: 6, unassignedSlaJobs: 0, dueWithin24h: 0, recentBreaches30d: 0 },
  sentiment: {
    negativeShareRecent: 0.02,
    callsRecent: 140,
    openReworkJobs: 0,
    openRecoverySignals: 0,
  },
  unavailableSources: [],
};

const stressed: MeshSignals = {
  horizonHours: 72,
  weather: { activeAlerts: 3, severeAlerts: 2, surgeModeActive: true },
  equipment: { activeCount: 40, nearEndOfLifeShare: 0.6, serviceOverdueShare: 0.5 },
  failures: { recentRatePct: 18, priorRatePct: 7, sample: 80 },
  parts: {
    backorderedOnUpcoming: 5,
    neededOnUpcoming: 6,
    belowReorderShare: 0.5,
    trackedParts: 50,
  },
  workforce: {
    activeTechnicians: 4,
    horizonCapacityJobs: 60,
    upcomingJobs: 80,
    unassignedUpcoming: 30,
  },
  demand: { recentDaily: 45, baselineDaily: 20, missedRatePct: 18, emergenciesRecent: 9 },
  sla: { upcomingSlaJobs: 10, unassignedSlaJobs: 6, dueWithin24h: 6, recentBreaches30d: 4 },
  sentiment: {
    negativeShareRecent: 0.3,
    callsRecent: 140,
    openReworkJobs: 6,
    openRecoverySignals: 5,
  },
  unavailableSources: [],
};

const byKind = (signals: MeshSignals) =>
  Object.fromEntries(predictEvents(signals, { now: NOW }).map((p) => [p.kind, p]));

describe('predictEvents', () => {
  it('returns all five events in causal order', () => {
    const out = predictEvents(calm, { now: NOW });
    expect(out.map((p) => p.kind)).toEqual(MESH_EVENT_ORDER);
  });

  it('keeps probabilities within 0..1 and low for a calm business', () => {
    for (const p of predictEvents(calm, { now: NOW })) {
      expect(p.probability).toBeGreaterThanOrEqual(0);
      expect(p.probability).toBeLessThanOrEqual(1);
      expect(p.level).toBe('low');
    }
  });

  it('flags high risk across the mesh when stress signals stack up', () => {
    const p = byKind(stressed);
    expect(p.demand_spike.probability).toBeGreaterThan(0.6);
    expect(p.dispatch_pressure.probability).toBeGreaterThan(0.6);
    expect(p.sla_breach.probability).toBeGreaterThan(0.7);
    expect(p.customer_escalation.probability).toBeGreaterThan(0.6);
  });

  it('is monotonic: worse weather never lowers any probability', () => {
    const worse = { ...calm, weather: { activeAlerts: 4, severeAlerts: 3, surgeModeActive: true } };
    const a = byKind(calm);
    const b = byKind(worse);
    for (const k of MESH_EVENT_ORDER)
      expect(b[k].probability).toBeGreaterThanOrEqual(a[k].probability);
    expect(b.demand_spike.probability).toBeGreaterThan(a.demand_spike.probability);
  });

  it('propagates risk down the mesh (child lifted above its own evidence)', () => {
    const onlyDemand: MeshSignals = {
      ...calm,
      weather: { activeAlerts: 3, severeAlerts: 3, surgeModeActive: true },
      demand: { recentDaily: 60, baselineDaily: 20, missedRatePct: 10, emergenciesRecent: 10 },
    };
    const p = byKind(onlyDemand);
    expect(p.dispatch_pressure.probability).toBeGreaterThan(p.dispatch_pressure.baseProbability);
    expect(p.dispatch_pressure.cascade.some((c) => c.from === 'demand_spike')).toBe(true);
    expect(p.sla_breach.cascade.length).toBeGreaterThan(0);
  });

  it('never lets a root event receive cascade lift', () => {
    expect(byKind(stressed).demand_spike.cascade).toEqual([]);
  });

  it('treats missing data as uncertainty, not safety', () => {
    const blind = byKind({ ...EMPTY_SIGNALS, horizonHours: 72 });
    for (const k of MESH_EVENT_ORDER) {
      expect(blind[k].confidence).toBe(0);
      expect(blind[k].drivers).toHaveLength(0);
      expect(blind[k].probability).toBeLessThan(0.3);
    }
  });

  it('shrinks toward the base rate when only a sliver of evidence exists', () => {
    const thin: MeshSignals = {
      ...EMPTY_SIGNALS,
      weather: { activeAlerts: 3, severeAlerts: 3, surgeModeActive: true },
    };
    const full = byKind({ ...calm, weather: thin.weather });
    const sparse = byKind(thin);
    expect(sparse.demand_spike.confidence).toBeLessThan(full.demand_spike.confidence);
    expect(sparse.demand_spike.baseProbability).toBeLessThan(0.7);
  });

  it('sorts drivers by contribution and explains them', () => {
    const d = byKind(stressed).dispatch_pressure.drivers;
    expect(d.length).toBeGreaterThan(0);
    expect(d[0].detail.length).toBeGreaterThan(5);
    for (let i = 1; i < d.length; i++)
      expect(d[i - 1].value * d[i - 1].weight).toBeGreaterThanOrEqual(d[i].value * d[i].weight);
  });

  it('sets the forecast window from the horizon', () => {
    const p = predictEvents({ ...calm, horizonHours: 24 }, { now: NOW })[0];
    expect(p.windowStart).toBe(NOW.toISOString());
    expect(p.windowEnd).toBe(new Date(NOW.getTime() + 24 * 3_600_000).toISOString());
  });
});

describe('mesh definition', () => {
  it('has driver weights that sum to 1 for every event', () => {
    for (const kind of MESH_EVENT_ORDER) {
      const sum = Object.values(EVENT_DRIVER_WEIGHTS[kind]).reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1, 5);
    }
  });

  it('has edges that only point forward in the order (acyclic)', () => {
    for (const e of MESH_EDGES)
      expect(MESH_EVENT_ORDER.indexOf(e.from)).toBeLessThan(MESH_EVENT_ORDER.indexOf(e.to));
  });

  it('has unique action keys covering every event', () => {
    const keys = ACTION_CATALOG.map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const kind of MESH_EVENT_ORDER)
      expect(ACTION_CATALOG.some((a) => a.kind === kind)).toBe(true);
  });
});

describe('levelOf', () => {
  it('maps probabilities to levels', () => {
    expect(levelOf(0.1)).toBe('low');
    expect(levelOf(0.3)).toBe('elevated');
    expect(levelOf(0.55)).toBe('high');
    expect(levelOf(0.75)).toBe('critical');
  });
});

describe('proposeActions', () => {
  it('proposes nothing for a calm business', () => {
    expect(proposeActions(predictEvents(calm, { now: NOW }))).toEqual([]);
  });

  it('proposes actions for risky events, highest expected impact first', () => {
    const preds = predictEvents(stressed, { now: NOW });
    const actions = proposeActions(preds);
    expect(actions.length).toBeGreaterThan(0);
    const rankedKinds = rankPredictions(preds).map((p) => p.kind);
    const firstIdx = rankedKinds.indexOf(actions[0].kind);
    for (const a of actions) expect(rankedKinds.indexOf(a.kind)).toBeGreaterThanOrEqual(firstIdx);
  });

  it('respects the threshold', () => {
    const preds = predictEvents(stressed, { now: NOW });
    expect(proposeActions(preds, 0.99)).toEqual([]);
    expect(proposeActions(preds, 0.2).length).toBeGreaterThanOrEqual(
      proposeActions(preds, 0.5).length,
    );
  });

  it('only proposes trigger-gated actions when a matching driver is firing', () => {
    const noParts = {
      ...stressed,
      parts: {
        backorderedOnUpcoming: 0,
        neededOnUpcoming: 0,
        belowReorderShare: 0,
        trackedParts: 50,
      },
    };
    const preds = predictEvents(noParts, { now: NOW }).map((p) =>
      p.kind === 'parts_shortage' ? { ...p, probability: 0.9 } : p,
    );
    const keys = proposeActions(preds, 0.5).map((a) => a.key);
    expect(keys).not.toContain('parts_shortage.reserve_stock');
  });
});

describe('dataCoverage + report', () => {
  it('reports coverage of the signal groups', () => {
    expect(dataCoverage(calm)).toBe(1);
    expect(dataCoverage(EMPTY_SIGNALS)).toBe(0);
    expect(dataCoverage({ ...calm, parts: null, sla: null })).toBe(0.75);
  });

  it('produces a deterministic signature', () => {
    const a = buildMeshReport(stressed, { now: NOW });
    const b = buildMeshReport(stressed, { now: new Date('2027-02-02T00:00:00Z') });
    const c = buildMeshReport(calm, { now: NOW });
    expect(a.signature).toBe(b.signature);
    expect(a.signature).not.toBe(c.signature);
    expect(a.signature).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('calibration', () => {
  it('computes the Brier score', () => {
    expect(brierScore([])).toBeNull();
    expect(brierScore([{ kind: 'sla_breach', probability: 1, observed: true }])).toBe(0);
    expect(brierScore([{ kind: 'sla_breach', probability: 0.5, observed: false }])).toBe(0.25);
  });

  it('buckets predictions and compares to observed rates', () => {
    const rows = [
      { kind: 'demand_spike' as const, probability: 0.1, observed: false },
      { kind: 'demand_spike' as const, probability: 0.15, observed: false },
      { kind: 'sla_breach' as const, probability: 0.85, observed: true },
      { kind: 'sla_breach' as const, probability: 1, observed: true },
    ];
    const b = calibrationBuckets(rows);
    expect(b[0].count).toBe(2);
    expect(b[0].observedRate).toBe(0);
    expect(b[4].count).toBe(2);
    expect(b[4].observedRate).toBe(1);
  });
});
