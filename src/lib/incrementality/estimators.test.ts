import { describe, expect, it } from 'vitest';
import {
  assessEstimate,
  bookingSensitivity,
  differenceInDifferences,
  eValue,
  incrementalRevenueTotal,
  makeRng,
  stratifiedAtt,
  type CallObservation,
  type DidRow,
} from './estimators';

const TICKET = 40_000;

interface SimOpts {
  businesses: number;
  callsPerBusiness: number;
  /** Booking probability if answered, for a "base" caller. */
  trueLift: number;
  baseRate: number;
  /** Urgent callers: extra booking probability AND higher chance of being answered (observed confounding). */
  urgentBoost?: number;
  /** Hidden trait: raises booking AND answering, but is NOT in the covariates. */
  hiddenBoost?: number;
  seed: number;
}

function simulate(o: SimOpts): CallObservation[] {
  const rng = makeRng(o.seed);
  const out: CallObservation[] = [];
  for (let b = 0; b < o.businesses; b++) {
    for (let i = 0; i < o.callsPerBusiness; i++) {
      const urgent = rng() < 0.4;
      const hidden = rng() < 0.5;
      const pAnswered = 0.5 + (urgent ? 0.3 : 0) + (hidden ? 0.15 : 0) - 0.1;
      const answered = rng() < pAnswered;
      const pBook = o.baseRate + (urgent ? (o.urgentBoost ?? 0) : 0) + (hidden ? (o.hiddenBoost ?? 0) : 0) + (answered ? o.trueLift : 0);
      const booked = rng() < Math.min(0.99, pBook);
      out.push({
        id: `c${b}-${i}`, businessId: `b${b}`, answered,
        timeBlock: rng() < 0.5 ? 'evening' : 'overnight', category: 'plumbing',
        urgency: urgent ? 'urgent' : 'routine', source: 'google',
        booked, bookedRevenueCents: booked ? TICKET : 0,
      });
    }
  }
  return out;
}

describe('stratifiedAtt on simulated data with a known effect', () => {
  it('recovers the true lift when confounding is observed (naive is biased, adjusted is not)', () => {
    const obs = simulate({ businesses: 20, callsPerBusiness: 600, trueLift: 0.2, baseRate: 0.1, urgentBoost: 0.3, seed: 1 });
    const est = stratifiedAtt(obs, 'booked', { reps: 300, seed: 7 });
    expect(est).not.toBeNull();
    if (!est) return;
    expect(est.naive ?? 0).toBeGreaterThan(0.26); // biased upward by urgent callers being answered more
    expect(Math.abs(est.point - 0.2)).toBeLessThan(0.03);
    expect(est.ciLow).toBeLessThan(0.2);
    expect(est.ciHigh).toBeGreaterThan(0.2);
    expect(est.overlapShare).toBeGreaterThan(0.99);
  });

  it('recovers a revenue effect in cents', () => {
    const obs = simulate({ businesses: 20, callsPerBusiness: 600, trueLift: 0.2, baseRate: 0.1, urgentBoost: 0.3, seed: 2 });
    const est = stratifiedAtt(obs, 'bookedRevenueCents', { reps: 300, seed: 7 });
    expect(est).not.toBeNull();
    if (!est) return;
    expect(Math.abs(est.point - 0.2 * TICKET)).toBeLessThan(0.03 * TICKET);
    const total = incrementalRevenueTotal(est);
    expect(total.ciLowCents).toBeLessThan(total.pointCents);
    expect(total.ciHighCents).toBeGreaterThan(total.pointCents);
    expect(total.basedOnAnsweredCalls).toBe(est.nTreatedSupported);
  });

  it('reports an interval that includes zero (inconclusive) when the true effect is zero', () => {
    const obs = simulate({ businesses: 20, callsPerBusiness: 600, trueLift: 0, baseRate: 0.2, urgentBoost: 0.3, seed: 3 });
    const est = stratifiedAtt(obs, 'booked', { reps: 300, seed: 7 });
    expect(est).not.toBeNull();
    if (!est) return;
    expect(est.ciLow).toBeLessThanOrEqual(0);
    expect(est.ciHigh).toBeGreaterThanOrEqual(0);
    const a = assessEstimate(est);
    expect(a.verdict).toBe('inconclusive');
    expect(a.reasons).toContain('interval_includes_zero');
  });

  it('does NOT claim immunity to an unmeasured confounder: it stays biased and the E-value flags it', () => {
    const obs = simulate({ businesses: 20, callsPerBusiness: 600, trueLift: 0.05, baseRate: 0.1, hiddenBoost: 0.3, seed: 4 });
    const est = stratifiedAtt(obs, 'booked', { reps: 300, seed: 7 });
    expect(est).not.toBeNull();
    if (!est) return;
    expect(est.point).toBeGreaterThan(0.05 + 0.02); // hidden trait inflates the estimate
    const rateAns = obs.filter((o) => o.answered && o.booked).length / obs.filter((o) => o.answered).length;
    const s = bookingSensitivity(est, rateAns);
    expect(s.eValuePoint).not.toBeNull();
    expect(s.eValuePoint ?? 0).toBeGreaterThan(1);
    expect(assessEstimate(est, s).residualConfoundingPossible).toBe(true);
  });

  it('returns insufficient_data for thin samples and null when one arm is missing', () => {
    const thin = simulate({ businesses: 2, callsPerBusiness: 30, trueLift: 0.2, baseRate: 0.1, seed: 5 });
    const est = stratifiedAtt(thin, 'booked', { reps: 200 });
    expect(assessEstimate(est).verdict).toBe('insufficient_data');
    const onlyAnswered = thin.filter((o) => o.answered);
    expect(stratifiedAtt(onlyAnswered, 'booked')).toBeNull();
    expect(assessEstimate(null).verdict).toBe('insufficient_data');
  });

  it('never compares across businesses and flags poor overlap', () => {
    // Business A is always answered, business B never: no within-business comparison exists.
    const obs: CallObservation[] = [];
    for (let i = 0; i < 200; i++) {
      const base = { timeBlock: 't', category: 'c', urgency: 'u', source: 's', booked: false, bookedRevenueCents: 0 };
      obs.push({ ...base, id: `a${i}`, businessId: 'A', answered: true, booked: true, bookedRevenueCents: TICKET });
      obs.push({ ...base, id: `b${i}`, businessId: 'B', answered: false });
    }
    expect(stratifiedAtt(obs, 'booked')).toBeNull();
  });

  it('is deterministic for a given seed', () => {
    const obs = simulate({ businesses: 8, callsPerBusiness: 200, trueLift: 0.2, baseRate: 0.1, seed: 6 });
    const a = stratifiedAtt(obs, 'booked', { reps: 200, seed: 11 });
    const b = stratifiedAtt(obs, 'booked', { reps: 200, seed: 11 });
    expect(a?.ciLow).toBe(b?.ciLow);
    expect(a?.ciHigh).toBe(b?.ciHigh);
  });
});

