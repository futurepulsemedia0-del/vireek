// supabase/functions/_shared/business-brain/loader.ts
//
// Loads the raw rows the Business Brain analyses. It receives a Supabase
// client created with the CALLER's JWT, so Postgres RLS — not this code —
// decides which rows are visible. No service-role client is used here.
//
// Every source is loaded independently and defensively: if one table or
// column does not exist on this account's schema, only that source is
// dropped and a plain-English note is added to `gaps` (surfaced to the
// owner as "data gaps"). A missing optional table must never take down
// the whole answer.

import type {
  CallRow,
  CostRow,
  CustomerRow,
  InvoiceRow,
  JobRow,
  LeadRow,
  QuoteRow,
  RawData,
  TechRow,
} from "./types.ts";
import { validTimeZone } from "./util.ts";

// deno-lint-ignore no-explicit-any
type Db = any;

const DAY = 86400000;
const JOB_LIMIT = 3000;

const JOB_COLUMNS =
  "id, customer_name, customer_id, service_type, scheduled_datetime, assigned_technician_id, job_status, invoice_amount, invoice_status, duration_minutes, expected_duration_minutes, started_at, completed_at, is_rework, next_maintenance_date, created_at";
const JOB_COLUMNS_CORE =
  "id, customer_name, service_type, scheduled_datetime, assigned_technician_id, job_status, invoice_amount, invoice_status, duration_minutes, created_at";

async function attempt<T>(label: string, gaps: string[], fallback: T, run: () => Promise<{ data: unknown; error: unknown }>): Promise<T> {
  try {
    const { data, error } = await run();
    if (error) throw error;
    return ((data ?? fallback) as T) ?? fallback;
  } catch (err) {
    console.warn(`[ask-vireek] loader: ${label} unavailable:`, err instanceof Error ? err.message : err);
    gaps.push(`${label} data could not be loaded, so answers that depend on it are limited.`);
    return fallback;
  }
}

