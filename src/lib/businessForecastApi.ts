import { supabase } from '@/lib/supabase';
import {
  quoteTotalDollars,
  type ForecastFixedExpense,
  type ForecastInput,
  type ForecastJob,
  type ForecastMembership,
  type ForecastPayment,
  type ForecastProfitRow,
  type ForecastQuote,
  type ForecastTechnician,
} from '@/lib/businessForecast';

const DAY = 86_400_000;
const ROW_LIMIT = 5000;

const JOB_COLUMNS = 'id,invoice_amount,invoice_status,job_status,scheduled_datetime,created_at,completed_at';

interface PlanJoin { price_cents: number | null; billing_interval: string | null }
interface MembershipRow {
  status: string;
  auto_renew: boolean | null;
  current_period_end: string | null;
  membership_plans: PlanJoin | PlanJoin[] | null;
}
interface QuoteRow {
  status: string;
  line_items: unknown;
  tax_percent: number | null;
  valid_until: string | null;
}
interface TechnicianRow { id: string; max_jobs_per_day: number | null }
interface SettingsRow { starting_cash_balance: number | null; default_cost_ratio: number | null; quote_win_rate: number | null }
interface ExpenseRow { amount: number; frequency: ForecastFixedExpense['frequency']; next_due_date: string }

/**
 * Loads everything the forecast engine needs. Only the jobs query is critical:
 * if it fails we throw so the page can show a retry state. Every other source
 * degrades to "no data", which the engine already turns into lower confidence.
 */
export async function fetchForecastInput(userId: string): Promise<ForecastInput> {
  const now = Date.now();
  const since90 = new Date(now - 90 * DAY).toISOString();
  const since120 = new Date(now - 120 * DAY).toISOString();
  const until = new Date(now + 91 * DAY).toISOString();

  const [jobsRes, unpaidRes, paymentsRes, membershipsRes, quotesRes, techsRes, profitRes, settingsRes, expensesRes] =
    await Promise.all([
      supabase.from('jobs').select(JOB_COLUMNS).gte('scheduled_datetime', since90).lte('scheduled_datetime', until).limit(ROW_LIMIT),
      supabase.from('jobs').select(JOB_COLUMNS).eq('job_status', 'completed').neq('invoice_status', 'paid').gte('created_at', since120).limit(2000),
      supabase.from('payment_requests').select('amount,status,job_id,created_at,paid_at').gte('created_at', since120).limit(ROW_LIMIT),
      supabase.from('memberships').select('status,auto_renew,current_period_end,membership_plans(price_cents,billing_interval)').eq('status', 'active').limit(ROW_LIMIT),
      supabase.from('quotes').select('status,line_items,tax_percent,valid_until').in('status', ['sent', 'accepted', 'declined', 'expired']).gte('created_at', since120).limit(2000),
      supabase.from('team_members').select('id,max_jobs_per_day').eq('role', 'technician').eq('dispatch_enabled', true),
      supabase.from('job_profitability').select('revenue_cents,total_cost_cents').eq('job_status', 'completed').gte('scheduled_datetime', since90).limit(ROW_LIMIT),
      supabase.from('cash_flow_settings').select('starting_cash_balance,default_cost_ratio,quote_win_rate').eq('user_id', userId).maybeSingle(),
      supabase.from('cash_flow_fixed_expenses').select('amount,frequency,next_due_date').eq('user_id', userId).eq('active', true),
    ]);

  if (jobsRes.error) throw new Error(jobsRes.error.message);

  const byId = new Map<string, ForecastJob>();
  for (const j of [...((jobsRes.data ?? []) as ForecastJob[]), ...((unpaidRes.data ?? []) as ForecastJob[])]) byId.set(j.id, j);

  const memberships: ForecastMembership[] = ((membershipsRes.data ?? []) as MembershipRow[]).flatMap((m) => {
    const plan = Array.isArray(m.membership_plans) ? m.membership_plans[0] : m.membership_plans;
    if (!plan || !plan.price_cents) return [];
    return [{
      status: m.status,
      auto_renew: m.auto_renew !== false,
      current_period_end: m.current_period_end,
      price_cents: plan.price_cents,
      interval: plan.billing_interval === 'yearly' ? 'yearly' : 'monthly',
    }];
  });

  const quotes: ForecastQuote[] = ((quotesRes.data ?? []) as QuoteRow[]).map((q) => ({
    status: q.status,
    total: quoteTotalDollars(q.line_items, q.tax_percent ?? 0),
    valid_until: q.valid_until,
  }));

  const settings = (settingsRes.data ?? null) as SettingsRow | null;

  return {
    jobs: [...byId.values()],
    payments: ((paymentsRes.data ?? []) as ForecastPayment[]).map((p) => ({ ...p, amount: Number(p.amount) || 0 })),
    memberships,
    quotes,
    expenses: ((expensesRes.data ?? []) as ExpenseRow[]).map((e) => ({ ...e, amount: Number(e.amount) || 0 })),
    technicians: ((techsRes.data ?? []) as TechnicianRow[]).map<ForecastTechnician>((t) => ({
      id: t.id,
      max_jobs_per_day: t.max_jobs_per_day ?? 6,
    })),
    profitability: ((profitRes.error ? [] : profitRes.data ?? []) as ForecastProfitRow[]),
    settings: {
      startingCash: Number(settings?.starting_cash_balance ?? 0),
      defaultCostRatioPct: Number(settings?.default_cost_ratio ?? 55),
      quoteWinRatePct: Number(settings?.quote_win_rate ?? 25),
      configured: settings !== null,
    },
    truncated: (jobsRes.data?.length ?? 0) >= ROW_LIMIT,
  };
}
