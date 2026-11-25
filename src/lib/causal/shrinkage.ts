/**
 * Empirical-Bayes hierarchical shrinkage of technician × job-type effects (pure).
 *
 * Model (all normal, method-of-moments variance components, fixed-point iterations):
 *     θ̂_tj | θ_tj ~ N(θ_tj, s²_tj)                      s²_tj = squared cluster-robust SE of the raw estimate
 *     θ_tj = μ + a_t + b_j + c_tj,   μ ≡ 0 (peer-relative effects average to exactly 0 within every set)
 *     a_t ~ N(0, σa²)   technician level   (a technician who is above peers on one job type tends to be on others)
 *     b_j ~ N(0, σb²)   job-type level     (peer-relative effects average ~0 per type, but we do not assume it)
 *     c_tj ~ N(0, σc²)  cell level
 * Posterior for a cell: prior mean m0 = μ + â_t + b̂_j, prior variance v0 = σc² + Var(â_t | data) + Var(b̂_j | data),
 *     B = v0 / (v0 + s²),  θ̃ = B θ̂ + (1 − B) m0,  Var(θ̃) = B s².
 * A cell with no usable SE collapses to its prior (θ̃ = m0, SE = √v0): thin data never produces confident numbers.
 *
 * Optional pooled prior (cross-tenant, consent-gated, shadow only; see pooling.ts): when a job type has fewer than
 * MIN_LOCAL_CELLS_FOR_TYPE_EFFECT informative local cells, the type effect b_j is set to the pooled mean (treated as
 * known) and σc² is floored at the pooled between-technician variance. It only moves the SHRINKAGE TARGET.
 */

import { twoSidedP, Z95 } from './normal';

export interface ShrinkInput {
  technicianId: string;
  jobType: string;
  est: number;
  se: number | null;
  /** Decisions behind the estimate. When given, the HIERARCHY is fitted with design-based variances (see below). */
  n?: number;
}

export interface JobTypePrior {
  /** Pooled mean peer-relative effect for the job type (≈ 0 by construction). */
  mean: number;
  /** Pooled between-technician variance for the job type. */
  tau2: number;
}

export interface ShrunkCell extends ShrinkInput {
  shrunk: number;
  shrunkSe: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  /** Weight on the cell's own data (0 = pure prior, 1 = no shrinkage). */
  weight: number;
  /** Two-sided p-value of the RAW estimate (used for multiplicity control, not for the shrunk number). */
  rawP: number | null;
}

export interface ShrinkageModel {
  mu: number;
  sigmaA2: number;
  sigmaB2: number;
  sigmaC2: number;
  informativeCells: number;
}

export const MIN_LOCAL_CELLS_FOR_TYPE_EFFECT = 10;
/**
 * Plug-in empirical-Bayes intervals ignore uncertainty in the variance components and the correlation between cells that
 * share decisions. Simulation (scripts/causal/study.ts) measured ~88% coverage at a nominal 95%, so posterior SEs are
 * inflated by this documented factor. Calibrated on the simulated worlds only: re-check on real data before trusting it.
 */
export const POSTERIOR_SE_INFLATION = 1.25;
function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const l = m.get(k);
    if (l) l.push(it); else m.set(k, [it]);
  }
  return m;
}

/** Between-group variance beyond sampling noise: max(0, sample var of group means − mean sampling var of those means). */
function betweenVariance(groups: { mean: number; v: number }[]): number {
  if (groups.length < 2) return 0;
  const m = groups.reduce((s, g) => s + g.mean, 0) / groups.length;
  const varAcross = groups.reduce((s, g) => s + (g.mean - m) ** 2, 0) / (groups.length - 1);
  const meanV = groups.reduce((s, g) => s + g.v, 0) / groups.length;
  return Math.max(0, varAcross - meanV);
}

