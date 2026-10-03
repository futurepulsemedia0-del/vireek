/**
 * Vireek Outcome Benchmark Network - pure logic (no I/O).
 *
 * Data comes from get_outcome_benchmark() (see
 * supabase/migrations/20270301000000_outcome_benchmark_network.sql): the
 * caller's own live numbers next to k-anonymous (>= 5 businesses) peer
 * percentiles. Nothing in this file touches the network.
 */

export type OutcomeMetric = 'first_time_fix_rate' | 'reservice_rate' | 'median_response_minutes';
export type OutcomeUnit = 'percent' | 'minutes';
export type OutcomeDirection = 'higher_is_better' | 'lower_is_better';
export type OutcomeScope = 'region' | 'industry' | 'platform' | 'none';
export type OutcomeBucket = 'top10' | 'top25' | 'top50' | 'bottom50' | 'bottom25';
export type OutcomeTarget = 'median' | 'top_quartile';

export interface OutcomeBenchmarkRow {
  metric: OutcomeMetric;
  unit: OutcomeUnit;
  direction: OutcomeDirection;
  my_value: number;
  my_sample: number;
  scope: OutcomeScope;
  industry: string;
  region_key: string;
  contributor_count: number | null;
  p10: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  p90: number | null;
  percentile_bucket: OutcomeBucket | null;
}

export interface OutcomeDriver {
  service_type: string;
  job_count: number;
  reworked_count: number;
  ftf_rate: number;
}

export interface OutcomeAdviceChange {
  title: string;
  why: string;
  how: string;
  metric: OutcomeMetric | null;
  lever_id: string | null;
}

export interface OutcomeAdvice {
  summary: string;
  changes: OutcomeAdviceChange[];
}

export interface OutcomeAdviceResponse {
  advice: OutcomeAdvice | null;
  cached: boolean;
  generated_at: string | null;
  reason: 'no_benchmark' | 'ai_unavailable' | 'not_generated' | null;
}

// ============================================================
// METADATA
// ============================================================

export const METRIC_ORDER: OutcomeMetric[] = ['first_time_fix_rate', 'median_response_minutes', 'reservice_rate'];

export const METRIC_META: Record<OutcomeMetric, { label: string; description: string }> = {
  first_time_fix_rate: {
    label: 'First-time fix rate',
    description: 'Share of completed jobs that did not need a return visit within 14 days.',
  },
  median_response_minutes: {
    label: 'Median response time',
    description: 'Typical time from a job being created to a technician being dispatched or on the way.',
  },
  reservice_rate: {
    label: 'Reservice rate',
    description: 'Share of all jobs that were repeat visits for a problem already worked on.',
  },
};

export const BUCKET_LABELS: Record<OutcomeBucket, string> = {
  top10: 'Top 10%',
  top25: 'Top 25%',
  top50: 'Above median',
  bottom50: 'Below median',
  bottom25: 'Bottom 25%',
};

export interface Lever {
  id: string;
  title: string;
  description: string;
  href: string;
  metrics: OutcomeMetric[];
}

/** Keep ids in sync with ALLOWED_LEVERS in supabase/functions/_shared/ai-core/outcomeBenchmarkNarrative.ts */
export const LEVERS: Lever[] = [
  { id: 'ftf_autopilot', title: 'First-Time-Fix Autopilot', description: 'Predicts fix probability before dispatch and holds or corrects risky jobs.', href: '/dashboard/first-time-fix', metrics: ['first_time_fix_rate', 'reservice_rate'] },
  { id: 'apprenticeship', title: 'Apprenticeship Engine', description: 'Closes the exact skill gaps behind failed fixes.', href: '/dashboard/apprenticeship', metrics: ['first_time_fix_rate', 'reservice_rate'] },
  { id: 'callback_root_cause', title: 'Callback root-cause engine', description: 'Finds why repeat visits happen and how to prevent them.', href: '/dashboard/callback-root-cause', metrics: ['reservice_rate', 'first_time_fix_rate'] },
  { id: 'job_quality_gate', title: 'Job quality gate', description: 'Blocks sign-off until the work is verified.', href: '/dashboard/job-quality-gate', metrics: ['reservice_rate'] },
  { id: 'diagnosis_copilot', title: 'Diagnosis Copilot', description: 'Improves diagnosis confidence before the repair starts.', href: '/dashboard/diagnosis-copilot', metrics: ['first_time_fix_rate'] },
  { id: 'dispatch_board', title: 'Dispatch board', description: 'Assign and track jobs faster.', href: '/dashboard/dispatch', metrics: ['median_response_minutes'] },
  { id: 'advanced_routing', title: 'Advanced routing', description: 'Routes jobs to the nearest qualified technician.', href: '/dashboard/routing', metrics: ['median_response_minutes'] },
  { id: 'on_call', title: 'On-call schedule', description: 'Guarantees someone is always assigned to respond.', href: '/dashboard/on-call', metrics: ['median_response_minutes'] },
  { id: 'technician_capacity', title: 'Technician capacity', description: 'Spots overload before it slows response.', href: '/dashboard/technician-capacity', metrics: ['median_response_minutes'] },
];

