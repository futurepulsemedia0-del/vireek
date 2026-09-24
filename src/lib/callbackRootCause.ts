import { supabase } from '@/lib/supabase';

// ============================================================
// TYPES
// ============================================================

export type RootCauseCategory =
  | 'misdiagnosis'
  | 'incomplete_repair'
  | 'defective_part'
  | 'wrong_part_installed'
  | 'installation_error'
  | 'missed_related_issue'
  | 'customer_misuse'
  | 'pre_existing_unrelated'
  | 'unknown';

export const ROOT_CAUSE_LABELS: Record<RootCauseCategory, string> = {
  misdiagnosis: 'Misdiagnosis',
  incomplete_repair: 'Incomplete repair',
  defective_part: 'Defective part',
  wrong_part_installed: 'Wrong part installed',
  installation_error: 'Installation error',
  missed_related_issue: 'Missed related issue',
  customer_misuse: 'Customer misuse',
  pre_existing_unrelated: 'Pre-existing / unrelated',
  unknown: 'Unknown',
};

export interface CallbackRootCauseAnalysis {
  id: string;
  callback_job_id: string;
  original_job_id: string;
  technician_id: string | null;
  equipment_id: string | null;
  part_id: string | null;
  service_type: string | null;
  root_cause_category: RootCauseCategory;
  confidence: number;
  ai_summary: string | null;
  recommended_prevention_action: string | null;
  status: 'open' | 'acknowledged' | 'resolved' | 'dismissed';
  created_at: string;
}

export interface CallbackCase {
  callback_job_id: string;
  original_job_id: string;
  customer_name: string;
  service_type: string | null;
  technician_id: string | null;
  technician_name: string | null;
  callback_completed_at: string | null;
  analysis: CallbackRootCauseAnalysis | null;
}

export type PatternType = 'technician' | 'part' | 'equipment_type' | 'job_type';

export interface RootCausePattern {
  patternKey: string;
  patternType: PatternType;
  label: string;
  category: RootCauseCategory;
  count: number;
  severity: 'low' | 'medium' | 'high';
  title: string;
  description: string;
  recommendedAction: string;
}

export interface PreventionWorkflow {
  id: string;
  pattern_key: string;
  pattern_type: PatternType;
  title: string;
  description: string;
  recommended_action: string;
  occurrence_count: number;
  severity: 'low' | 'medium' | 'high';
  status: 'open' | 'in_progress' | 'resolved' | 'dismissed';
  last_seen_at: string;
  created_at: string;
}

// ============================================================
// FETCH CALLBACK CASES
// ============================================================

export async function fetchCallbackCases(): Promise<CallbackCase[]> {
  const { data: callbackJobs, error } = await supabase
    .from('jobs')
    .select('id, rework_of_job_id, customer_name, service_type, assigned_technician_id, completed_at')
    .eq('is_rework', true)
    .not('rework_of_job_id', 'is', null)
    .order('completed_at', { ascending: false });
  if (error) throw error;
  if (!callbackJobs || callbackJobs.length === 0) return [];

  const techIds = Array.from(new Set(callbackJobs.map((j) => j.assigned_technician_id).filter(Boolean))) as string[];
  const jobIds = callbackJobs.map((j) => j.id);

  const [{ data: techs }, { data: analyses }] = await Promise.all([
    techIds.length
      ? supabase.from('team_members').select('id, member_name').in('id', techIds)
      : Promise.resolve({ data: [] as { id: string; member_name: string }[] }),
    supabase.from('callback_root_cause_analyses').select('*').in('callback_job_id', jobIds),
  ]);

  const techMap = new Map((techs ?? []).map((t: { id: string; member_name: string }) => [t.id, t.member_name]));
  const analysisMap = new Map((analyses ?? []).map((a: CallbackRootCauseAnalysis) => [a.callback_job_id, a]));

  return callbackJobs.map((j) => ({
    callback_job_id: j.id,
    original_job_id: j.rework_of_job_id as string,
    customer_name: j.customer_name,
    service_type: j.service_type,
    technician_id: j.assigned_technician_id,
    technician_name: j.assigned_technician_id ? techMap.get(j.assigned_technician_id) ?? null : null,
    callback_completed_at: j.completed_at,
    analysis: analysisMap.get(j.id) ?? null,
  }));
}

export async function analyzeCallback(callbackJobId: string): Promise<CallbackRootCauseAnalysis> {
  const { data, error } = await supabase.functions.invoke<{ analysis?: CallbackRootCauseAnalysis; error?: string }>(
    'analyze-callback-root-cause',
    { body: { callback_job_id: callbackJobId } },
  );
  if (error) throw error;
  if (!data?.analysis) throw new Error(data?.error ?? 'Analysis failed.');
  return data.analysis;
}

