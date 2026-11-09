/**
 * Agent run runtime — pure view helpers (no I/O, no Supabase import → unit-testable).
 * Mirrors the server rules in supabase/migrations/20281116000000_agent_run_runtime.sql.
 */

/** Must equal p_approval_ttl_seconds default (86400) in agent_step_begin: older approvals are refused server-side. */
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export interface ApprovalState {
  expired: boolean;
  msLeft: number;
  label: string;
}

export function formatRemaining(msLeft: number): string {
  if (msLeft <= 0) return 'Expired';
  const totalMin = Math.floor(msLeft / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m left` : `${m}m left`;
}

/** `waitingSinceIso`: when the step started waiting (agent_run_steps.updated_at), else the log row's created_at. */
export function approvalState(waitingSinceIso: string, nowMs: number): ApprovalState {
  const since = Date.parse(waitingSinceIso);
  if (!Number.isFinite(since)) return { expired: true, msLeft: 0, label: 'Expired' };
  const msLeft = since + APPROVAL_TTL_MS - nowMs;
  return { expired: msLeft <= 0, msLeft: Math.max(0, msLeft), label: formatRemaining(msLeft) };
}

export type StepStatus =
  | 'in_flight' | 'succeeded' | 'failed_retryable' | 'failed_permanent' | 'awaiting_approval' | 'blocked' | 'needs_human';

const STEP_LABELS: Record<StepStatus, string> = {
  in_flight: 'Running',
  succeeded: 'Done',
  failed_retryable: 'Will retry',
  failed_permanent: 'Failed',
  awaiting_approval: 'Waiting for approval',
  blocked: 'Blocked by policy',
  needs_human: 'Needs a person',
};

export function stepStatusLabel(status: string): string {
  return STEP_LABELS[status as StepStatus] ?? status;
}

export interface RunStepView {
  id: string;
  run_id: string;
  step_index: number;
  tool: string;
  status: StepStatus;
  attempt_count: number;
  maybe_executed: boolean;
  verification: 'not_required' | 'pending' | 'verified' | 'failed';
  input: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error_class: string | null;
  error: string | null;
  action_log_id: string | null;
  started_at: string;
  finished_at: string | null;
  updated_at: string;
}

export interface RunView {
  id: string;
  agent_source: string;
  correlation_id: string;
  status: string;
  plan: Record<string, unknown>;
  limits: Partial<Record<'max_steps' | 'max_cost_cents' | 'max_tokens' | 'max_contacts', number>>;
  usage: { steps?: number; cost_cents?: number; tokens?: number; contacts?: number };
  deadline_at: string;
  created_at: string;
}

const HIDDEN_KEYS = new Set(['enrollmentId', 'entityId', 'leadId', 'jobId', 'stepNumber', 'campaignType', 'entityTable']);

/** Human-readable evidence for the approver. Long free text is truncated; internal ids are not shown raw. */
export function summarizeToolInput(input: Record<string, unknown>): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  for (const [k, v] of Object.entries(input ?? {})) {
    if (HIDDEN_KEYS.has(k) || v === null || v === undefined) continue;
    const text = typeof v === 'string' ? v : JSON.stringify(v);
    out.push({ label: k.replace(/([A-Z])/g, ' $1').toLowerCase(), value: text.length > 160 ? `${text.slice(0, 157)}…` : text });
  }
  return out;
}

export function runBudgetSummary(run: Pick<RunView, 'limits' | 'usage'>): string {
  const u = run.usage ?? {};
  const l = run.limits ?? {};
  const part = (label: string, used: number | undefined, max: number | undefined) =>
    max === undefined ? null : `${label} ${used ?? 0}/${max}`;
  return [
    part('steps', u.steps, l.max_steps),
    part('contacts', u.contacts, l.max_contacts),
    part('cost ¢', u.cost_cents, l.max_cost_cents),
  ].filter(Boolean).join(' · ') || 'no limits recorded';
}