export async function loadRawData(db: Db, ownerId: string | null, now: Date): Promise<RawData> {
  const gaps: string[] = [];
  const since120 = new Date(now.getTime() - 120 * DAY).toISOString();
  const since60 = new Date(now.getTime() - 60 * DAY).toISOString();
  const since180Date = new Date(now.getTime() - 180 * DAY).toISOString();

  // ---- jobs (with a retry on core columns if an optional column is missing) ----
  const loadJobs = async (): Promise<JobRow[]> => {
    const query = (cols: string) =>
      db
        .from("jobs")
        .select(cols)
        .or(`scheduled_datetime.gte.${since120},created_at.gte.${since120}`)
        .order("created_at", { ascending: false })
        .limit(JOB_LIMIT);
    let { data, error } = await query(JOB_COLUMNS);
    if (error) {
      console.warn("[ask-vireek] jobs full select failed, retrying core columns:", error.message);
      ({ data, error } = await query(JOB_COLUMNS_CORE));
      if (!error) gaps.push("Some optional job fields (rework, completion time, maintenance dates) are unavailable.");
    }
    if (error) {
      gaps.push("Jobs could not be loaded, so most answers are unavailable.");
      return [];
    }
    const rows = ((data ?? []) as Partial<JobRow>[]).map(
      (j): JobRow => ({
        id: j.id as string,
        customer_name: j.customer_name ?? "Customer",
        customer_id: j.customer_id ?? null,
        service_type: j.service_type ?? null,
        scheduled_datetime: j.scheduled_datetime ?? null,
        assigned_technician_id: j.assigned_technician_id ?? null,
        job_status: j.job_status ?? "scheduled",
        invoice_amount: j.invoice_amount === null || j.invoice_amount === undefined ? null : Number(j.invoice_amount),
        invoice_status: j.invoice_status ?? "not_sent",
        duration_minutes: j.duration_minutes ?? null,
        expected_duration_minutes: j.expected_duration_minutes ?? null,
        started_at: j.started_at ?? null,
        completed_at: j.completed_at ?? null,
        is_rework: j.is_rework ?? null,
        next_maintenance_date: j.next_maintenance_date ?? null,
        created_at: j.created_at as string,
      }),
    );
    if (rows.length >= JOB_LIMIT) gaps.push(`Job history was capped at the most recent ${JOB_LIMIT} jobs.`);
    return rows;
  };

  // ---- job_profitability (cost per job). null = view not available ----
  const loadCosts = async (): Promise<CostRow[] | null> => {
    const query = (cols: string) =>
      db.from("job_profitability").select(cols).gte("scheduled_datetime", since120).limit(5000);
    let { data, error } = await query(
      "job_id, revenue_cents, total_cost_cents, labor_cost_cents, material_cost_cents, gross_profit_cents, margin_pct, cost_entry_count",
    );
    if (error) {
      ({ data, error } = await query("job_id, revenue_cents, total_cost_cents, labor_cost_cents, material_cost_cents, gross_profit_cents, margin_pct"));
    }
    if (error) {
      gaps.push("Job cost data (job_profitability) is unavailable, so profit questions fall back to revenue.");
      return null;
    }
    return (data ?? []) as CostRow[];
  };

  const loadTimeZone = async (): Promise<string> => {
    try {
      const { data } = await db.from("business_profile").select("*").limit(1).maybeSingle();
      const tz = data?.timezone ?? data?.time_zone ?? data?.business_timezone ?? null;
      if (tz) return validTimeZone(String(tz));
    } catch {
      /* fall through to the next source */
    }
    try {
      const { data } = await db.from("on_call_schedules").select("timezone").limit(1).maybeSingle();
      if (data?.timezone) {
        gaps.push("Your business time zone is not set; the time zone from your on-call schedule was used for \"yesterday\" and \"today\".");
        return validTimeZone(String(data.timezone));
      }
    } catch {
      /* fall through */
    }
    gaps.push("Your business time zone is not set, so \"yesterday\" and \"today\" are computed in UTC.");
    return "UTC";
  };

  const techQuery = () => {
    let q = db.from("team_members").select("id, member_name, skills, max_jobs_per_day, dispatch_enabled").limit(200);
    if (ownerId) q = q.eq("account_owner_id", ownerId);
    return q;
  };

  const [jobs, costs, timeZone, techs, calls, leads, quotes, invoices, customers] = await Promise.all([
    loadJobs(),
    loadCosts(),
    loadTimeZone(),
    attempt<TechRow[]>("Technician", gaps, [], () => techQuery()),
    attempt<CallRow[]>("Call", gaps, [], () =>
      db.from("calls").select("call_datetime, status, is_emergency").gte("call_datetime", since60).limit(4000),
    ),
    attempt<LeadRow[]>("Lead", gaps, [], () =>
      db.from("leads").select("id, name, service_interested, stage, created_at").gte("created_at", since120).limit(2000),
    ),
    attempt<QuoteRow[]>("Quote", gaps, [], () =>
      db
        .from("quotes")
        .select("id, customer_name, status, sent_at, valid_until, line_items, tax_percent, created_at")
        .gte("created_at", since120)
        .limit(1000),
    ),
    attempt<InvoiceRow[]>("Invoice", gaps, [], () =>
      db
        .from("invoices")
        .select("id, customer_name, status, due_date, line_items, tax_percent, created_at")
        .gte("created_at", since180Date)
        .limit(1500),
    ),
    attempt<CustomerRow[]>("Customer", gaps, [], () =>
      db.from("customers").select("id, name, lifecycle_stage, last_contacted_at").limit(2000),
    ),
  ]);

  if (!techs.length) gaps.push("No technicians are configured, so technician and capacity answers are limited.");

  return { now, timeZone, jobs, costs, techs, calls, leads, quotes, invoices, customers, gaps: [...new Set(gaps)] };
}