export async function setAnalysisStatus(
  analysisId: string,
  status: CallbackRootCauseAnalysis['status'],
): Promise<void> {
  const { error } = await supabase.from('callback_root_cause_analyses').update({ status }).eq('id', analysisId);
  if (error) throw error;
}

// ============================================================
// RULE-BASED PATTERN DETECTION (client-side, deterministic)
// ============================================================

const MIN_OCCURRENCES_FOR_PATTERN = 2;

function severityFor(count: number): 'low' | 'medium' | 'high' {
  if (count >= 5) return 'high';
  if (count >= 3) return 'medium';
  return 'low';
}

export function computeRootCausePatterns(
  cases: CallbackCase[],
): RootCausePattern[] {
  const patterns = new Map<string, { type: PatternType; label: string; category: RootCauseCategory; count: number }>();

  for (const c of cases) {
    const a = c.analysis;
    if (!a || a.status === 'dismissed') continue;

    if (a.technician_id && c.technician_name) {
      const key = `technician:${a.technician_id}:${a.root_cause_category}`;
      const existing = patterns.get(key);
      patterns.set(key, {
        type: 'technician',
        label: c.technician_name,
        category: a.root_cause_category,
        count: (existing?.count ?? 0) + 1,
      });
    }

    if (a.part_id) {
      const key = `part:${a.part_id}:${a.root_cause_category}`;
      const existing = patterns.get(key);
      patterns.set(key, {
        type: 'part',
        label: `Part ${a.part_id.slice(0, 8)}`,
        category: a.root_cause_category,
        count: (existing?.count ?? 0) + 1,
      });
    }

    if (c.service_type) {
      const key = `job_type:${c.service_type}:${a.root_cause_category}`;
      const existing = patterns.get(key);
      patterns.set(key, {
        type: 'job_type',
        label: c.service_type,
        category: a.root_cause_category,
        count: (existing?.count ?? 0) + 1,
      });
    }
  }

  const result: RootCausePattern[] = [];
  for (const [key, p] of patterns.entries()) {
    if (p.count < MIN_OCCURRENCES_FOR_PATTERN) continue;
    const categoryLabel = ROOT_CAUSE_LABELS[p.category];
    result.push({
      patternKey: key,
      patternType: p.type,
      label: p.label,
      category: p.category,
      count: p.count,
      severity: severityFor(p.count),
      title: `${p.label} — ${categoryLabel} (${p.count}×)`,
      description:
        p.type === 'technician'
          ? `${p.label} has ${p.count} callbacks categorized as "${categoryLabel}".`
          : p.type === 'part'
          ? `This part has been linked to ${p.count} callbacks categorized as "${categoryLabel}".`
          : `"${p.label}" jobs have ${p.count} callbacks categorized as "${categoryLabel}".`,
      recommendedAction:
        p.type === 'technician'
          ? `Pair ${p.label} with a senior tech on the next 2-3 "${p.label ? p.category : ''}"-type jobs, or schedule a refresher on ${categoryLabel.toLowerCase()} for their next shift.`
          : p.type === 'part'
          ? `Flag this part with the supplier for a quality check and review the last ${p.count} installs for a common cause.`
          : `Review the standard procedure for "${p.label}" jobs — ${p.count} callbacks share the same root cause.`,
    });
  }

  return result.sort((a, b) => b.count - a.count);
}

// ============================================================
// PREVENTION WORKFLOWS
// ============================================================

export async function fetchPreventionWorkflows(): Promise<PreventionWorkflow[]> {
  const { data, error } = await supabase
    .from('callback_prevention_workflows')
    .select('*')
    .order('occurrence_count', { ascending: false });
  if (error) throw error;
  return (data as PreventionWorkflow[]) ?? [];
}

export async function savePreventionWorkflow(pattern: RootCausePattern, userId: string): Promise<void> {
  const { error } = await supabase.from('callback_prevention_workflows').upsert(
    {
      user_id: userId,
      pattern_key: pattern.patternKey,
      pattern_type: pattern.patternType,
      title: pattern.title,
      description: pattern.description,
      recommended_action: pattern.recommendedAction,
      occurrence_count: pattern.count,
      severity: pattern.severity,
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,pattern_key' },
  );
  if (error) throw error;
}

export async function updateWorkflowStatus(
  id: string,
  status: PreventionWorkflow['status'],
): Promise<void> {
  const { error } = await supabase.from('callback_prevention_workflows').update({ status }).eq('id', id);
  if (error) throw error;
}