function simulateDid(opts: { n: number; effect: number; groupGap: number; trendT: number; seed: number }): DidRow[] {
  const rng = makeRng(opts.seed);
  const rows: DidRow[] = [];
  for (let b = 0; b < opts.n; b++) {
    const treated = b % 2 === 0;
    const level = 10 + (treated ? opts.groupGap : 0) + (rng() - 0.5) * 2;
    for (let p = 0; p < 8; p++) {
      const post = p >= 4;
      const trend = treated ? opts.trendT * p : 0;
      for (let k = 0; k < 5; k++) {
        rows.push({ businessId: `b${b}`, treatedGroup: treated, period: p, outcome: level + 0.3 * p + trend + (post && treated ? opts.effect : 0) + (rng() - 0.5) });
      }
    }
  }
  return rows;
}

describe('differenceInDifferences', () => {
  it('recovers a known effect despite a permanent level gap between groups', () => {
    const est = differenceInDifferences(simulateDid({ n: 40, effect: 3, groupGap: 8, trendT: 0, seed: 1 }), 4, { reps: 300 });
    expect(est).not.toBeNull();
    if (!est) return;
    expect(est.naive ?? 0).toBeGreaterThan(9); // gap + effect
    expect(Math.abs(est.point - 3)).toBeLessThan(0.5);
    expect(est.ciLow).toBeLessThan(3);
    expect(est.ciHigh).toBeGreaterThan(3);
    expect(est.preTrend?.violated).toBe(false);
  });

  it('flags a violated parallel-trend assumption and refuses a supported verdict', () => {
    const est = differenceInDifferences(simulateDid({ n: 40, effect: 3, groupGap: 8, trendT: 0.8, seed: 2 }), 4, { reps: 300 });
    expect(est).not.toBeNull();
    if (!est) return;
    expect(est.preTrend?.violated).toBe(true);
    const a = assessEstimate(est);
    expect(a.verdict).toBe('inconclusive');
    expect(a.reasons).toContain('pretrend_violated');
  });

  it('returns null without both groups', () => {
    const rows = simulateDid({ n: 10, effect: 1, groupGap: 0, trendT: 0, seed: 3 }).filter((r) => r.treatedGroup);
    expect(differenceInDifferences(rows, 4)).toBeNull();
  });
});

describe('eValue', () => {
  it('matches the VanderWeele-Ding formula and is symmetric around 1', () => {
    expect(eValue(2)).toBeCloseTo(2 + Math.SQRT2, 6);
    expect(eValue(0.5)).toBeCloseTo(eValue(2), 6);
    expect(eValue(1)).toBe(1);
    expect(Number.isNaN(eValue(-1))).toBe(true);
  });
});

describe('single-account analysis needs time-block clusters', () => {
  it('uses weekly clusters so the interval is not falsely zero-width', () => {
    const obs = simulate({ businesses: 1, callsPerBusiness: 4000, trueLift: 0.2, baseRate: 0.1, urgentBoost: 0.3, seed: 9 })
      .map((o, i) => ({ ...o, clusterId: `w${i % 26}` }));
    const est = stratifiedAtt(obs, 'booked', { reps: 300, seed: 3 });
    expect(est).not.toBeNull();
    if (!est) return;
    expect(est.clusters).toBe(26);
    expect(est.ciHigh - est.ciLow).toBeGreaterThan(0.005);
    expect(Math.abs(est.point - 0.2)).toBeLessThan(0.04);
  });

  it('without clusterId a one-business account has one cluster and is flagged insufficient', () => {
    const obs = simulate({ businesses: 1, callsPerBusiness: 4000, trueLift: 0.2, baseRate: 0.1, seed: 9 });
    const est = stratifiedAtt(obs, 'booked', { reps: 200 });
    expect(est?.clusters).toBe(1);
    expect(assessEstimate(est).verdict).toBe('insufficient_data');
  });
});
