/**
 * Customer health score (staff view). Pure + rule-based: every deduction carries a reason code,
 * a human label and its points, so a score is always explainable. Raw signals come from the
 * staff-only RPC public.staff_customer_health(). No I/O here.
 */

export interface HealthSignals {
  account_id: string;
  email: string;
  company_name: string | null;
  plan: string;
  subscription_status: string;
  onboarding_completed: boolean;
  has_forwarding: boolean;
  created_at: string;
  calls_7d: number;
  calls_30d: number;
  calls_prev_7d: number;
  integrations_in_error: number;
  escalations_open: number;
  tickets_open: number;
  last_sign_in_at: string | null;
}

export type RiskLevel = 'low' | 'medium' | 'high';

export interface HealthReason {
  code: string;
  label: string;
  points: number; // points removed from 100
}

export interface HealthResult {
  score: number; // 0..100
  risk: RiskLevel;
  reasons: HealthReason[];
}

const DAY_MS = 86_400_000;

function daysBetween(fromIso: string | null, now: Date): number | null {
  if (!fromIso) return null;
  const t = Date.parse(fromIso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / DAY_MS));
}

/** Thresholds are deliberately simple constants so staff can reason about them. */
export function scoreCustomer(s: HealthSignals, now: Date = new Date()): HealthResult {
  const reasons: HealthReason[] = [];
  const add = (code: string, label: string, points: number) => reasons.push({ code, label, points });

  const ageDays = daysBetween(s.created_at, now) ?? 0;
  const loginDays = daysBetween(s.last_sign_in_at, now);

  if (s.subscription_status === 'past_due') add('payment_failed', 'Payment failed (past due)', 30);
  if (!s.onboarding_completed && ageDays > 3) add('activation_incomplete', 'Onboarding not completed after 3+ days', 25);
  if (!s.has_forwarding && ageDays > 3) add('no_forwarding', 'No forwarding number set', 10);

  if (s.calls_30d === 0 && ageDays > 14) add('no_calls_30d', 'No calls handled in 30 days', 25);
  else if (s.calls_7d === 0 && s.calls_30d > 0) add('no_calls_7d', 'No calls handled in the last 7 days', 15);

  if (s.calls_prev_7d >= 10 && s.calls_7d <= s.calls_prev_7d * 0.4) {
    add('call_volume_drop', `Call volume fell from ${s.calls_prev_7d} to ${s.calls_7d} week over week`, 15);
  }
  if (s.integrations_in_error > 0) add('integration_errors', `${s.integrations_in_error} integration(s) in error`, 15);
  if (s.escalations_open > 0) add('unresolved_escalations', `${s.escalations_open} unresolved escalation(s)`, 10);
  if (s.tickets_open >= 3) add('many_open_tickets', `${s.tickets_open} open support tickets`, 10);

  if (loginDays === null) {
    if (ageDays > 7) add('never_logged_in', 'No recorded sign-in', 20);
  } else if (loginDays >= 30) add('login_30d', `No sign-in for ${loginDays} days`, 20);
  else if (loginDays >= 14) add('login_14d', `No sign-in for ${loginDays} days`, 10);

  const lost = reasons.reduce((n, r) => n + r.points, 0);
  const score = Math.max(0, Math.min(100, 100 - lost));
  const risk: RiskLevel = score < 50 || s.subscription_status === 'past_due' ? 'high' : score < 75 ? 'medium' : 'low';
  return { score, risk, reasons: reasons.sort((a, b) => b.points - a.points) };
}

const RANK: Record<RiskLevel, number> = { high: 0, medium: 1, low: 2 };

/** Worst accounts first; ties by lower score. */
export function rankCustomers(rows: HealthSignals[], now: Date = new Date()) {
  return rows
    .map((s) => ({ signals: s, health: scoreCustomer(s, now) }))
    .sort((a, b) => RANK[a.health.risk] - RANK[b.health.risk] || a.health.score - b.health.score);
}
