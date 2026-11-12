// supabase/functions/check-cost-guardrails/index.ts
//
// Scheduled sweep (e.g. hourly). Replaces check-usage-alert: UNSCHEDULE that one or owners get duplicate alerts.
// - Owner alerts: ONLY about included minutes (80/90/100%), deduped per month. No internal cost is ever shown to customers.
// - Cost limit breaches (soft/hard) are reported in the response + logs for staff. Hard limits are NOT enforced here.
// Auth: caller must present the service-role key as Bearer (same as the cron example in enforce-payment-suspension).

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { evaluateGuardrail, type GuardrailLimits } from "../_shared/billing/costGuardrail.ts";

const PAGE = 1000;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!serviceKey || req.headers.get("Authorization") !== `Bearer ${serviceKey}`) return json({ error: "Unauthorized" }, 401);

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", serviceKey, { auth: { persistSession: false } });

  try {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const monthKey = monthStart.toISOString().slice(0, 7);

    const { data: limitRows, error: limitErr } = await admin
      .from("plan_cost_limits")
      .select("plan, soft_cost_usd, hard_cost_usd, max_call_seconds");
    if (limitErr) throw limitErr;
    const limitsByPlan = new Map<string, GuardrailLimits>();
    for (const r of limitRows ?? []) {
      limitsByPlan.set(String(r.plan), {
        softCostUsd: r.soft_cost_usd == null ? null : Number(r.soft_cost_usd),
        hardCostUsd: r.hard_cost_usd == null ? null : Number(r.hard_cost_usd),
        maxCallSeconds: r.max_call_seconds == null ? null : Number(r.max_call_seconds),
      });
    }

    const { data: costRows, error: costErr } = await admin.rpc("tenant_month_provider_cost", { p_month_start: monthStart.toISOString() });
    if (costErr) throw costErr;
    const costByUser = new Map<string, number>();
    for (const r of (costRows ?? []) as { user_id: string; cost_usd: number }[]) costByUser.set(r.user_id, Number(r.cost_usd) || 0);

    let checked = 0, alertsCreated = 0, alertFailures = 0;
    const staffFlags: { account_id: string; plan: string | null; level: string; action: string }[] = [];

    for (let from = 0; ; from += PAGE) {
      const { data: page, error } = await admin
        .from("profiles")
        .select("id, plan, minutes_used_this_month, minutes_included")
        .eq("role", "owner")
        .order("id")
        .range(from, from + PAGE - 1);
      if (error) throw error;
      if (!page || page.length === 0) break;

      for (const p of page) {
        checked++;
        const res = evaluateGuardrail({
          usedMinutes: Number(p.minutes_used_this_month) || 0,
          includedMinutes: Number(p.minutes_included) || 0,
          monthCostUsd: costByUser.get(p.id) ?? 0,
          limits: limitsByPlan.get(String(p.plan ?? "")) ?? null,
          isEmergency: false, // account-level sweep; per-call emergency exemption is enforced where calls are handled
        });

        if (res.level !== "ok") staffFlags.push({ account_id: p.id, plan: p.plan ?? null, level: res.level, action: res.action });

        // Owner minutes alerts (80/100%) now live in check-usage-alert (usage_alert_events ledger, email/SMS/push).
      }
      if (page.length < PAGE) break;
    }

    // Monthly reconciliation drift (staff flag only): last month's provider-reported voice cost vs the entered Vapi invoice.
    const prevStart = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() - 1, 1));
    const { data: prevCosts } = await admin.rpc("tenant_month_provider_cost", { p_month_start: prevStart.toISOString() });
    const prevReported = ((prevCosts ?? []) as { cost_usd: number }[]).reduce((s, r) => s + (Number(r.cost_usd) || 0), 0);
    const { data: prevInvoices } = await admin.from("provider_invoices").select("invoiced_usd")
      .eq("period_month", prevStart.toISOString().slice(0, 10)).ilike("provider", "vapi");
    const invoicedTotal = (prevInvoices ?? []).reduce((s: number, r: { invoiced_usd: number }) => s + Number(r.invoiced_usd), 0);
    const driftPct = invoicedTotal > 0 ? ((prevReported - invoicedTotal) / invoicedTotal) * 100 : null;
    const reconciliationDrift = driftPct !== null && Math.abs(driftPct) > 5
      ? { month: prevStart.toISOString().slice(0, 7), reported_usd: prevReported, invoiced_usd: invoicedTotal, drift_pct: driftPct }
      : null;
    if (reconciliationDrift) console.warn("[cost-guardrails] invoice drift over 5%:", JSON.stringify(reconciliationDrift));
    if (staffFlags.length) console.warn(`[cost-guardrails] ${staffFlags.length} accounts over a cost limit`);
    return json({ checked, alerts_created: alertsCreated, alert_failures: alertFailures, staff_flags: staffFlags, reconciliation_drift: reconciliationDrift });
  } catch (err) {
    console.error("check-cost-guardrails failed:", err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
