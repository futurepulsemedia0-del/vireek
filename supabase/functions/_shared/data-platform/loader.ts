// supabase/functions/_shared/data-platform/loader.ts
//
// Reads the rows the metrics layer and the reverse-ETL models need. It takes any Supabase client:
// a service-role client (edge functions that already checked permission) or the caller's own
// client (Ask Vireek). EVERY query is scoped to the account owner id either way.

import { buildOfficialFacts, type MetricData, type MetricJob } from "./metrics.ts";
import type { AudienceCustomer, AudienceJob } from "./reverseEtl.ts";

// deno-lint-ignore no-explicit-any
type Db = any;

const PAGE = 1000;
export const MAX_JOBS = 20_000;
export const MAX_ROWS = 20_000;

async function pageAll<T>(max: number, build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = [];
  for (let from = 0; from <= max; from += PAGE) {
    const { data, error } = await build(from, Math.min(from + PAGE - 1, max));
    if (error) throw new Error(error.message);
    const page = (data ?? []) as T[];
    rows.push(...page);
    if (page.length < Math.min(from + PAGE - 1, max) - from + 1) break;
  }
  const truncated = rows.length > max;
  return { rows: truncated ? rows.slice(0, max) : rows, truncated };
}

export interface LoadedMetricData { data: MetricData; truncated: boolean }

/** Rows whose event time can fall in [fromIso, now). Include the prior period in `fromIso` when comparing. */
export async function loadMetricData(db: Db, ownerId: string, fromIso: string): Promise<LoadedMetricData> {
  const jobCols = "id,assigned_technician_id,job_status,invoice_amount,invoice_status,completed_at,scheduled_datetime,created_at,first_response_at,service_type,customer_type";
  const jobsQ = pageAll<MetricJob>(MAX_JOBS, (a, b) =>
    db.from("jobs").select(jobCols).eq("user_id", ownerId)
      .or(`completed_at.gte.${fromIso},scheduled_datetime.gte.${fromIso},created_at.gte.${fromIso}`)
      .order("created_at", { ascending: false }).order("id").range(a, b));
  const quotesQ = pageAll<{ status: string; sent_at: string | null }>(MAX_ROWS, (a, b) =>
    db.from("quotes").select("status,sent_at").eq("user_id", ownerId).gte("sent_at", fromIso).order("sent_at", { ascending: false }).order("id").range(a, b));
  const callsQ = pageAll<{ status: string; call_datetime: string }>(MAX_ROWS, (a, b) =>
    db.from("calls").select("status,call_datetime").eq("user_id", ownerId).eq("status", "missed").gte("call_datetime", fromIso).order("call_datetime", { ascending: false }).order("id").range(a, b));
  const recQ = pageAll<{ source_type: string; status: string; occurred_at: string; recovered_amount_cents: number | null }>(MAX_ROWS, (a, b) =>
    db.from("revenue_recovery_events").select("source_type,status,occurred_at,recovered_amount_cents").eq("user_id", ownerId)
      .in("source_type", ["missed_call", "voicemail"]).gte("occurred_at", fromIso).order("occurred_at", { ascending: false }).order("id").range(a, b));
  const techQ = db.from("team_members").select("id,member_name,member_email").eq("account_owner_id", ownerId).limit(500);

  const [jobs, quotes, calls, rec, techs] = await Promise.all([jobsQ, quotesQ, callsQ, recQ, techQ]);
  if (techs.error) throw new Error(techs.error.message);

  const costs: MetricData["costs"] = [];
  const ids = jobs.rows.map((j) => j.id);
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error } = await db.from("job_cost_entries").select("job_id,total_cost_cents").eq("user_id", ownerId).in("job_id", ids.slice(i, i + 150));
    if (error) throw new Error(error.message);
    costs.push(...((data ?? []) as MetricData["costs"]));
  }

  return {
    data: {
      jobs: jobs.rows,
      costs,
      quotes: quotes.rows,
      calls: calls.rows,
      recoveries: rec.rows,
      technicians: ((techs.data ?? []) as { id: string; member_name: string | null; member_email: string }[]).map((t) => ({ id: t.id, name: t.member_name?.trim() || t.member_email })),
    },
    truncated: jobs.truncated || quotes.truncated || calls.truncated || rec.truncated,
  };
}

export async function loadAudienceData(db: Db, ownerId: string): Promise<{ customers: AudienceCustomer[]; jobs: AudienceJob[]; truncated: boolean }> {
  const MAXC = 50_000;
  const c = await pageAll<AudienceCustomer>(MAXC, (a, b) =>
    db.from("customers").select("id,name,email,phone,marketing_opt_in,lifecycle_stage").eq("user_id", ownerId).order("id").range(a, b));
  const j = await pageAll<AudienceJob>(100_000, (a, b) =>
    db.from("jobs").select("customer_id,job_status,invoice_amount,completed_at,created_at").eq("user_id", ownerId).eq("job_status", "completed").not("customer_id", "is", null).order("id").range(a, b));
  return { customers: c.rows, jobs: j.rows, truncated: c.truncated || j.truncated };
}

/** Fact pack for the finance copilot (Ask Vireek). Never throws: the copilot must keep working without it. */
export async function officialMetricFacts(db: Db, ownerId: string, now: Date, tz: string): Promise<Record<string, unknown> | null> {
  try {
    const from = new Date(now.getTime() - 62 * 86_400_000).toISOString();
    const { data } = await loadMetricData(db, ownerId, from);
    return buildOfficialFacts(data, { now, tz });
  } catch (err) {
    console.warn("[data-platform] official metrics unavailable:", err instanceof Error ? err.message : err);
    return null;
  }
}
