/**
 * Growth analytics — data access (staff only, except getMyVariant / recordSignupAttribution).
 *
 * Thin typed wrappers over the SECURITY DEFINER RPCs in
 * supabase/migrations/20281103000000_growth_analytics_core.sql and 20281104000000_growth_analytics_phase2.sql.
 * Authorization, audit logging and range validation are enforced by the database. Every payload is parsed
 * defensively (unknown -> typed) so a schema drift degrades to "insufficient data" rather than NaN on screen.
 */
import { supabase } from '@/lib/supabase';
import type { BridgeRaw } from '@/lib/growth/growthMetrics';
import type { ArmCounts, ExperimentMeta, ExperimentResultsRaw, GrowthAlpha, GrowthMetric } from '@/lib/growth/growthExperiments';
import type { SendArgs } from '@/lib/growth/growthAttribution';

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown, d = 0): number => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : d;
};
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const date = (v: unknown): Date | null => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v) : null);
const bool = (v: unknown): boolean => v === true;

async function call(fn: string, args?: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw error;
  return data;
}
export const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

/* ---------- Revenue ---------- */
export function parseBridge(v: unknown): BridgeRaw[] {
  return arr(rec(v).by_currency).map((x) => {
    const r = rec(x);
    const m = rec(r.movements);
    const mvOf = (k: string) => (m[k] === undefined ? undefined : { cents: num(rec(m[k]).cents), n: num(rec(m[k]).n) });
    return {
      currency: str(r.currency, 'unknown'),
      opening_mrr_cents: num(r.opening_mrr_cents),
      closing_mrr_cents: num(r.closing_mrr_cents),
      movements: {
        new: mvOf('new'), expansion: mvOf('expansion'), contraction: mvOf('contraction'),
        churn: mvOf('churn'), reactivation: mvOf('reactivation'),
      },
      cohort_n: num(r.cohort_n),
      cohort_opening_cents: num(r.cohort_opening_cents),
      cohort_closing_cents: num(r.cohort_closing_cents),
      cohort_retained_floor_cents: num(r.cohort_retained_floor_cents),
      cohort_churned_n: num(r.cohort_churned_n),
    };
  });
}
export const fetchBridge = async (from: Date, to: Date) =>
  parseBridge(await call('staff_growth_mrr_bridge', { p_from: isoDay(from), p_to: isoDay(to) }));

export interface CohortRow { cohortMonth: string; currency: string; offset: number; cohortSize: number; activeN: number; mrrCents: number; isPartial: boolean }
export async function fetchCohorts(months = 12): Promise<CohortRow[]> {
  const d = rec(await call('staff_growth_retention_cohorts', { p_months: months }));
  return arr(d.rows).map((x) => {
    const r = rec(x);
    return { cohortMonth: str(r.cohort_month), currency: str(r.currency), offset: num(r.offset), cohortSize: num(r.cohort_size),
      activeN: num(r.active_n), mrrCents: num(r.mrr_cents), isPartial: bool(r.is_partial) };
  });
}

/* ---------- Acquisition / activation / trials ---------- */
export interface ActivationRecord { signupAt: Date; testCallAnsweredAt: Date | null; realCallAt: Date | null; bookingAt: Date | null; channel: string | null }
export interface ActivationData { signups: number; testCallAnswered: number; realCall: number; booking: number; truncated: boolean; records: ActivationRecord[] }
export async function fetchActivation(from: Date, to: Date): Promise<ActivationData> {
  const d = rec(await call('staff_growth_activation', { p_from: isoDay(from), p_to: isoDay(to) }));
  const records: ActivationRecord[] = [];
  for (const x of arr(d.records)) {
    const r = rec(x);
    const signupAt = date(r.signup_at);
    if (signupAt) records.push({ signupAt, testCallAnsweredAt: date(r.test_call_answered_at), realCallAt: date(r.real_call_at), bookingAt: date(r.booking_at), channel: strOrNull(r.channel) });
  }
  return { signups: num(d.signups), testCallAnswered: num(d.test_call_answered), realCall: num(d.real_call), booking: num(d.booking), truncated: bool(d.truncated), records };
}

