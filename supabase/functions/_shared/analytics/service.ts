// supabase/functions/_shared/analytics/service.ts
// Data access for the analytics edge functions (Deno). Every query is scoped by the VERIFIED account owner id.

import type { Admin } from "../data-platform/http.ts";
import type { RollupRow, TechCapacity, ArRow } from "./customerKpis.ts";

const PAGE = 1000;
const MAX_ROWS = 20_000;

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);

export async function loadRollups(admin: Admin, owner: string, fromDay: string, toDay: string): Promise<{ rows: RollupRow[]; truncated: boolean }> {
  const rows: RollupRow[] = [];
  for (let off = 0; off < MAX_ROWS; off += PAGE) {
    const { data, error } = await admin.from("analytics_daily_rollups").select(
      "day, technician_id, jobs_completed, jobs_reworked, rework_jobs, billed_jobs, revenue_cents, costed_jobs, costed_revenue_cents, cost_cents, scheduled_minutes, quotes_sent, quotes_accepted",
    ).eq("user_id", owner).gte("day", fromDay).lte("day", toDay).order("day").order("technician_key").range(off, off + PAGE - 1);
    if (error) throw new Error(`rollups: ${error.message}`);
    for (const r of data ?? []) {
      rows.push({
        day: r.day, technicianId: r.technician_id ?? null, jobsCompleted: n(r.jobs_completed), jobsReworked: n(r.jobs_reworked),
        reworkJobs: n(r.rework_jobs), billedJobs: n(r.billed_jobs), revenueCents: n(r.revenue_cents), costedJobs: n(r.costed_jobs),
        costedRevenueCents: n(r.costed_revenue_cents), costCents: n(r.cost_cents), scheduledMinutes: n(r.scheduled_minutes),
        quotesSent: n(r.quotes_sent), quotesAccepted: n(r.quotes_accepted),
      });
    }
    if (!data || data.length < PAGE) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

export async function loadTechs(admin: Admin, owner: string): Promise<{ capacity: TechCapacity[]; names: { id: string; name: string }[] }> {
  const { data, error } = await admin.rpc("analytics_tech_capacity", { p_owner: owner });
  if (error) throw new Error(`techs: ${error.message}`);
  const list = (data ?? []) as { technician_id: string; technician_name: string; working_days: number[] }[];
  return {
    capacity: list.map((t) => ({ technicianId: t.technician_id, workingDays: t.working_days ?? [] })),
    names: list.map((t) => ({ id: t.technician_id, name: t.technician_name })),
  };
}

export async function loadAr(admin: Admin, owner: string): Promise<ArRow[]> {
  const { data, error } = await admin.rpc("analytics_ar_open_invoices", { p_owner: owner });
  if (error) throw new Error(`ar: ${error.message}`);
  return ((data ?? []) as { due_date: string | null; balance_cents: number }[]).map((r) => ({ dueDate: r.due_date, balanceCents: n(r.balance_cents) }));
}

export interface Settings { hoursPerDay: number; digestEnabled: boolean; digestCadence: "weekly" | "monthly"; alertsEnabled: boolean }
export const DEFAULT_SETTINGS: Settings = { hoursPerDay: 8, digestEnabled: false, digestCadence: "weekly", alertsEnabled: false };

export async function loadSettings(admin: Admin, owner: string): Promise<Settings> {
  const { data } = await admin.from("analytics_settings").select("hours_per_day, digest_enabled, digest_cadence, alerts_enabled").eq("user_id", owner).maybeSingle();
  if (!data) return DEFAULT_SETTINGS;
  return { hoursPerDay: n(data.hours_per_day) || 8, digestEnabled: !!data.digest_enabled, digestCadence: data.digest_cadence === "monthly" ? "monthly" : "weekly", alertsEnabled: !!data.alerts_enabled };
}

/** First view after the flag is enabled: build 90 days so the dashboard is never empty by accident. */
export async function ensureRollups(admin: Admin, owner: string, today: string): Promise<void> {
  const { count } = await admin.from("analytics_daily_rollups").select("day", { count: "exact", head: true }).eq("user_id", owner);
  if ((count ?? 0) > 0) return;
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - 90 * 86_400_000).toISOString().slice(0, 10);
  const { error } = await admin.rpc("analytics_refresh_rollups", { p_owner: owner, p_from: from, p_to: today });
  if (error) throw new Error(`backfill: ${error.message}`);
}
