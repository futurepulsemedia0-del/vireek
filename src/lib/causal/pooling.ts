/**
 * Cross-tenant pooling of JOB-TYPE-LEVEL priors (pure). Shadow only.
 *
 * What is pooled: per job type, (a) the between-technician variance of peer-relative effects (τ²) and (b) the baseline
 * outcome rate. Never technician identities, never tenant ids, never per-row data. Pooled numbers feed ONLY the
 * shrinkage target and the power calculator; they never drive an assignment, ranking, pay, discipline or exclusion.
 * Tenants enter only if the repo's consent gate (cross_tenant_flows / xtl_contributors, flow 'causal_dispatch_priors')
 * says so; this module trusts its caller to have applied that gate and re-checks only the statistical minimums.
 *
 * ALL THRESHOLDS BELOW REQUIRE HUMAN (product + counsel) SIGN-OFF BEFORE ANY NON-SHADOW USE.
 */

import type { NetworkCell } from './analysis';
import type { JobTypePrior } from './shrinkage';

export const POOLING_MIN_TENANTS = 5;                 // a job type must appear in at least this many contributing tenants
export const POOLING_MIN_ROWS_PER_TENANT = 30;        // randomized decisions per tenant × job type
export const POOLING_MIN_TECHNICIANS_PER_TENANT = 3;  // τ² needs a spread of technicians
export const POOLING_MAX_TENANT_WEIGHT = 0.4;         // no tenant may carry more than this share of a pooled number (equal weights => <= 20%)
export const POOLING_MIN_TOTAL_ROWS = 300;
export const POOLING_ROW_ROUNDING = 10;               // published row counts are floored to a multiple of this
export const POOLING_JOB_TYPE_PATTERN = /^[a-z0-9][a-z0-9 _-]{1,39}$/; // free-text labels: allow-list shape only

export interface TenantJobTypeContribution {
  jobType: string;
  nRows: number;
  nTechnicians: number;
  /** Between-technician variance of the tenant's peer-relative FTF effects, net of sampling noise. */
  tau2: number;
  /** Tenant's baseline first-time-fix rate for the job type (0–1). */
  baseline: number;
}

export interface PooledJobTypePrior {
  jobType: string;
  nTenants: number;
  nRows: number;
  tau2: number;
  baseline: number;
}

/** Build one tenant's contribution from its own graded cells (FTF outcome) plus its observed baseline rates. */
export function contributionsFromCells(cells: NetworkCell[], baselines: Record<string, number>, rowsByJobType: Record<string, number>): TenantJobTypeContribution[] {
  const byType = new Map<string, NetworkCell[]>();
  for (const c of cells) {
    if (c.outcome !== 'ftf') continue;
    byType.set(c.jobType, [...(byType.get(c.jobType) ?? []), c]);
  }
  const out: TenantJobTypeContribution[] = [];
  for (const [jobType, list] of byType) {
    const inf = list.filter((c) => c.rawSe !== null);
    if (inf.length < POOLING_MIN_TECHNICIANS_PER_TENANT) continue;
    const mean = inf.reduce((s, c) => s + c.raw, 0) / inf.length;
    const varAcross = inf.reduce((s, c) => s + (c.raw - mean) ** 2, 0) / (inf.length - 1);
    const noise = inf.reduce((s, c) => s + (c.rawSe as number) ** 2, 0) / inf.length;
    const b = baselines[jobType];
    if (!(b >= 0 && b <= 1)) continue;
    out.push({ jobType, nRows: rowsByJobType[jobType] ?? 0, nTechnicians: inf.length, tau2: Math.max(0, varAcross - noise), baseline: b });
  }
  return out;
}

/**
 * Pool contributions from consenting tenants. Output contains NO tenant identifiers; a job type that does not meet
 * every minimum is simply absent (suppressed), not approximated.
 */
export function poolJobTypePriors(tenants: TenantJobTypeContribution[][]): PooledJobTypePrior[] {
  const byType = new Map<string, TenantJobTypeContribution[]>();
  for (const t of tenants) {
    const seen = new Set<string>();
    for (const c of t) {
      if (seen.has(c.jobType)) continue; // one contribution per tenant per job type
      seen.add(c.jobType);
      if (!POOLING_JOB_TYPE_PATTERN.test(c.jobType)) continue;
      if (c.nRows < POOLING_MIN_ROWS_PER_TENANT || c.nTechnicians < POOLING_MIN_TECHNICIANS_PER_TENANT) continue;
      if (!Number.isFinite(c.tau2) || c.tau2 < 0 || !(c.baseline >= 0 && c.baseline <= 1)) continue;
      byType.set(c.jobType, [...(byType.get(c.jobType) ?? []), c]);
    }
  }
  const out: PooledJobTypePrior[] = [];
  for (const [jobType, list] of [...byType.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const totalRows = list.reduce((s, c) => s + c.nRows, 0);
    if (list.length < POOLING_MIN_TENANTS || totalRows < POOLING_MIN_TOTAL_ROWS) continue;
    // Equal tenant weights (mirrors refresh_causal_dispatch_priors() in SQL). With >= POOLING_MIN_TENANTS tenants no
    // tenant can exceed 1/POOLING_MIN_TENANTS = 20%, which is below the 40% cap; the assertion below keeps that true.
    const w = list.map(() => 1 / list.length);
    if (Math.max(...w) > POOLING_MAX_TENANT_WEIGHT) continue;
    out.push({
      jobType,
      nTenants: list.length,
      nRows: Math.floor(totalRows / POOLING_ROW_ROUNDING) * POOLING_ROW_ROUNDING,
      tau2: list.reduce((s, c, i) => s + w[i] * c.tau2, 0),
      baseline: list.reduce((s, c, i) => s + w[i] * c.baseline, 0),
    });
  }
  return out;
}

/** Shrinkage target: pooled mean peer-relative effect is 0 by construction; pooled τ² floors the cell variance. */
export function toShrinkagePriors(pooled: PooledJobTypePrior[]): Record<string, JobTypePrior> {
  return Object.fromEntries(pooled.map((p) => [p.jobType, { mean: 0, tau2: p.tau2 }]));
}
