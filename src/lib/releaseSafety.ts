// Types + pure helpers for the staff Release Safety console (kill switches, approvals, rollouts, AI versions).

export type Risk = 'low' | 'medium' | 'high' | 'critical';

export interface KillSwitch {
  key: string; label: string; description: string | null; risk: Exclude<Risk, 'low'>; stopped: boolean;
  reason: string | null; stopped_at: string | null; updated_at: string; last_drill_at: string | null;
  org_stops: number; pending_resume: string | null;
}

export interface ChangeRequest {
  id: string; kind: 'kill_switch_resume' | 'flag_change' | 'app_policy'; target_key: string;
  payload: Record<string, unknown>; reason: string; status: 'pending' | 'approved' | 'rejected' | 'expired';
  requested_by: string; requested_by_email: string | null; requested_at: string; decided_by_email: string | null; decided_at: string | null;
}

export interface Rollout {
  flag_key: string; component: string; label: string; stage_pct: number; status: 'active' | 'rolled_back' | 'completed';
  breach_count: number; last_decision: 'promote' | 'hold' | 'rollback' | null; last_decision_at: string | null;
  last_reasons: string[]; rollback_reason: string | null; started_at: string; ended_at: string | null;
}

export interface AiVersion {
  kind: 'prompt' | 'route'; task_key: string; version: number; status: 'draft' | 'shadow' | 'active' | 'retired';
  shadow_sample_pct: number; eval_score: number | null; notes: string | null; created_at: string; promoted_at: string | null;
}

export interface FlagImpact { current_tenants: number; next_tenants: number; newly_exposed: number; total_tenants: number }

export type Tone = 'success' | 'warning' | 'danger' | 'neutral' | 'info';

export const DRILL_DUE_DAYS = 28;
export const DRILL_OVERDUE_DAYS = 35;
export const ROLLOUT_STAGES = [5, 25, 50, 100] as const;

export function riskTone(risk: Risk): Tone {
  return risk === 'critical' ? 'danger' : risk === 'high' ? 'warning' : 'neutral';
}

export function decisionTone(d: Rollout['last_decision']): Tone {
  return d === 'promote' ? 'success' : d === 'rollback' ? 'danger' : d === 'hold' ? 'warning' : 'neutral';
}

export function drillStatus(lastDrillAt: string | null, now: number = Date.now()): { label: string; tone: Tone } {
  if (!lastDrillAt) return { label: 'Never drilled', tone: 'danger' };
  const t = Date.parse(lastDrillAt);
  if (Number.isNaN(t)) return { label: 'Never drilled', tone: 'danger' };
  const days = Math.floor((now - t) / 86_400_000);
  if (days >= DRILL_OVERDUE_DAYS) return { label: `Drill overdue (${days}d)`, tone: 'danger' };
  if (days >= DRILL_DUE_DAYS) return { label: `Drill due (${days}d)`, tone: 'warning' };
  return { label: `Drilled ${days}d ago`, tone: 'success' };
}

/** A request can be decided only by a different person than the requester, while still pending. */
export function canDecide(req: Pick<ChangeRequest, 'status' | 'requested_by'>, myUserId: string | null | undefined): boolean {
  return req.status === 'pending' && Boolean(myUserId) && req.requested_by !== myUserId;
}

export function describeRequest(req: Pick<ChangeRequest, 'kind' | 'target_key' | 'payload'>): string {
  const p = req.payload;
  if (req.kind === 'kill_switch_resume') return `Resume kill switch "${req.target_key}"`;
  if (req.kind === 'flag_change') {
    const on = p.enabled === true;
    return `Set flag "${req.target_key}" ${on ? `ON at ${Number(p.rollout_pct ?? 0)}%` : 'OFF'}`;
  }
  return `Set ${req.target_key} app policy: minimum ${String(p.min_version ?? '?')}, latest ${String(p.latest_version ?? '?')}, ${Number(p.rollout_pct ?? 100)}% prompted`;
}

/** The sorted next stages a rollout may move to. */
export function nextStages(current: number): number[] {
  return ROLLOUT_STAGES.filter((s) => s > current);
}

/** Staff-facing validation shared by the stop / request forms. */
export function validateReason(reason: string): string | null {
  const t = reason.trim();
  if (t.length < 3) return 'Enter a reason (at least 3 characters).';
  if (t.length > 500) return 'Keep the reason under 500 characters.';
  return null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string): boolean => UUID_RE.test(v.trim());

export function impactSummary(i: FlagImpact): string {
  const delta = i.next_tenants - i.current_tenants;
  const sign = delta > 0 ? '+' : '';
  return `${i.current_tenants} → ${i.next_tenants} of ${i.total_tenants} accounts (${sign}${delta}); ${i.newly_exposed} newly exposed`;
}
