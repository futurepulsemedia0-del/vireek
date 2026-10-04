import { supabase } from '@/lib/supabase';
import { computeSnapshot, DAY_MS, type ChangeSnapshot, type RawData } from '@/lib/changesSinceYesterday';


/** A failed source becomes `null` (metric hidden) instead of a misleading zero. */
async function load<T>(query: PromiseLike<{ data: unknown; error: unknown }>): Promise<T[] | null> {
  try {
    const { data, error } = await query;
    return error || !Array.isArray(data) ? null : (data as T[]);
  } catch {
    return null;
  }
}

const localMidnight = (base: number, offsetDays: number) => {
  const d = new Date(base);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offsetDays).toISOString();
};

/** Row-level security scopes every query to the signed-in account — no user_id filter needed. */
export async function fetchChangeSnapshot(now: number = Date.now()): Promise<ChangeSnapshot> {
  const since48h = new Date(now - 2 * DAY_MS).toISOString();

  const [invoices, calls, jobsCreated, jobsScheduled, reviews, team] = await Promise.all([
    load<NonNullable<RawData['invoices']>[number]>(
      supabase
        .from('invoices')
        .select('status,sent_at,paid_at,created_at,line_items,tax_percent')
        .neq('status', 'void')
        .neq('status', 'draft')
        .or(`paid_at.is.null,paid_at.gte.${since48h}`),
    ),
    load<NonNullable<RawData['calls']>[number]>(
      supabase.from('calls').select('call_datetime,sentiment').gte('call_datetime', since48h),
    ),
    load<NonNullable<RawData['jobsCreated']>[number]>(
      supabase.from('jobs').select('created_at').gte('created_at', since48h),
    ),
    load<NonNullable<RawData['jobsScheduled']>[number]>(
      supabase
        .from('jobs')
        .select('scheduled_datetime,job_status')
        .gte('scheduled_datetime', localMidnight(now, -1))
        .lt('scheduled_datetime', localMidnight(now, 1)),
    ),
    load<NonNullable<RawData['reviews']>[number]>(
      supabase
        .from('review_requests')
        .select('rating,completed_at')
        .eq('status', 'completed')
        .lte('rating', 2)
        .gte('completed_at', since48h),
    ),
    load<{ max_jobs_per_day: number | null }>(
      supabase
        .from('team_members')
        .select('max_jobs_per_day')
        .eq('dispatch_enabled', true)
        .eq('invite_status', 'active'),
    ),
  ]);

  const dailyCapacity = team ? team.reduce((sum, m) => sum + (Number(m.max_jobs_per_day) || 0), 0) : null;

  return computeSnapshot(
    { invoices, calls, jobsCreated, jobsScheduled, reviews, dailyCapacity },
    now,
  );
}