export interface TrialRow { trialStart: Date; trialEnd: Date | null; convertedAt: Date | null; channel: string; cohortMonth: string }
export async function fetchTrials(from: Date, to: Date): Promise<{ truncated: boolean; records: TrialRow[] }> {
  const d = rec(await call('staff_growth_trials', { p_from: isoDay(from), p_to: isoDay(to) }));
  const records: TrialRow[] = [];
  for (const x of arr(d.records)) {
    const r = rec(x);
    const trialStart = date(r.trial_start);
    if (trialStart) records.push({ trialStart, trialEnd: date(r.trial_end), convertedAt: date(r.converted_at), channel: str(r.channel, 'unknown'), cohortMonth: str(r.cohort_month) });
  }
  return { truncated: bool(d.truncated), records };
}

export interface AcquisitionChannel { channel: string; currency: string; newCustomers: number; newMrrCents: number; spendCents: number | null }
export interface AcquisitionData {
  spendPeriodAligned: boolean; historyStart: Date | null; channels: AcquisitionChannel[];
  coverage: { total: number; attributed: number }; current: { currency: string; payingAccounts: number; mrrCents: number }[];
}
export async function fetchAcquisition(from: Date, to: Date): Promise<AcquisitionData> {
  const d = rec(await call('staff_growth_acquisition', { p_from: isoDay(from), p_to: isoDay(to) }));
  const cov = rec(d.coverage);
  return {
    spendPeriodAligned: bool(d.spend_period_aligned),
    historyStart: date(d.history_start),
    channels: arr(d.channels).map((x) => {
      const r = rec(x);
      return { channel: str(r.channel), currency: str(r.currency), newCustomers: num(r.new_customers), newMrrCents: num(r.new_mrr_cents), spendCents: r.spend_cents === null || r.spend_cents === undefined ? null : num(r.spend_cents) };
    }),
    coverage: { total: num(cov.new_customers_total), attributed: num(cov.new_customers_attributed) },
    current: arr(d.current).map((x) => { const r = rec(x); return { currency: str(r.currency), payingAccounts: num(r.paying_accounts), mrrCents: num(r.mrr_cents) }; }),
  };
}

export interface SpendRow { id: string; channel: string; month: string; amountCents: number; currency: string; note: string | null }
export async function fetchSpend(from: Date, to: Date): Promise<SpendRow[]> {
  return arr(await call('staff_growth_spend_list', { p_from: isoDay(from), p_to: isoDay(to) })).map((x) => {
    const r = rec(x);
    return { id: str(r.id), channel: str(r.channel), month: str(r.month), amountCents: num(r.amount_cents), currency: str(r.currency), note: strOrNull(r.note) };
  });
}
export async function upsertSpend(p: { channel: string; month: string; amountCents: number; currency: string; note: string }): Promise<void> {
  await call('staff_growth_spend_upsert', { p_channel: p.channel, p_month: p.month, p_amount_cents: Math.round(p.amountCents), p_currency: p.currency, p_note: p.note });
}
export async function deleteSpend(id: string): Promise<void> {
  await call('staff_growth_spend_delete', { p_id: id });
}

/* ---------- Plans & churn ---------- */
export interface PlanMixRow { planId: string; currency: string; payingN: number; trialingN: number; mrrCents: number }
export interface PlanPathRow { fromPlan: string; toPlan: string; currency: string; kind: 'upgrade' | 'downgrade'; n: number; deltaCents: number }
export async function fetchPlans(from: Date, to: Date): Promise<{ mix: PlanMixRow[]; paths: PlanPathRow[] }> {
  const d = rec(await call('staff_growth_plans', { p_from: isoDay(from), p_to: isoDay(to) }));
  return {
    mix: arr(d.mix).map((x) => { const r = rec(x); return { planId: str(r.plan_id), currency: str(r.currency), payingN: num(r.paying_n), trialingN: num(r.trialing_n), mrrCents: num(r.mrr_cents) }; }),
    paths: arr(d.paths).map((x) => { const r = rec(x); return { fromPlan: str(r.from_plan), toPlan: str(r.to_plan), currency: str(r.currency), kind: r.kind === 'downgrade' ? 'downgrade' : 'upgrade', n: num(r.n), deltaCents: num(r.delta_cents) }; }),
  };
}
export async function fetchChurnReasons(from: Date, to: Date): Promise<{ actions: Record<string, number>; reasons: { reason: string; n: number }[] }> {
  const d = rec(await call('staff_growth_churn_reasons', { p_from: isoDay(from), p_to: isoDay(to) }));
  const actions: Record<string, number> = {};
  for (const [k, v] of Object.entries(rec(d.actions))) actions[k] = num(v);
  return { actions, reasons: arr(d.reasons).map((x) => { const r = rec(x); return { reason: str(r.reason), n: num(r.n) }; }) };
}

