/**
 * Shadow report: replays the gate over cases that REALLY ran remotely (shadow mode never blocks), so the
 * outcomes of "would block" cases are observed, not simulated. Every figure here is descriptive. None of
 * them is a guarantee, and the savings line is an ESTIMATE.
 */
import { wilson } from './stats.ts';

export interface ShadowRow {
  caseId: string;
  wouldAllow: boolean;
  state: 'mature' | 'censored' | 'active';
  /** Case was closed as resolved (customer confirmed the fix). */
  closedResolved: boolean;
  loss: 0 | 1;
}

export interface Rate {
  k: number;
  n: number;
  rate: number | null;
  low: number;
  high: number;
}

const rate = (k: number, n: number): Rate => {
  const w = wilson(k, n);
  return { k, n, rate: n ? k / n : null, low: w.low, high: w.high };
};

export interface ShadowReport {
  nLogged: number;
  nMature: number;
  nCensored: number;
  nActive: number;
  /** Share of logged attempts the gate would have blocked (all states). */
  wouldBlock: Rate;
  /** Realized false resolutions among matured attempts, overall / where gate allows / where it blocks. */
  realizedAll: Rate;
  realizedAllowed: Rate;
  realizedBlocked: Rate;
  savings: {
    truckRollCostCents: number;
    /** Matured attempts that ended as a verified remote success (no failure inside W). */
    successesAll: number;
    successesKept: number;
    successesForgone: number;
    /** Per matured attempt, as a share with a 95% Wilson interval. */
    forgoneShare: Rate;
    /** Cents; point estimate and interval scale the forgone share by the matured attempts. */
    forgoneCents: { point: number; low: number; high: number };
    keptCents: { point: number };
    note: string;
  };
}

export function buildShadowReport(rows: readonly ShadowRow[], truckRollCostCents: number): ShadowReport {
  const mature = rows.filter((r) => r.state === 'mature');
  const blockedAll = rows.filter((r) => !r.wouldAllow);
  const allowedM = mature.filter((r) => r.wouldAllow);
  const blockedM = mature.filter((r) => !r.wouldAllow);
  const success = (r: ShadowRow) => r.closedResolved && r.loss === 0;
  const successesAll = mature.filter(success).length;
  const successesKept = allowedM.filter(success).length;
  const successesForgone = blockedM.filter(success).length;
  const forgone = rate(successesForgone, mature.length);
  const scale = mature.length * truckRollCostCents;
  return {
    nLogged: rows.length,
    nMature: mature.length,
    nCensored: rows.filter((r) => r.state === 'censored').length,
    nActive: rows.filter((r) => r.state === 'active').length,
    wouldBlock: rate(blockedAll.length, rows.length),
    realizedAll: rate(mature.filter((r) => r.loss === 1).length, mature.length),
    realizedAllowed: rate(allowedM.filter((r) => r.loss === 1).length, allowedM.length),
    realizedBlocked: rate(blockedM.filter((r) => r.loss === 1).length, blockedM.length),
    savings: {
      truckRollCostCents,
      successesAll,
      successesKept,
      successesForgone,
      forgoneShare: forgone,
      forgoneCents: { point: successesForgone * truckRollCostCents, low: Math.round(forgone.low * scale), high: Math.round(forgone.high * scale) },
      keptCents: { point: successesKept * truckRollCostCents },
      note:
        'Estimate. Blocking a remote attempt sends a technician, so the gate can only keep or reduce avoided truck rolls. ' +
        'A blocked false resolution still needs a visit (now instead of later), so it is not counted as savings either way. ' +
        'Cases whose window is still open are excluded, so these figures are incomplete by construction.',
    },
  };
}
