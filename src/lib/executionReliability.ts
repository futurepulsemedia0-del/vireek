import { supabase } from '@/lib/supabase';

export type ExecutionEntityType = 'agent' | 'workflow' | 'integration';
export type ExecutionStatus = 'success' | 'failure' | 'rolled_back';

export interface LogExecutionEventInput {
  entityType: ExecutionEntityType;
  entityKey: string;
  entityLabel: string;
  status: ExecutionStatus;
  latencyMs?: number;
  wasOverride?: boolean;
  overrideReason?: string;
  businessImpactCents?: number;
  context?: Record<string, unknown>;
}

interface ReliabilitySummaryRow {
  entity_type: ExecutionEntityType;
  entity_key: string;
  entity_label: string;
  total_runs: number;
  success_count: number;
  failure_count: number;
  rollback_count: number;
  override_count: number;
  avg_latency_ms: number | null;
  p95_latency_ms: number | null;
  business_impact_cents: number;
  last_event_at: string | null;
}

export type ReliabilityTier = 'excellent' | 'good' | 'at_risk' | 'critical';

export interface ExecutionReliabilityScore {
  entityType: ExecutionEntityType;
  entityKey: string;
  entityLabel: string;
  totalRuns: number;
  successRate: number;
  rollbackRate: number;
  overrideRate: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  businessImpactCents: number;
  lastEventAt: string | null;
  score: number;
  tier: ReliabilityTier;
}

// SLA پیش‌فرض هر نوع entity — تا وقتی جدول تنظیمات جدا اضافه بشه، همین‌جا نگه‌داری می‌شه.
const LATENCY_SLA_MS: Record<ExecutionEntityType, number> = {
  agent: 3000,
  workflow: 30000,
  integration: 5000,
};

const WEIGHTS = { success: 0.4, rollback: 0.2, override: 0.15, latency: 0.15, impact: 0.1 };

function scoreTier(score: number): ReliabilityTier {
  if (score >= 90) return 'excellent';
  if (score >= 75) return 'good';
  if (score >= 55) return 'at_risk';
  return 'critical';
}

// لتنسی نسبت به SLA نوع entity نرمالایز می‌شه: روی SLA یا بهتر = ۱، دو برابر SLA یا بدتر = ۰.
function latencyScoreOf(avgLatencyMs: number, entityType: ExecutionEntityType): number {
  const sla = LATENCY_SLA_MS[entityType];
  if (avgLatencyMs <= sla) return 1;
  if (avgLatencyMs >= sla * 2) return 0;
  return 1 - (avgLatencyMs - sla) / sla;
}

export function computeReliabilityScores(rows: ReliabilitySummaryRow[]): ExecutionReliabilityScore[] {
  const impacts = rows.map((r) => r.business_impact_cents ?? 0);
  const minImpact = Math.min(0, ...impacts);
  const maxImpact = Math.max(0, ...impacts);
  const impactRange = maxImpact - minImpact || 1;

  return rows
    .map((r): ExecutionReliabilityScore => {
      const totalRuns = r.total_runs || 0;
      const successRate = totalRuns > 0 ? r.success_count / totalRuns : 0;
      const rollbackRate = totalRuns > 0 ? r.rollback_count / totalRuns : 0;
      const overrideRate = totalRuns > 0 ? r.override_count / totalRuns : 0;
      const avgLatencyMs = r.avg_latency_ms ?? 0;
      const impactScore = ((r.business_impact_cents ?? 0) - minImpact) / impactRange;
      const latencyScore = latencyScoreOf(avgLatencyMs, r.entity_type);

      const rawScore =
        successRate * WEIGHTS.success * 100 +
        (1 - rollbackRate) * WEIGHTS.rollback * 100 +
        (1 - overrideRate) * WEIGHTS.override * 100 +
        latencyScore * WEIGHTS.latency * 100 +
        impactScore * WEIGHTS.impact * 100;

      const score = Math.max(0, Math.min(100, Math.round(rawScore)));

      return {
        entityType: r.entity_type,
        entityKey: r.entity_key,
        entityLabel: r.entity_label,
        totalRuns,
        successRate,
        rollbackRate,
        overrideRate,
        avgLatencyMs,
        p95LatencyMs: r.p95_latency_ms ?? 0,
        businessImpactCents: r.business_impact_cents ?? 0,
        lastEventAt: r.last_event_at,
        score,
        tier: scoreTier(score),
      };
    })
    .sort((a, b) => a.score - b.score);
}

export async function fetchExecutionReliabilityScores(windowDays = 30): Promise<ExecutionReliabilityScore[]> {
  const { data, error } = await supabase.rpc('get_execution_reliability_summary', { p_window_days: windowDays });
  if (error) throw error;
  return computeReliabilityScores((data as ReliabilitySummaryRow[]) ?? []);
}

export async function logExecutionEvent(input: LogExecutionEventInput): Promise<void> {
  const { error } = await supabase.from('execution_reliability_events').insert({
    entity_type: input.entityType,
    entity_key: input.entityKey,
    entity_label: input.entityLabel,
    status: input.status,
    was_override: input.wasOverride ?? false,
    override_reason: input.overrideReason ?? null,
    latency_ms: input.latencyMs ?? 0,
    business_impact_cents: input.businessImpactCents ?? null,
    context: input.context ?? null,
  });
  // این لاگ نباید هیچ‌وقت جریان اصلی اپ رو بشکنه؛ فقط warn می‌شه.
  if (error) console.warn('logExecutionEvent failed:', error.message);
}