/* ---------- Experiments ---------- */
export interface ExperimentSummary extends ExperimentMeta { name: string; hypothesis: string; surface: 'onboarding' | 'trial' | 'pricing'; assigned: number; decision: string | null }
const metricOf = (v: unknown): GrowthMetric => (v === 'trial_to_paid' ? 'trial_to_paid' : 'activated_7d');
const alphaOf = (v: unknown): GrowthAlpha => { const n = num(v, 0.05); return n === 0.01 ? 0.01 : n === 0.1 ? 0.1 : 0.05; };
const statusOf = (v: unknown): ExperimentMeta['status'] => (v === 'running' || v === 'concluded' || v === 'archived' ? v : 'draft');

export async function listExperiments(): Promise<ExperimentSummary[]> {
  return arr(await call('staff_growth_experiments_list')).map((x) => {
    const r = rec(x);
    return {
      key: str(r.key), name: str(r.name), hypothesis: str(r.hypothesis),
      surface: r.surface === 'pricing' ? 'pricing' : r.surface === 'trial' ? 'trial' : 'onboarding',
      status: statusOf(r.status), treatment_share: num(r.treatment_share, 50), primary_metric: metricOf(r.primary_metric),
      min_runtime_days: num(r.min_runtime_days, 14), alpha: alphaOf(r.alpha), started_at: strOrNull(r.started_at),
      ended_at: strOrNull(r.ended_at), assigned: num(r.assigned), decision: strOrNull(r.decision),
    };
  });
}
export interface NewExperiment { key: string; name: string; hypothesis: string; surface: 'onboarding' | 'trial' | 'pricing'; treatmentShare: number; primaryMetric: GrowthMetric; minRuntimeDays: number; alpha: GrowthAlpha }
export async function createExperiment(e: NewExperiment): Promise<void> {
  await call('staff_growth_experiment_create', {
    p_key: e.key, p_name: e.name, p_hypothesis: e.hypothesis, p_surface: e.surface, p_treatment_share: e.treatmentShare,
    p_primary_metric: e.primaryMetric, p_min_runtime_days: e.minRuntimeDays, p_alpha: e.alpha,
  });
}
export async function transitionExperiment(key: string, to: 'running' | 'concluded' | 'archived', opts: { decision?: 'adopt' | 'iterate' | 'reject'; priceIntegrity?: boolean } = {}): Promise<void> {
  await call('staff_growth_experiment_transition', { p_key: key, p_to: to, p_decision: opts.decision ?? null, p_price_integrity: opts.priceIntegrity ?? false });
}
function parseArm(v: unknown): ArmCounts | undefined {
  if (v === undefined || v === null) return undefined;
  const r = rec(v);
  return { assigned: num(r.assigned), activation_n: num(r.activation_n), activation_k: num(r.activation_k), trial_n: num(r.trial_n), trial_k: num(r.trial_k), paying_n: num(r.paying_n), cancel_k: num(r.cancel_k) };
}
export async function fetchExperimentResults(key: string): Promise<ExperimentResultsRaw> {
  const d = rec(await call('staff_growth_experiment_results', { p_key: key }));
  const e = rec(d.experiment);
  const arms = rec(d.arms);
  return {
    experiment: {
      key: str(e.key), status: statusOf(e.status), treatment_share: num(e.treatment_share, 50), primary_metric: metricOf(e.primary_metric),
      min_runtime_days: num(e.min_runtime_days, 14), alpha: alphaOf(e.alpha), started_at: strOrNull(e.started_at), ended_at: strOrNull(e.ended_at),
    },
    arms: { control: parseArm(arms.control), treatment: parseArm(arms.treatment) },
  };
}
/** Returns 'control' | 'treatment', or null when the caller is not enrolled (render the default experience). */
export async function getMyVariant(key: string): Promise<'control' | 'treatment' | null> {
  const v = await call('growth_get_variant', { p_key: key });
  return v === 'treatment' || v === 'control' ? v : null;
}

