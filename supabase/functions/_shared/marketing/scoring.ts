// supabase/functions/_shared/marketing/scoring.ts
//
// Simple, explainable point-based lead scoring (0-100, capped). Every
// factor is stored in `factors` jsonb so the dashboard can show *why* a
// lead scored the way it did instead of a black-box number.

import { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";

export interface ScoreResult {
  score: number;
  grade: "cold" | "warm" | "hot";
  factors: Record<string, number>;
}

function gradeFor(score: number): ScoreResult["grade"] {
  if (score >= 70) return "hot";
  if (score >= 35) return "warm";
  return "cold";
}

function daysSince(iso: string | null): number {
  if (!iso) return 9999;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

// Scores every lead + customer for one account. Called from
// marketing-engine-tick, once per user per run.
export async function scoreAccount(admin: SupabaseClient, userId: string): Promise<number> {
  const [{ data: leads }, { data: customers }, { data: calls }, { data: jobs }, { data: quotes }] = await Promise.all([
    admin.from("leads").select("id, stage, created_at").eq("user_id", userId),
    admin.from("customers").select("id, lifecycle_stage, last_contacted_at, created_at").eq("user_id", userId),
    admin.from("calls").select("id, lead_id").eq("user_id", userId),
    admin.from("jobs").select("id, customer_id, lead_id, invoice_amount, invoice_status").eq("user_id", userId),
    admin.from("quotes").select("id, customer_id, status").eq("user_id", userId).then((r) => r).catch(() => ({ data: [] as { id: string; customer_id: string; status: string }[] })),
  ]);

  const callsByLead = new Map<string, number>();
  for (const c of calls ?? []) {
    if (!c.lead_id) continue;
    callsByLead.set(c.lead_id, (callsByLead.get(c.lead_id) ?? 0) + 1);
  }

  const jobsByCustomer = new Map<string, { count: number; paidTotal: number }>();
  const jobsByLead = new Map<string, number>();
  for (const j of jobs ?? []) {
    if (j.customer_id) {
      const cur = jobsByCustomer.get(j.customer_id) ?? { count: 0, paidTotal: 0 };
      cur.count += 1;
      if (j.invoice_status === "paid") cur.paidTotal += Number(j.invoice_amount ?? 0);
      jobsByCustomer.set(j.customer_id, cur);
    }
    if (j.lead_id) jobsByLead.set(j.lead_id, (jobsByLead.get(j.lead_id) ?? 0) + 1);
  }

  const openQuotesByCustomer = new Map<string, number>();
  for (const q of quotes ?? []) {
    if (q.status && q.status !== "won" && q.status !== "lost") {
      openQuotesByCustomer.set(q.customer_id, (openQuotesByCustomer.get(q.customer_id) ?? 0) + 1);
    }
  }

  const rows: { user_id: string; lead_id?: string; customer_id?: string; score: number; grade: string; factors: Record<string, number>; updated_at: string }[] = [];

  for (const lead of leads ?? []) {
    const factors: Record<string, number> = {};
    factors.stage_bonus = lead.stage === "quoted" ? 25 : lead.stage === "contacted" ? 10 : 0;
    factors.calls = Math.min((callsByLead.get(lead.id) ?? 0) * 10, 30);
    factors.jobs_started = (jobsByLead.get(lead.id) ?? 0) > 0 ? 20 : 0;
    const age = daysSince(lead.created_at);
    factors.recency = age <= 3 ? 15 : age <= 14 ? 5 : 0;
    const score = Math.max(0, Math.min(100, Object.values(factors).reduce((a, b) => a + b, 0)));
    rows.push({ user_id: userId, lead_id: lead.id, score, grade: gradeFor(score), factors, updated_at: new Date().toISOString() });
  }

  for (const customer of customers ?? []) {
    const factors: Record<string, number> = {};
    const jobInfo = jobsByCustomer.get(customer.id) ?? { count: 0, paidTotal: 0 };
    factors.lifecycle_bonus =
      customer.lifecycle_stage === "vip" ? 30 : customer.lifecycle_stage === "active" ? 15 : 0;
    factors.repeat_jobs = Math.min(jobInfo.count * 8, 24);
    factors.lifetime_value = Math.min(Math.floor(jobInfo.paidTotal / 100), 20);
    factors.open_quote = (openQuotesByCustomer.get(customer.id) ?? 0) > 0 ? 15 : 0;
    const inactiveDays = daysSince(customer.last_contacted_at ?? customer.created_at);
    factors.engagement_penalty = inactiveDays > 180 ? -20 : inactiveDays > 90 ? -10 : 0;
    const score = Math.max(0, Math.min(100, Object.values(factors).reduce((a, b) => a + b, 0)));
    rows.push({ user_id: userId, customer_id: customer.id, score, grade: gradeFor(score), factors, updated_at: new Date().toISOString() });
  }

  if (rows.length === 0) return 0;

  // customer_id and lead_id rows share one table but sit behind two
  // different partial unique indexes, so each group must be upserted
  // against its own conflict target — mixing them in one call would
  // insert fresh duplicate rows for whichever group isn't the target.
  const customerRows = rows.filter((r) => r.customer_id);
  const leadRows = rows.filter((r) => r.lead_id);

  if (customerRows.length) {
    const { error } = await admin.from("lead_scores").upsert(customerRows, { onConflict: "customer_id" });
    if (error) throw error;
  }
  if (leadRows.length) {
    const { error } = await admin.from("lead_scores").upsert(leadRows, { onConflict: "lead_id" });
    if (error) throw error;
  }
  return rows.length;
}
