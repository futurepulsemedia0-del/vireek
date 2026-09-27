import { supabase } from '@/lib/supabase';
export { formatCents } from '@/lib/priceBook';

// ============================================================
// TYPES — mirror job_autopsy_candidates view + job_autopsy_reports table
// ============================================================

export type JobAutopsyCategory =
  | 'extra_travel'
  | 'misdiagnosis'
  | 'missing_part'
  | 'customer_delay'
  | 'technician_rework'
  | 'scope_change'
  | 'other';

export const ROOT_CAUSE_LABELS: Record<JobAutopsyCategory, string> = {
  extra_travel: 'Extra travel',
  misdiagnosis: 'Wrong initial diagnosis',
  missing_part: 'Missing part',
  customer_delay: 'Customer / scheduling delay',
  technician_rework: 'Technician rework',
  scope_change: 'Scope grew on site',
  other: 'Other',
};

export const ROOT_CAUSE_COLORS: Record<JobAutopsyCategory, string> = {
  extra_travel: '#6366f1',
  misdiagnosis: '#ef4444',
  missing_part: '#f59e0b',
  customer_delay: '#06b6d4',
  technician_rework: '#ec4899',
  scope_change: '#22c55e',
  other: '#94a3b8',
};

export interface JobAutopsyRootCause {
  category: JobAutopsyCategory;
  pct: number;
  evidence: string;
}

export interface JobAutopsyReport {
  id: string;
  job_id: string;
  expected_cost_cents: number;
  actual_cost_cents: number;
  variance_cents: number;
  variance_pct: number | null;
  root_causes: JobAutopsyRootCause[];
  ai_summary: string | null;
  counterfactual_summary: string | null;
  recommended_prevention_action: string | null;
  estimated_recoverable_cents: number;
  confidence: 'low' | 'medium' | 'high';
  reviewed: boolean;
  created_at: string;
}

export interface JobAutopsyCandidate {
  job_id: string;
  customer_name: string;
  service_type: string | null;
  completed_at: string | null;
  assigned_technician_id: string | null;
  technician_name: string | null;
  is_rework: boolean;
  duration_minutes: number;
  actual_cost_cents: number;
  expected_cost_cents: number;
  reschedule_count: number;
  schedule_shift_hours: number;
  parts_backordered_count: number;
}

export interface JobAutopsyCase extends JobAutopsyCandidate {
  report: JobAutopsyReport | null;
  variance_cents: number;
  variance_pct: number | null;
}

// ============================================================
// FETCH
// ============================================================

export async function fetchJobAutopsyCases(): Promise<JobAutopsyCase[]> {
  const [{ data: candidates, error: candErr }, { data: reports, error: repErr }] = await Promise.all([
    supabase
      .from('job_autopsy_candidates')
      .select(
        'job_id, customer_name, service_type, completed_at, assigned_technician_id, technician_name, is_rework, duration_minutes, actual_cost_cents, expected_cost_cents, reschedule_count, schedule_shift_hours, parts_backordered_count',
      )
      .order('completed_at', { ascending: false }),
    supabase.from('job_autopsy_reports').select('*'),
  ]);
  if (candErr) throw candErr;
  if (repErr) throw repErr;

  const reportMap = new Map((reports ?? []).map((r: JobAutopsyReport) => [r.job_id, r]));

  return (candidates ?? []).map((c: JobAutopsyCandidate) => {
    const report = reportMap.get(c.job_id) ?? null;
    const variance_cents = c.actual_cost_cents - c.expected_cost_cents;
    const variance_pct = c.expected_cost_cents > 0 ? Math.round((variance_cents / c.expected_cost_cents) * 1000) / 10 : null;
    return { ...c, report, variance_cents, variance_pct };
  });
}

export async function runJobAutopsy(jobId: string): Promise<JobAutopsyReport> {
  const { data, error } = await supabase.functions.invoke<{ report?: JobAutopsyReport; error?: string }>(
    'analyze-job-autopsy',
    { body: { job_id: jobId } },
  );
  if (error) throw error;
  if (!data?.report) throw new Error(data?.error ?? 'Autopsy failed.');
  return data.report;
}

export async function setReportReviewed(reportId: string, reviewed: boolean): Promise<void> {
  const { error } = await supabase.from('job_autopsy_reports').update({ reviewed }).eq('id', reportId);
  if (error) throw error;
}

// ============================================================
// CLIENT-SIDE PATTERN MINING (deterministic — same approach as
// computeRootCausePatterns in callbackRootCause.ts). This is how
// "Vireek learns how your company actually works" without inventing a
// statistic server-side: it only counts what the AI already grounded
// per job.
// ============================================================

export interface JobAutopsyPattern {
  category: JobAutopsyCategory;
  label: string;
  color: string;
  jobCount: number;
  totalVarianceCents: number;
  avgSharePct: number;
  topPreventionAction: string | null;
}

const MIN_JOBS_FOR_PATTERN = 2;

export function computeJobAutopsyPatterns(cases: JobAutopsyCase[]): JobAutopsyPattern[] {
  const byCategory = new Map<JobAutopsyCategory, { jobCount: number; totalVariance: number; shareSum: number; actions: string[] }>();

  for (const c of cases) {
    if (!c.report) continue;
    for (const rc of c.report.root_causes) {
      const entry = byCategory.get(rc.category) ?? { jobCount: 0, totalVariance: 0, shareSum: 0, actions: [] };
      entry.jobCount += 1;
      entry.totalVariance += Math.round((c.report.variance_cents * rc.pct) / 100);
      entry.shareSum += rc.pct;
      if (c.report.recommended_prevention_action) entry.actions.push(c.report.recommended_prevention_action);
      byCategory.set(rc.category, entry);
    }
  }

  const patterns: JobAutopsyPattern[] = [];
  for (const [category, e] of byCategory.entries()) {
    if (e.jobCount < MIN_JOBS_FOR_PATTERN) continue;
    const counts = new Map<string, number>();
    for (const a of e.actions) counts.set(a, (counts.get(a) ?? 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    patterns.push({
      category,
      label: ROOT_CAUSE_LABELS[category],
      color: ROOT_CAUSE_COLORS[category],
      jobCount: e.jobCount,
      totalVarianceCents: e.totalVariance,
      avgSharePct: Math.round(e.shareSum / e.jobCount),
      topPreventionAction: top ? top[0] : null,
    });
  }

  return patterns.sort((a, b) => b.totalVarianceCents - a.totalVarianceCents);
}

export function overallAutopsyStats(cases: JobAutopsyCase[]) {
  const analyzed = cases.filter((c): c is JobAutopsyCase & { report: JobAutopsyReport } => c.report !== null);
  const totalOverrunCents = analyzed.reduce((s, c) => s + Math.max(0, c.report.variance_cents), 0);
  const totalRecoverableCents = analyzed.reduce((s, c) => s + c.report.estimated_recoverable_cents, 0);
  return {
    analyzedCount: analyzed.length,
    pendingCount: cases.length - analyzed.length,
    totalOverrunCents,
    totalRecoverableCents,
  };
}
