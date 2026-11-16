/**
 * Fairness audit math — pure functions shared by scripts/fairness/audit.mjs and the staff page.
 *
 * Constraints (on purpose):
 *  - No imports and erasable TypeScript only (no enums / namespaces / parameter properties), so the
 *    same file loads in Deno, Vite/Vitest and Node (`--experimental-strip-types`).
 *  - Works on pre-aggregated CELLS (counts and sums per group), never on individual calls. The SQL
 *    function staff_fairness_overview() produces the cells, so no phone number, name or transcript
 *    ever reaches this code.
 *  - Only three stratifiers are allowed: detected language, region (country calling code of the
 *    caller's number) and customer type. Protected attributes are NEVER inferred or accepted.
 *
 * What the report means: a flagged gap is a prompt for human review. It is not a finding of
 * unfairness, and "no flag" is not proof of fairness (see docs/ai-governance/fairness-audit.md).
 */

export const DIMENSIONS = ['language', 'region', 'customer_type'] as const;
export type Dimension = (typeof DIMENSIONS)[number];

/** Attributes this audit must never use, infer or proxy. Checked by assertAllowedDimension(). */
export const FORBIDDEN_DIMENSIONS: readonly string[] = [
  'race', 'ethnicity', 'color', 'religion', 'gender', 'sex', 'sexual_orientation', 'gender_identity',
  'age', 'disability', 'national_origin', 'nationality', 'caste', 'marital_status', 'pregnancy',
  'health', 'political', 'union', 'immigration_status', 'name', 'accent', 'voice',
];

export function assertAllowedDimension(name: string): asserts name is Dimension {
  const n = String(name).trim().toLowerCase();
  const tokens = n.split(/[^a-z0-9]+/).filter(Boolean);
  if (FORBIDDEN_DIMENSIONS.some((f) => n === f || tokens.includes(f))) {
    throw new Error(`Dimension "${name}" is a protected or inferred attribute and is not allowed in the fairness audit.`);
  }
  if (!(DIMENSIONS as readonly string[]).includes(n)) {
    throw new Error(`Unknown dimension "${name}". Allowed: ${DIMENSIONS.join(', ')}.`);
  }
}

/** One aggregated group. `reviewed` = calls with a successful AI quality review and a score. */
export interface Cell {
  dimension: string;
  group: string;
  calls: number;
  reviewed: number;
  accounts: number;
  score_sum: number;
  score_sumsq: number;
  low_score: number;
  missed_booking: number;
  critical: number;
}

export interface AuditOptions {
  /** Minimum reviewed calls in the group AND in the comparison population. */
  minReviewed: number;
  /** Minimum distinct accounts (tenants) behind a group, so one tenant can never dominate a cell. */
  minAccounts: number;
  /** Family-wise error rate; Bonferroni-adjusted over every comparison actually tested. */
  alpha: number;
  /** Smallest gap worth a human's attention: mean score points. */
  minMeanGap: number;
  /** Smallest gap worth a human's attention: rate difference (0.05 = 5 percentage points). */
  minRateGap: number;
}

export const DEFAULT_OPTIONS: AuditOptions = {
  minReviewed: 30,
  minAccounts: 3,
  alpha: 0.05,
  minMeanGap: 5,
  minRateGap: 0.05,
};

export type MetricKey = 'mean_score' | 'low_score_rate' | 'missed_booking_rate' | 'critical_finding_rate' | 'review_coverage';

export const METRICS: ReadonlyArray<{ key: MetricKey; label: string; kind: 'mean' | 'rate'; higherIsBetter: boolean }> = [
  { key: 'mean_score', label: 'Mean QA score (0-100)', kind: 'mean', higherIsBetter: true },
  { key: 'low_score_rate', label: 'Low-score rate', kind: 'rate', higherIsBetter: false },
  { key: 'missed_booking_rate', label: 'Missed-booking finding rate', kind: 'rate', higherIsBetter: false },
  { key: 'critical_finding_rate', label: 'Critical finding rate', kind: 'rate', higherIsBetter: false },
  { key: 'review_coverage', label: 'Review coverage (calls successfully scored)', kind: 'rate', higherIsBetter: true },
];

export type GapStatus = 'gap_adverse' | 'gap_favorable' | 'no_material_gap';

export interface MetricResult {
  key: MetricKey;
  label: string;
  value: number;
  rest_value: number;
  gap: number;
  ci_low: number;
  ci_high: number;
  status: GapStatus;
}

export interface GroupResult {
  group: string;
  /** Group is a "data missing" bucket (undetected language, unknown region, unlinked customer). */
  missing_data: boolean;
  suppressed: boolean;
  suppression_reason: string | null;
  /** Counts are null when suppressed, so a small cell can never leak through a report. */
  calls: number | null;
  reviewed: number | null;
  accounts: number | null;
  metrics: MetricResult[];
}

