/**
 * Commission engine — pure, dependency-free calculation + validation helpers.
 *
 * The database (supabase/migrations/20270402000000_commissions.sql) is the
 * AUTHORITATIVE calculator: it computes every stored commission_records row.
 * This module mirrors the exact same arithmetic so the UI can preview a
 * plan before saving it, and so the rules are covered by unit tests.
 *
 * All money is integer cents. Rates are percentages with at most 2 decimals
 * (same precision as numeric(5,2) in the schema), handled as integer
 * hundredths so no floating-point drift can creep into payouts.
 */

export type TierMode = 'marginal' | 'tier_reached';
export type TierPeriod = 'monthly' | 'quarterly' | 'yearly';
export type OverrideType = 'rate_percent' | 'flat_cents' | 'excluded';
export type StatementStatus = 'draft' | 'pending_approval' | 'approved' | 'paid' | 'void';
export type StatementAction = 'submit' | 'approve' | 'return' | 'void';

export interface CommissionTier {
  min_cents: number;
  rate_percent: number;
}

export interface TierSegment {
  min_cents: number;
  rate_percent: number;
  amount_cents: number;
  commission_cents: number;
}

export interface TierResult {
  commissionCents: number;
  effectiveRatePercent: number;
  segments: TierSegment[];
}

export const MAX_TIERS = 12;
export const MAX_RATE_PERCENT = 100;
const RATE_SCALE = 100; // rate hundredths per 1%
const DIVISOR = 100 * RATE_SCALE; // cents * hundredths -> cents

/** Rate (percent, <=2 decimals) -> integer hundredths of a percent. */
function toHundredths(ratePercent: number): number {
  return Math.round(ratePercent * RATE_SCALE);
}

/** Round-half-up integer division for non-negative numerators. */
function roundDiv(numerator: number): number {
  return Math.floor((numerator + DIVISOR / 2) / DIVISOR);
}

export function sortTiers(tiers: CommissionTier[]): CommissionTier[] {
  return [...tiers].sort((a, b) => a.min_cents - b.min_cents);
}

/** Returns a human-readable problem, or null when the tier ladder is valid. */
export function validateTiers(tiers: CommissionTier[]): string | null {
  if (tiers.length === 0) return 'Add at least one tier.';
  if (tiers.length > MAX_TIERS) return `A plan can have at most ${MAX_TIERS} tiers.`;
  const sorted = sortTiers(tiers);
  if (sorted[0].min_cents !== 0) return 'The first tier must start at $0.';
  for (let i = 0; i < sorted.length; i += 1) {
    const t = sorted[i];
    if (!Number.isInteger(t.min_cents) || t.min_cents < 0) return 'Tier thresholds must be whole cents of $0 or more.';
    if (!Number.isFinite(t.rate_percent) || t.rate_percent < 0 || t.rate_percent > MAX_RATE_PERCENT) {
      return `Rates must be between 0% and ${MAX_RATE_PERCENT}%.`;
    }
    if (Math.abs(t.rate_percent * RATE_SCALE - Math.round(t.rate_percent * RATE_SCALE)) > 1e-6) {
      return 'Rates support at most 2 decimal places.';
    }
    if (i > 0 && t.min_cents === sorted[i - 1].min_cents) return 'Two tiers cannot start at the same amount.';
  }
  return null;
}

/**
 * Commission on one job.
 *
 * - marginal: every dollar earns the rate of the tier it falls in, like tax
 *   brackets. `cumulativeBeforeCents` is the employee's already-earned volume
 *   in the current tier period, so a job can straddle two tiers.
 * - tier_reached: the whole job earns the rate of the tier that the
 *   employee's period volume reaches AFTER this job (no retroactive true-up of
 *   earlier jobs).
 */
export function calculateTieredCommission(params: {
  basisCents: number;
  cumulativeBeforeCents: number;
  tiers: CommissionTier[];
  mode: TierMode;
}): TierResult {
  const { basisCents, tiers, mode } = params;
  const cumulativeBefore = Math.max(0, params.cumulativeBeforeCents);
  const empty: TierResult = { commissionCents: 0, effectiveRatePercent: 0, segments: [] };
  if (basisCents <= 0 || tiers.length === 0) return empty;

  const sorted = sortTiers(tiers);
  const after = cumulativeBefore + basisCents;

  if (mode === 'tier_reached') {
    let reached = sorted[0];
    for (const t of sorted) if (t.min_cents <= after) reached = t;
    const commission = roundDiv(basisCents * toHundredths(reached.rate_percent));
    return {
      commissionCents: commission,
      effectiveRatePercent: reached.rate_percent,
      segments: [{ min_cents: reached.min_cents, rate_percent: reached.rate_percent, amount_cents: basisCents, commission_cents: commission }],
    };
  }

  let numerator = 0;
  const segments: TierSegment[] = [];
  sorted.forEach((t, i) => {
    const hi = i + 1 < sorted.length ? sorted[i + 1].min_cents : Number.MAX_SAFE_INTEGER;
    const overlap = Math.max(0, Math.min(after, hi) - Math.max(cumulativeBefore, t.min_cents));
    if (overlap <= 0) return;
    const part = overlap * toHundredths(t.rate_percent);
    numerator += part;
    segments.push({ min_cents: t.min_cents, rate_percent: t.rate_percent, amount_cents: overlap, commission_cents: roundDiv(part) });
  });
  const commissionCents = roundDiv(numerator);
  return {
    commissionCents,
    effectiveRatePercent: Math.min(999.99, Math.round((commissionCents * 10000) / basisCents) / 100),
    segments,
  };
}

