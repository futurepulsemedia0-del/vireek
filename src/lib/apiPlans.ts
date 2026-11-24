// API usage plans: types, pure maths and data access for the per-key / per-account quota dashboard.
// Enforcement lives in the database (api_v1_admit) and api-v1; everything here is presentation.
// Server migration: supabase/migrations/20290312000000_api_usage_plans.sql
import { supabase } from '@/lib/supabase';

export type OveragePolicy = 'block' | 'meter';

export interface ApiPlan {
  slug: string;
  name: string;
  rate_limit_per_minute: number;
  monthly_quota: number | null; // null = unlimited
  overage_policy: OveragePolicy;
  overage_cents_per_1000: number;
  max_overage_pct: number;
  is_proposed: boolean;
}

export interface PlanUsage {
  enabled: boolean;
  assigned: boolean;
  plan: ApiPlan | null;
  period: string;
  period_start: string; // YYYY-MM-DD
  period_end: string;   // exclusive
  total_requests: number;
  keys: { key_id: string; requests: number }[];
  overage_requests: number;
  estimated_overage_cents: number;
}

export type QuotaState = 'unlimited' | 'ok' | 'warning' | 'over_quota' | 'blocked';

export interface QuotaStatus {
  state: QuotaState;
  pctUsed: number;            // 0-100 (capped at 100 for the bar)
  remaining: number | null;
  hardLimit: number | null;   // where requests start getting 429
  overage: number;
}

export const WARN_AT_PCT = 80;

/** Each started block of 1,000 requests is charged. Mirrors api_overage_cost_cents() in SQL. */
export function overageCostCents(overageRequests: number, centsPer1000: number): number {
  if (!(overageRequests > 0) || !(centsPer1000 > 0)) return 0;
  return Math.ceil(overageRequests / 1000) * centsPer1000;
}

export function hardLimit(plan: Pick<ApiPlan, 'monthly_quota' | 'overage_policy' | 'max_overage_pct'>): number | null {
  if (plan.monthly_quota === null) return null;
  const extra = plan.overage_policy === 'meter' ? Math.floor((plan.monthly_quota * plan.max_overage_pct) / 100) : 0;
  return plan.monthly_quota + extra;
}

export function quotaStatus(used: number, plan: Pick<ApiPlan, 'monthly_quota' | 'overage_policy' | 'max_overage_pct'>): QuotaStatus {
  const u = Math.max(0, used);
  const quota = plan.monthly_quota;
  if (quota === null) return { state: 'unlimited', pctUsed: 0, remaining: null, hardLimit: null, overage: 0 };
  const hard = hardLimit(plan) as number;
  const pct = (u / quota) * 100;
  let state: QuotaState = 'ok';
  if (u >= hard) state = 'blocked';
  else if (u >= quota) state = 'over_quota';
  else if (pct >= WARN_AT_PCT) state = 'warning';
  return { state, pctUsed: Math.min(100, pct), remaining: Math.max(0, quota - u), hardLimit: hard, overage: Math.max(0, u - quota) };
}

/** Straight-line projection of the period total. Null when the period is not the current one or too little time has passed. */
export function projectMonthEnd(total: number, periodStart: string, periodEnd: string, now: Date = new Date()): number | null {
  const start = Date.parse(`${periodStart}T00:00:00Z`);
  const end = Date.parse(`${periodEnd}T00:00:00Z`);
  const t = now.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || t < start || t >= end) return null;
  const elapsed = t - start;
  if (elapsed < 6 * 3_600_000) return null;
  return Math.round(total * ((end - start) / elapsed));
}

export function formatCents(cents: number, locale = 'en'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(cents / 100);
}

export function formatCount(n: number, locale = 'en'): string {
  return new Intl.NumberFormat(locale).format(n);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** Defensive parse of the get_api_plan_usage payload. Throws when the shape is unusable. */
export function parsePlanUsage(raw: unknown): PlanUsage {
  if (!isObj(raw) || typeof raw.period !== 'string' || typeof raw.period_start !== 'string' || typeof raw.period_end !== 'string') {
    throw new Error('Unexpected usage payload');
  }
  let plan: ApiPlan | null = null;
  if (isObj(raw.plan) && typeof raw.plan.slug === 'string') {
    const p = raw.plan;
    plan = {
      slug: p.slug as string,
      name: typeof p.name === 'string' ? p.name : (p.slug as string),
      rate_limit_per_minute: num(p.rate_limit_per_minute),
      monthly_quota: p.monthly_quota === null || p.monthly_quota === undefined ? null : num(p.monthly_quota),
      overage_policy: p.overage_policy === 'meter' ? 'meter' : 'block',
      overage_cents_per_1000: num(p.overage_cents_per_1000),
      max_overage_pct: num(p.max_overage_pct),
      is_proposed: p.is_proposed === true,
    };
  }
  const keys = Array.isArray(raw.keys)
    ? raw.keys.filter(isObj).filter((k) => typeof k.key_id === 'string').map((k) => ({ key_id: k.key_id as string, requests: num(k.requests) }))
    : [];
  return {
    enabled: raw.enabled === true,
    assigned: raw.assigned === true,
    plan,
    period: raw.period,
    period_start: raw.period_start,
    period_end: raw.period_end,
    total_requests: num(raw.total_requests),
    keys,
    overage_requests: num(raw.overage_requests),
    estimated_overage_cents: num(raw.estimated_overage_cents),
  };
}

export async function fetchPlanUsage(ownerId: string, period?: string): Promise<PlanUsage> {
  const { data, error } = await supabase.rpc('get_api_plan_usage', { p_owner: ownerId, p_period: period ?? null });
  if (error) throw new Error(error.message);
  return parsePlanUsage(data);
}