export interface DimensionResult {
  dimension: Dimension;
  total_calls: number;
  total_reviewed: number;
  groups: GroupResult[];
}

export interface AuditReport {
  options: AuditOptions;
  comparisons_tested: number;
  z_critical: number;
  dimensions: DimensionResult[];
  summary: { groups_total: number; groups_evaluated: number; groups_suppressed: number; adverse_gaps: number; favorable_gaps: number };
  caveats: string[];
}

export const CAVEATS: readonly string[] = [
  'A flagged gap is a prompt for human review, not a finding of unfairness. No flag is not proof of fairness.',
  'Groups are compared with all other calls, so differences in call mix (job type, time of day, tenant) can explain a gap. The audit does not adjust for them.',
  'Region is the country calling code of the caller\'s number. It is not the caller\'s location or origin, and it is never combined with other attributes.',
  'QA scores come from an AI reviewer. Any bias in the reviewer is part of what is measured and cannot be separated from the calls themselves.',
  'Groups below the minimum sample or minimum account count are suppressed and reported without counts.',
  'Statistics assume independent calls; repeat callers and busy tenants make the true uncertainty larger than shown.',
];

// ---------------------------------------------------------------- numeric helpers

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Standard normal CDF (Abramowitz & Stegun 7.1.26 erf approximation, |error| < 1.5e-7). */
export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  const erf = 1 - poly * Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/** Two-sided critical z for a given alpha, by bisection on normalCdf. */
export function zTwoSided(alpha: number): number {
  const a = Math.min(Math.max(alpha, 1e-12), 0.999);
  const target = 1 - a / 2;
  let lo = 0;
  let hi = 10;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (normalCdf(mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Wilson score interval for a proportion. */
export function wilson(successes: number, n: number, z: number): { p: number; low: number; high: number } {
  if (n <= 0) return { p: 0, low: 0, high: 0 };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { p, low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

/** Newcombe hybrid-score interval for p1 - p2. */
export function newcombeDiff(x1: number, n1: number, x2: number, n2: number, z: number): { gap: number; low: number; high: number } {
  const a = wilson(x1, n1, z);
  const b = wilson(x2, n2, z);
  const gap = a.p - b.p;
  return {
    gap,
    low: gap - Math.sqrt((a.p - a.low) ** 2 + (b.high - b.p) ** 2),
    high: gap + Math.sqrt((a.high - a.p) ** 2 + (b.p - b.low) ** 2),
  };
}

/** Welch interval for mean1 - mean2 from sums and sums of squares. */
export function welchDiff(
  s1: number, q1: number, n1: number, s2: number, q2: number, n2: number, z: number,
): { gap: number; low: number; high: number; m1: number; m2: number } {
  const m1 = n1 > 0 ? s1 / n1 : 0;
  const m2 = n2 > 0 ? s2 / n2 : 0;
  const v1 = n1 > 1 ? Math.max(0, (q1 - (s1 * s1) / n1) / (n1 - 1)) : 0;
  const v2 = n2 > 1 ? Math.max(0, (q2 - (s2 * s2) / n2) / (n2 - 1)) : 0;
  const se = Math.sqrt(v1 / Math.max(n1, 1) + v2 / Math.max(n2, 1));
  const gap = m1 - m2;
  return { gap, low: gap - z * se, high: gap + z * se, m1, m2 };
}

// ---------------------------------------------------------------- region mapping

/**
 * Country calling codes -> coarse label. Longest prefix wins. Not exhaustive: anything unmapped is
 * reported as "other (unmapped code)". +1 is the whole North American Numbering Plan (US, Canada and
 * several Caribbean countries), so it is deliberately NOT labelled as a country.
 */
export const CALLING_CODES: Readonly<Record<string, string>> = {
  '1': '+1 North America (NANP)', '7': '+7 RU/KZ', '20': '+20 EG', '27': '+27 ZA', '30': '+30 GR', '31': '+31 NL', '32': '+32 BE',
  '33': '+33 FR', '34': '+34 ES', '36': '+36 HU', '39': '+39 IT', '40': '+40 RO', '41': '+41 CH', '43': '+43 AT', '44': '+44 GB',
  '45': '+45 DK', '46': '+46 SE', '47': '+47 NO', '48': '+48 PL', '49': '+49 DE', '51': '+51 PE', '52': '+52 MX', '53': '+53 CU',
  '54': '+54 AR', '55': '+55 BR', '56': '+56 CL', '57': '+57 CO', '58': '+58 VE', '60': '+60 MY', '61': '+61 AU', '62': '+62 ID',
  '63': '+63 PH', '64': '+64 NZ', '65': '+65 SG', '66': '+66 TH', '81': '+81 JP', '82': '+82 KR', '84': '+84 VN', '86': '+86 CN',
  '90': '+90 TR', '91': '+91 IN', '92': '+92 PK', '93': '+93 AF', '94': '+94 LK', '95': '+95 MM', '98': '+98 IR', '212': '+212 MA',
  '213': '+213 DZ', '216': '+216 TN', '234': '+234 NG', '254': '+254 KE', '351': '+351 PT', '353': '+353 IE', '358': '+358 FI',
  '380': '+380 UA', '420': '+420 CZ', '852': '+852 HK', '880': '+880 BD', '886': '+886 TW', '961': '+961 LB', '962': '+962 JO',
  '966': '+966 SA', '971': '+971 AE', '972': '+972 IL',
};

export const REGION_UNKNOWN = 'unknown (no E.164 number)';
export const REGION_OTHER = 'other (unmapped code)';

/** `prefix` = up to the first 3 digits after "+", or "unknown" when the number was not E.164. */
export function regionFromPrefix(prefix: string): string {
  const p = String(prefix ?? '').replace(/\D/g, '');
  if (!p) return REGION_UNKNOWN;
  for (const len of [3, 2, 1]) {
    const label = CALLING_CODES[p.slice(0, len)];
    if (label) return label;
  }
  return REGION_OTHER;
}

export function normalizeLanguage(raw: unknown): string {
  const full = String(raw ?? '').trim().toLowerCase().replace(/_/g, '-').split('-')[0];
  if (full === 'undetected') return full; // the SQL bucket label must survive the 8-char cap below
  return full.slice(0, 8) || 'undetected';
}

export function normalizeCustomerType(raw: unknown): string {
  const s = String(raw ?? '').trim().toLowerCase();
  return s === 'residential' || s === 'commercial' ? s : 'unlinked';
}

const MISSING_GROUPS: Record<Dimension, readonly string[]> = {
  language: ['undetected'],
  region: [REGION_UNKNOWN, REGION_OTHER],
  customer_type: ['unlinked'],
};

// ---------------------------------------------------------------- aggregation

function emptyCell(dimension: string, group: string): Cell {
  return { dimension, group, calls: 0, reviewed: 0, accounts: 0, score_sum: 0, score_sumsq: 0, low_score: 0, missed_booking: 0, critical: 0 };
}

/**
 * Normalises raw RPC cells: coerces numbers, maps region prefixes to labels and merges cells that
 * land in the same group. `accounts` of merged cells is the MAX (a lower bound of the true distinct
 * count), so the minimum-account rule can only get stricter, never looser.
 */
export function normalizeCells(raw: ReadonlyArray<Partial<Record<keyof Cell, unknown>>>): Cell[] {
  const merged = new Map<string, Cell>();
  for (const r of raw ?? []) {
    const dimension = String(r.dimension ?? '').trim().toLowerCase();
    assertAllowedDimension(dimension);
    const rawGroup = String(r.group ?? '');
    const group =
      dimension === 'region' ? regionFromPrefix(rawGroup)
      : dimension === 'language' ? normalizeLanguage(rawGroup)
      : normalizeCustomerType(rawGroup);
    const key = `${dimension}\u0000${group}`;
    const cell = merged.get(key) ?? emptyCell(dimension, group);
    cell.calls += num(r.calls);
    cell.reviewed += num(r.reviewed);
    cell.accounts = Math.max(cell.accounts, num(r.accounts));
    cell.score_sum += num(r.score_sum);
    cell.score_sumsq += num(r.score_sumsq);
    cell.low_score += num(r.low_score);
    cell.missed_booking += num(r.missed_booking);
    cell.critical += num(r.critical);
    merged.set(key, cell);
  }
  return [...merged.values()];
}

// ---------------------------------------------------------------- evaluation

function metricInputs(c: Cell, key: MetricKey): { x: number; n: number } {
  switch (key) {
    case 'low_score_rate': return { x: c.low_score, n: c.reviewed };
    case 'missed_booking_rate': return { x: c.missed_booking, n: c.reviewed };
    case 'critical_finding_rate': return { x: c.critical, n: c.reviewed };
    case 'review_coverage': return { x: c.reviewed, n: c.calls };
    default: return { x: 0, n: c.reviewed };
  }
}

function subtract(total: Cell, part: Cell): Cell {
  return {
    dimension: total.dimension, group: `not ${part.group}`,
    calls: total.calls - part.calls, reviewed: total.reviewed - part.reviewed, accounts: total.accounts,
    score_sum: total.score_sum - part.score_sum, score_sumsq: total.score_sumsq - part.score_sumsq,
    low_score: total.low_score - part.low_score, missed_booking: total.missed_booking - part.missed_booking,
    critical: total.critical - part.critical,
  };
}

function suppressionReason(c: Cell, rest: Cell, o: AuditOptions): string | null {
  if (c.reviewed < o.minReviewed) return `fewer than ${o.minReviewed} reviewed calls`;
  if (c.accounts < o.minAccounts) return `fewer than ${o.minAccounts} accounts`;
  if (rest.reviewed < o.minReviewed) return 'comparison population too small';
  return null;
}

export function evaluate(rawCells: ReadonlyArray<Partial<Record<keyof Cell, unknown>>>, overrides: Partial<AuditOptions> = {}): AuditReport {
  const o: AuditOptions = { ...DEFAULT_OPTIONS, ...overrides };
  const cells = normalizeCells(rawCells);

  // Pass 1: decide which (group, metric) pairs are tested, to size the Bonferroni correction.
  const byDim = new Map<Dimension, Cell[]>();
  for (const d of DIMENSIONS) byDim.set(d, cells.filter((c) => c.dimension === d));
  const totals = new Map<Dimension, Cell>();
  for (const d of DIMENSIONS) {
    const t = emptyCell(d, 'all');
    for (const c of byDim.get(d) ?? []) {
      t.calls += c.calls; t.reviewed += c.reviewed; t.accounts = Math.max(t.accounts, c.accounts);
      t.score_sum += c.score_sum; t.score_sumsq += c.score_sumsq; t.low_score += c.low_score;
      t.missed_booking += c.missed_booking; t.critical += c.critical;
    }
    totals.set(d, t);
  }
  let tested = 0;
  for (const d of DIMENSIONS) {
    const t = totals.get(d)!;
    for (const c of byDim.get(d) ?? []) {
      if (suppressionReason(c, subtract(t, c), o) === null) tested += METRICS.length;
    }
  }
  const z = zTwoSided(o.alpha / Math.max(tested, 1));

  // Pass 2: compute results.
  let evaluated = 0, suppressed = 0, adverse = 0, favorable = 0, groupsTotal = 0;
  const dimensions: DimensionResult[] = DIMENSIONS.map((d) => {
    const t = totals.get(d)!;
    const groups: GroupResult[] = (byDim.get(d) ?? [])
      .slice()
      .sort((a, b) => b.calls - a.calls || a.group.localeCompare(b.group))
      .map((c) => {
        groupsTotal++;
        const rest = subtract(t, c);
        const reason = suppressionReason(c, rest, o);
        const missing_data = MISSING_GROUPS[d].includes(c.group);
        if (reason) {
          suppressed++;
          return { group: c.group, missing_data, suppressed: true, suppression_reason: reason, calls: null, reviewed: null, accounts: null, metrics: [] };
        }
        evaluated++;
        const metrics: MetricResult[] = METRICS.map((m) => {
          let value: number, restValue: number, gap: number, low: number, high: number;
          if (m.kind === 'mean') {
            const w = welchDiff(c.score_sum, c.score_sumsq, c.reviewed, rest.score_sum, rest.score_sumsq, rest.reviewed, z);
            value = w.m1; restValue = w.m2; gap = w.gap; low = w.low; high = w.high;
          } else {
            const a = metricInputs(c, m.key);
            const b = metricInputs(rest, m.key);
            const nd = newcombeDiff(a.x, a.n, b.x, b.n, z);
            value = a.n > 0 ? a.x / a.n : 0; restValue = b.n > 0 ? b.x / b.n : 0;
            gap = nd.gap; low = nd.low; high = nd.high;
          }
          const threshold = m.kind === 'mean' ? o.minMeanGap : o.minRateGap;
          const significant = low > 0 || high < 0;
          const material = Math.abs(gap) >= threshold;
          let status: GapStatus = 'no_material_gap';
          if (significant && material) {
            const worse = m.higherIsBetter ? gap < 0 : gap > 0;
            status = worse ? 'gap_adverse' : 'gap_favorable';
            if (worse) adverse++; else favorable++;
          }
          return { key: m.key, label: m.label, value, rest_value: restValue, gap, ci_low: low, ci_high: high, status };
        });
        return { group: c.group, missing_data, suppressed: false, suppression_reason: null, calls: c.calls, reviewed: c.reviewed, accounts: c.accounts, metrics };
      });
    return { dimension: d, total_calls: t.calls, total_reviewed: t.reviewed, groups };
  });

  return {
    options: o,
    comparisons_tested: tested,
    z_critical: z,
    dimensions,
    summary: { groups_total: groupsTotal, groups_evaluated: evaluated, groups_suppressed: suppressed, adverse_gaps: adverse, favorable_gaps: favorable },
    caveats: [...CAVEATS],
  };
}