export interface ResolvedCommission {
  source: 'override_rate' | 'override_flat' | 'plan' | 'employee_rate' | 'excluded' | 'no_rule';
  commissionCents: number;
  ratePercent: number;
}

/**
 * Rule precedence (identical to the SQL generator):
 * job override -> employee's plan -> account default plan -> employee flat rate.
 */
export function resolveCommission(params: {
  basisCents: number;
  cumulativeBeforeCents: number;
  override?: { type: OverrideType; ratePercent?: number | null; flatCents?: number | null } | null;
  plan?: { mode: TierMode; tiers: CommissionTier[] } | null;
  employeeRatePercent?: number | null;
}): ResolvedCommission {
  const { basisCents, override, plan } = params;
  if (override) {
    if (override.type === 'excluded') return { source: 'excluded', commissionCents: 0, ratePercent: 0 };
    if (override.type === 'rate_percent') {
      const rate = override.ratePercent ?? 0;
      return { source: 'override_rate', commissionCents: roundDiv(basisCents * toHundredths(rate)), ratePercent: rate };
    }
    const flat = override.flatCents ?? 0;
    const rate = basisCents > 0 ? Math.min(999.99, Math.round((flat * 10000) / basisCents) / 100) : 0;
    return { source: 'override_flat', commissionCents: flat, ratePercent: rate };
  }
  if (plan && plan.tiers.length > 0) {
    const r = calculateTieredCommission({ basisCents, cumulativeBeforeCents: params.cumulativeBeforeCents, tiers: plan.tiers, mode: plan.mode });
    return { source: 'plan', commissionCents: r.commissionCents, ratePercent: r.effectiveRatePercent };
  }
  const flatRate = params.employeeRatePercent ?? 0;
  if (flatRate > 0) {
    return { source: 'employee_rate', commissionCents: roundDiv(basisCents * toHundredths(flatRate)), ratePercent: flatRate };
  }
  return { source: 'no_rule', commissionCents: 0, ratePercent: 0 };
}

/** First day of the tier period containing `isoDate` (YYYY-MM-DD, UTC). */
export function periodStart(isoDate: string, period: TierPeriod): string {
  const [y, m] = isoDate.split('-').map(Number);
  const month = period === 'monthly' ? m : period === 'quarterly' ? Math.floor((m - 1) / 3) * 3 + 1 : 1;
  return `${String(y).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`;
}

/** "12.34" / "$1,200.5" -> integer cents, or null when not a valid non-negative amount. */
export function dollarsToCents(input: string): number | null {
  const cleaned = input.replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, frac = ''] = cleaned.split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}

/** "7.5" -> 7.5, or null unless 0-100 with <=2 decimals. */
export function parseRatePercent(input: string): number | null {
  const cleaned = input.replace(/[%\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return n >= 0 && n <= MAX_RATE_PERCENT ? n : null;
}

/** Which lifecycle actions are legal from each statement status. */
export const STATEMENT_ACTIONS: Record<StatementStatus, StatementAction[]> = {
  draft: ['submit', 'void'],
  pending_approval: ['approve', 'return', 'void'],
  approved: ['void'],
  paid: [],
  void: [],
};

export function canTransition(status: StatementStatus, action: StatementAction): boolean {
  return STATEMENT_ACTIONS[status].includes(action);
}

export interface PayrollExportInput {
  id: string;
  employee_name: string;
  period_start: string;
  period_end: string;
  earned_cents: number;
  adjustment_cents: number;
  net_cents: number;
  status: StatementStatus;
}

const centsToDecimal = (c: number) => (c / 100).toFixed(2);

/** Flat rows for the payroll CSV (decimal dollars, one row per statement). */
export function buildPayrollExportRows(statements: PayrollExportInput[]) {
  return statements.map((s) => ({
    statement_id: s.id,
    employee: s.employee_name,
    period_start: s.period_start,
    period_end: s.period_end,
    commission_earned: centsToDecimal(s.earned_cents),
    adjustments: centsToDecimal(s.adjustment_cents),
    net_commission: centsToDecimal(s.net_cents),
    status: s.status,
  }));
}

export type GenerationCounts = Partial<Record<'created' | 'exists' | 'not_eligible' | 'no_employee' | 'no_rule' | 'excluded', number>>;

/** One-line toast/summary for generate_commission_records() output. */
export function summarizeGeneration(counts: GenerationCounts): string {
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const parts: string[] = [];
  const created = counts.created ?? 0;
  parts.push(created > 0 ? `Created ${plural(created, 'commission')}` : 'No new commissions');
  if (counts.no_rule) parts.push(`${plural(counts.no_rule, 'job')} skipped: technician has no commission rule`);
  if (counts.no_employee) parts.push(`${plural(counts.no_employee, 'job')} skipped: technician is not linked to an employee`);
  if (counts.excluded) parts.push(`${counts.excluded} excluded by override`);
  return `${parts[0]}${parts.length > 1 ? ` — ${parts.slice(1).join('; ')}` : ''}.`;
}