/* ---------- Operations ---------- */
export interface AlertRule { key: string; description: string; enabled: boolean; threshold: number; minSample: number }
export interface AlertEvent { id: string; ruleKey: string; value: number | null; firedAt: Date | null; acknowledgedAt: Date | null }
export async function fetchAlerts(): Promise<{ rules: AlertRule[]; events: AlertEvent[] }> {
  const d = rec(await call('staff_growth_alerts_list'));
  return {
    rules: arr(d.rules).map((x) => { const r = rec(x); return { key: str(r.key), description: str(r.description), enabled: bool(r.enabled), threshold: num(r.threshold), minSample: num(r.min_sample) }; }),
    events: arr(d.events).map((x) => { const r = rec(x); return { id: str(r.id), ruleKey: str(r.rule_key), value: r.value === null || r.value === undefined ? null : num(r.value), firedAt: date(r.fired_at), acknowledgedAt: date(r.acknowledged_at) }; }),
  };
}
export const acknowledgeAlert = async (id: string): Promise<void> => void (await call('staff_growth_alert_ack', { p_id: id }));
export const setAlertRule = async (key: string, enabled: boolean, threshold: number): Promise<void> =>
  void (await call('staff_growth_alert_rule_set', { p_key: key, p_enabled: enabled, p_threshold: threshold }));

export type DataQuality = Record<string, number | boolean | string>;
export async function fetchDataQuality(): Promise<DataQuality> {
  const d = rec(await call('staff_growth_data_quality'));
  const out: DataQuality = {};
  for (const [k, v] of Object.entries(d)) if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') out[k] = v;
  return out;
}

export interface ReconciliationRun {
  ranAt: Date | null; triggeredBy: string; stripeSubscriptions: number; mismatches: number;
  complete: boolean; byKind: Record<string, number>; details: { kind: string; subscriptionId: string; stripeStatus: string | null; factStatus: string | null; stripeMrr: number | null; factMrr: number | null; explained: boolean }[];
}
export async function fetchReconciliation(): Promise<ReconciliationRun | null> {
  const l = rec(rec(await call('staff_growth_reconciliation_latest')).latest);
  if (!l.id) return null;
  const s = rec(l.summary);
  const byKind: Record<string, number> = {};
  for (const [k, v] of Object.entries(rec(s.by_kind))) byKind[k] = num(v);
  return {
    ranAt: date(l.ran_at), triggeredBy: str(l.triggered_by), stripeSubscriptions: num(l.stripe_subscriptions), mismatches: num(l.mismatches),
    complete: bool(s.complete), byKind,
    details: arr(l.details).map((x) => { const r = rec(x); return { kind: str(r.kind), subscriptionId: str(r.subscription_id), stripeStatus: strOrNull(r.stripe_status), factStatus: strOrNull(r.fact_status), stripeMrr: r.stripe_mrr_cents === null ? null : num(r.stripe_mrr_cents), factMrr: r.fact_mrr_cents === null ? null : num(r.fact_mrr_cents), explained: bool(r.explained_by_discount) }; }),
  };
}
export async function runReconciliation(): Promise<void> {
  const { error } = await supabase.functions.invoke('growth-stripe-reconcile', { body: {} });
  if (error) throw error;
}

/* ---------- Attribution (any signed-in user; consent is enforced by growthAttribution.ts before calling) ---------- */
export async function recordSignupAttribution(a: SendArgs): Promise<void> {
  await call('record_signup_attribution', { ...a });
}