export function getLever(id: string | null | undefined): Lever | null {
  return LEVERS.find((l) => l.id === id) ?? null;
}

export function leversFor(metric: OutcomeMetric): Lever[] {
  return LEVERS.filter((l) => l.metrics.includes(metric)).sort(
    (a, b) => Number(b.metrics[0] === metric) - Number(a.metrics[0] === metric),
  );
}

// ============================================================
// FORMATTING
// ============================================================

export function formatDuration(minutes: number): string {
  if (!Number.isFinite(minutes)) return '-';
  if (minutes < 1) return '<1m';
  const total = Math.round(minutes);
  if (total < 60) return `${total}m`;
  if (total < 1440) {
    const h = Math.floor(total / 60);
    const m = total % 60;
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
  }
  const d = Math.floor(total / 1440);
  const h = Math.round((total % 1440) / 60);
  return h === 0 ? `${d}d` : `${d}d ${h}h`;
}

export function formatOutcomeValue(value: number, unit: OutcomeUnit): string {
  if (!Number.isFinite(value)) return '-';
  if (unit === 'minutes') return formatDuration(value);
  return `${value.toFixed(value < 10 ? 1 : 0)}%`;
}

export function formatGap(gap: number, unit: OutcomeUnit): string {
  return unit === 'minutes' ? formatDuration(gap) : `${gap.toFixed(gap < 10 ? 1 : 0)} pts`;
}

export function prettyIndustry(slug: string): string {
  const s = slug.replace(/[-_]+/g, ' ').trim();
  if (!s || s === 'all') return 'service';
  if (s.length <= 4) return s.toUpperCase();
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Rounded-down public count so exact cohort sizes are never shown. */
export function contributorLabel(n: number | null): string {
  if (n === null || n < 5) return '5+';
  if (n < 10) return '5+';
  return `${Math.floor(n / 5) * 5}+`;
}

export function scopeLabel(row: OutcomeBenchmarkRow): string {
  const count = contributorLabel(row.contributor_count);
  if (row.scope === 'region') return `${count} ${prettyIndustry(row.industry)} businesses in ${row.region_key.toUpperCase()}`;
  if (row.scope === 'industry') return `${count} ${prettyIndustry(row.industry)} businesses nationwide`;
  if (row.scope === 'platform') return `${count} businesses across all trades`;
  return 'Not enough peers yet';
}

// ============================================================
// ANALYSIS
// ============================================================

export function topQuartileValue(row: OutcomeBenchmarkRow): number | null {
  return row.direction === 'higher_is_better' ? row.p75 : row.p25;
}

/** Improvement still needed to reach the target (0 when already there). */
export function gapToTarget(row: OutcomeBenchmarkRow, target: OutcomeTarget): number {
  const goal = target === 'median' ? row.p50 : topQuartileValue(row);
  if (goal === null) return 0;
  const gap = row.direction === 'higher_is_better' ? goal - row.my_value : row.my_value - goal;
  return Math.max(0, gap);
}

/**
 * Approximate share of peers this business outperforms (5-95), interpolated
 * between the published percentile anchors. Intentionally coarse: callers
 * should render it with "~".
 */
export function outperformPct(row: OutcomeBenchmarkRow): number | null {
  const { p10, p25, p50, p75, p90 } = row;
  if (p10 === null || p25 === null || p50 === null || p75 === null || p90 === null) return null;
  const anchors: Array<[number, number]> = [[p10, 10], [p25, 25], [p50, 50], [p75, 75], [p90, 90]];
  const v = row.my_value;
  let q = 50;
  if (v <= anchors[0][0]) q = 5;
  else if (v >= anchors[4][0]) q = 95;
  else {
    for (let i = 0; i < anchors.length - 1; i += 1) {
      const [x0, q0] = anchors[i];
      const [x1, q1] = anchors[i + 1];
      if (v >= x0 && v <= x1) {
        q = x1 === x0 ? (q0 + q1) / 2 : q0 + ((v - x0) / (x1 - x0)) * (q1 - q0);
        break;
      }
    }
  }
  return Math.round(row.direction === 'higher_is_better' ? q : 100 - q);
}

export interface OutcomeAnalysis {
  comparable: OutcomeBenchmarkRow[];
  behind: Array<{ row: OutcomeBenchmarkRow; gap: number; relativeGap: number }>;
  strong: OutcomeBenchmarkRow[];
}

export function analyzeOutcomes(rows: OutcomeBenchmarkRow[]): OutcomeAnalysis {
  const order = (m: OutcomeMetric) => METRIC_ORDER.indexOf(m);
  const comparable = rows.filter((r) => r.scope !== 'none' && r.p50 !== null).sort((a, b) => order(a.metric) - order(b.metric));
  const behind = comparable
    .map((row) => {
      const gap = gapToTarget(row, 'median');
      return { row, gap, relativeGap: gap / Math.max(Math.abs(row.p50 ?? 0), 1e-9) };
    })
    .filter((x) => x.gap > 0)
    .sort((a, b) => b.relativeGap - a.relativeGap);
  const strong = comparable.filter((r) => r.percentile_bucket === 'top10' || r.percentile_bucket === 'top25');
  return { comparable, behind, strong };
}
