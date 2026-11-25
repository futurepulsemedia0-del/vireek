/**
 * Ground-truth simulation for the Causal Dispatch Network (seeded, deterministic, no I/O).
 *
 * World: T technicians in skill tiers, J job types, a latent job difficulty d ~ N(0,1) that lowers first-time fix AND
 * steers dispatch (hard jobs score higher for senior technicians) => observational comparisons are confounded.
 * True potential FTF probability of technician j on job i:  P_i(j) = clip(base_τ − 0.08·d_i + θ_{jτ}, 0.05, 0.95).
 * Dispatch = the real policy shape: deterministic top pick; with probability q (enrollment) a uniform pick inside the
 * indifference set (scores within `delta` of the top). Logged propensities are q/k (+ 1−q for the top).
 *
 * Truth for cell (t, τ) is the exact finite-sample target of the estimator on the SAME rows:
 *     mean over randomizable rows with t ∈ S_i, τ_i = τ of [ P_i(t) − mean_{l ∈ S_i} P_i(l) ].
 */

import { makeRng, normalDraw, type EstRow } from '../../src/lib/causal';

export interface SimConfig {
  technicians: number;
  jobTypes: number;
  jobs: number;
  jobsPerWeek: number;
  /** Exploration enrollment probability, 0–0.25. */
  q: number;
  /** Indifference-set width in score points. */
  delta: number;
  /** SD of technician × job-type true effects (probability scale). */
  effectSd: number;
  /** Extra true advantage per skill tier (probability scale). */
  tierEffect: number;
  /** How strongly difficulty steers jobs to senior technicians (the confounding). */
  steering: number;
  seed: number;
}

export const DEFAULT_SIM: SimConfig = { technicians: 8, jobTypes: 4, jobs: 6000, jobsPerWeek: 60, q: 0.25, delta: 3, effectSd: 0.04, tierEffect: 0.03, steering: 0.8, seed: 1 };

export interface SimResult {
  rows: EstRow[];
  /** `${tech}|${type}` -> true effect relative to set peers, on the randomizable rows. */
  truth: Map<string, number>;
  /** `${tech}|${type}` -> naive observational contrast (mean Y of tech − mean Y of everyone else, same type). */
  naive: Map<string, number>;
  tiers: number[];
  qualifyingShare: number;
  meanSetSize: number;
}

const clip = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const techId = (j: number) => `t${j}`;
const typeId = (k: number) => `type${k}`;

export function simulateTenant(partial: Partial<SimConfig> = {}): SimResult {
  const c: SimConfig = { ...DEFAULT_SIM, ...partial };
  const rng = makeRng(`sim|${c.seed}`);
  const tiers = Array.from({ length: c.technicians }, (_, j) => Math.min(2, Math.floor((3 * j) / c.technicians)));
  const theta: number[][] = tiers.map((tier) => Array.from({ length: c.jobTypes }, () => c.tierEffect * tier + c.effectSd * normalDraw(rng)));
  const base = Array.from({ length: c.jobTypes }, (_, k) => 0.68 + 0.04 * k);

  const rows: EstRow[] = [];
  const truthSum = new Map<string, { s: number; n: number }>();
  const naiveAgg = new Map<string, { sum: number; n: number }>(); // per type: all realised assignments by tech
  const typeTotals = new Map<number, { sum: number; n: number }>();
  let qualifying = 0;
  let sizeSum = 0;

  for (let i = 0; i < c.jobs; i++) {
    const type = Math.floor(rng() * c.jobTypes);
    const d = clip(normalDraw(rng), -2, 2);
    // 3..6 technicians are available/eligible for this job
    const avail = [...Array(c.technicians).keys()].sort(() => rng() - 0.5).slice(0, 3 + Math.floor(rng() * 4));
    const score = new Map<number, number>();
    for (const j of avail) score.set(j, Math.round((4 * tiers[j] * (1 + c.steering * d) + 1.5 * normalDraw(rng)) * 10) / 10);
    const ordered = [...avail].sort((a, b) => (score.get(b) as number) - (score.get(a) as number) || a - b);
    const top = ordered[0];
    const set = ordered.filter((j) => (score.get(top) as number) - (score.get(j) as number) <= c.delta + 1e-9);
    const P = (j: number) => clip(base[type] - 0.08 * d + theta[j][type], 0.05, 0.95);

    // Dispatch: deterministic top unless enrolled in a set of >= 2
    const k = set.length;
    let chosen = top;
    if (k >= 2 && rng() < c.q) chosen = set[Math.min(k - 1, Math.floor(rng() * k))];
    const y = rng() < P(chosen) ? 1 : 0;

    const tn = naiveAgg.get(`${chosen}|${type}`) ?? { sum: 0, n: 0 };
    tn.sum += y; tn.n += 1; naiveAgg.set(`${chosen}|${type}`, tn);
    const tt = typeTotals.get(type) ?? { sum: 0, n: 0 };
    tt.sum += y; tt.n += 1; typeTotals.set(type, tt);

    if (k < 2) continue;
    qualifying++;
    sizeSum += k;
    const meanP = set.reduce((s, j) => s + P(j), 0) / k;
    for (const j of set) {
      const key = `${techId(j)}|${typeId(type)}`;
      const a = truthSum.get(key) ?? { s: 0, n: 0 };
      a.s += P(j) - meanP; a.n += 1; truthSum.set(key, a);
    }
    rows.push({
      decisionId: `d${i}`, jobId: `j${i}`, jobType: typeId(type), chosenId: techId(chosen),
      members: set.map((j) => ({ id: techId(j), p: j === top ? 1 - c.q + c.q / k : c.q / k, score: score.get(j) as number, f: {} })),
      outcomes: { ftf: y, callback14: null, callback30: null, durationResidual: null },
      clusterId: `${techId(chosen)}|${Math.floor(i / c.jobsPerWeek)}`,
    });
  }

  const truth = new Map([...truthSum].map(([k, v]) => [k, v.s / v.n]));
  const naive = new Map<string, number>();
  for (let j = 0; j < c.technicians; j++) {
    for (let t = 0; t < c.jobTypes; t++) {
      const own = naiveAgg.get(`${j}|${t}`);
      const tot = typeTotals.get(t);
      if (!own || own.n < 5 || !tot || tot.n - own.n < 5) continue;
      naive.set(`${techId(j)}|${typeId(t)}`, own.sum / own.n - (tot.sum - own.sum) / (tot.n - own.n));
    }
  }
  return { rows, truth, naive, tiers, qualifyingShare: qualifying / c.jobs, meanSetSize: qualifying ? sizeSum / qualifying : 0 };
}