export function shrinkCells(cells: ShrinkInput[], priors: Record<string, JobTypePrior> = {}): { cells: ShrunkCell[]; model: ShrinkageModel } {
  const inf = cells.filter((c) => c.se !== null && c.se > 0 && Number.isFinite(c.est));
  // Variances used to FIT the hierarchy (weights, variance components). Estimated SEs are correlated with the
  // estimates themselves for binary outcomes, and weighting by them biases the group means (measured in simulation).
  // So fitting uses a design-based variance ū/n_cell (ū = median per-decision variance) when n is known; the posterior
  // below still uses each cell's own SE.
  const perDecision = inf.filter((c) => typeof c.n === 'number' && c.n > 0).map((c) => (c.se as number) ** 2 * (c.n as number)).sort((a, b) => a - b);
  const uMed = perDecision.length ? perDecision[perDecision.length >> 1] : 0;
  const s2 = (c: ShrinkInput) => (uMed > 0 && typeof c.n === 'number' && c.n > 0 ? uMed / c.n : (c.se as number) ** 2);

  let mu = 0;
  let sA = 0;
  let sB = 0;
  let sC = 0;
  const aHat = new Map<string, { mean: number; post: number }>();
  const bHat = new Map<string, { mean: number; post: number }>();

  if (inf.length > 0) {
    for (let iter = 0; iter < 6; iter++) {
      const w = (c: ShrinkInput) => 1 / (s2(c) + sC);
      // μ is FIXED at 0, not estimated: every effect is defined relative to the equal-weighted mean of the same set, so
      // the average over set members is exactly 0 in every row. Estimating μ with inverse-variance weights was measured
      // (simulation) to inject a +0.013 bias, because the estimated variances are correlated with the estimates.
      mu = 0;

      // technician level
      const byTech = groupBy(inf, (c) => c.technicianId);
      const techGroups = [...byTech.entries()].map(([id, list]) => {
        const ws = list.map(w);
        const tw = ws.reduce((s, v) => s + v, 0);
        const mean = list.reduce((s, c, i) => s + ws[i] * (c.est - mu - (bHat.get(c.jobType)?.mean ?? 0)), 0) / tw;
        return { id, mean, v: 1 / tw };
      });
      sA = betweenVariance(techGroups);
      aHat.clear();
      for (const g of techGroups) {
        const b = sA + g.v > 0 ? sA / (sA + g.v) : 0;
        aHat.set(g.id, { mean: b * g.mean, post: b * g.v });
      }

      // job-type level
      const byType = groupBy(inf, (c) => c.jobType);
      const typeGroups = [...byType.entries()].map(([id, list]) => {
        const ws = list.map(w);
        const tw = ws.reduce((s, v) => s + v, 0);
        const mean = list.reduce((s, c, i) => s + ws[i] * (c.est - mu - (aHat.get(c.technicianId)?.mean ?? 0)), 0) / tw;
        return { id, mean, v: 1 / tw };
      });
      sB = betweenVariance(typeGroups);
      bHat.clear();
      for (const g of typeGroups) {
        const b = sB + g.v > 0 ? sB / (sB + g.v) : 0;
        bHat.set(g.id, { mean: b * g.mean, post: b * g.v });
      }

      // cell level: DerSimonian–Laird on what is left
      const r = inf.map((c) => c.est - mu - (aHat.get(c.technicianId)?.mean ?? 0) - (bHat.get(c.jobType)?.mean ?? 0));
      const iw = inf.map((c) => 1 / s2(c));
      const siw = iw.reduce((s, v) => s + v, 0);
      const Q = r.reduce((s, v, i) => s + iw[i] * v * v, 0);
      const denom = siw - iw.reduce((s, v) => s + v * v, 0) / siw;
      sC = denom > 0 ? Math.max(0, (Q - (inf.length - 1)) / denom) : 0;
    }
  }

  const localPerType = new Map<string, number>();
  for (const c of inf) localPerType.set(c.jobType, (localPerType.get(c.jobType) ?? 0) + 1);

  const out: ShrunkCell[] = cells.map((c) => {
    const pri = priors[c.jobType];
    const usePooled = !!pri && (localPerType.get(c.jobType) ?? 0) < MIN_LOCAL_CELLS_FOR_TYPE_EFFECT;
    const a = aHat.get(c.technicianId);
    const bLocal = bHat.get(c.jobType);
    const aMean = a?.mean ?? 0;
    const aPost = a?.post ?? sA;
    const bMean = usePooled ? (pri as JobTypePrior).mean : bLocal?.mean ?? 0;
    const bPost = usePooled ? 0 : bLocal?.post ?? sB;
    const sCell = usePooled ? Math.max(sC, (pri as JobTypePrior).tau2) : sC;
    const m0 = mu + aMean + bMean;
    const v0 = sCell + aPost + bPost;
    const informative = c.se !== null && c.se > 0 && Number.isFinite(c.est);
    let shrunk: number;
    let se: number | null;
    let weight: number;
    if (informative) {
      const s = (c.se as number) ** 2;
      weight = v0 + s > 0 ? v0 / (v0 + s) : 0;
      shrunk = weight * c.est + (1 - weight) * m0;
      se = Math.sqrt(weight * s);
    } else {
      weight = 0;
      shrunk = m0;
      se = v0 > 0 && Number.isFinite(v0) ? Math.sqrt(v0) : null;
    }
    if (se !== null) se *= POSTERIOR_SE_INFLATION;
    const ok = se !== null && se > 0;
    return {
      technicianId: c.technicianId,
      jobType: c.jobType,
      est: c.est,
      se: c.se,
      shrunk,
      shrunkSe: ok ? se : null,
      ciLow: ok ? shrunk - Z95 * (se as number) : null,
      ciHigh: ok ? shrunk + Z95 * (se as number) : null,
      weight,
      rawP: informative ? twoSidedP(c.est / (c.se as number)) : null,
    };
  });

  return { cells: out, model: { mu, sigmaA2: sA, sigmaB2: sB, sigmaC2: sC, informativeCells: inf.length } };
}
