/**
 * NTE burn-down (PURE). `openCostCents` is the running cost of the still-open job (labor + parts + travel); the
 * caller supplies it. NOTE: wiring labor/parts/travel cost sources from the existing job data is NOT done yet
 * (the cost columns were not verified against the live schema) — see the report.
 */
export type NteLevel = 'none' | 'ok' | 'warn' | 'exceeded';

export interface NteInput {
  approvedAmountCents: number | null;
  /** already invoiced against this approval */
  billedCents: number;
  /** cost accrued on the open job and not yet invoiced */
  openCostCents: number;
  warnPct: number;
  blockPct: number;
}

export interface NteBurnDown {
  level: NteLevel;
  committedCents: number;
  remainingCents: number | null;
  /** 0..n, one decimal place; null without an approved amount */
  pct: number | null;
  /** true once more billable work needs a change order BEFORE it is invoiced */
  requiresChangeOrder: boolean;
}

export function computeNteBurnDown(i: NteInput): NteBurnDown {
  const committed = Math.max(0, i.billedCents) + Math.max(0, i.openCostCents);
  if (i.approvedAmountCents === null || i.approvedAmountCents <= 0) {
    return { level: 'none', committedCents: committed, remainingCents: null, pct: null, requiresChangeOrder: false };
  }
  const pct = Math.round((committed / i.approvedAmountCents) * 1000) / 10;
  const exceeded = committed * 100 > i.approvedAmountCents * i.blockPct;
  const warn = committed * 100 >= i.approvedAmountCents * i.warnPct;
  return {
    level: exceeded ? 'exceeded' : warn ? 'warn' : 'ok',
    committedCents: committed,
    remainingCents: i.approvedAmountCents - committed,
    pct,
    requiresChangeOrder: exceeded,
  };
}
