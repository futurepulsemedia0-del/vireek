// supabase/functions/economics-sweep/index.ts
//
// Scheduled (e.g. hourly) economics alerts. Writes deduped rows to economics_alerts (staff-visible only):
//  - cost_per_call_spike      today's measured micro-USD/call vs the trailing median
//  - reconciliation_variance  last full month: ledger vs entered provider invoices over threshold
//  - missing_correlation      share of ledger events with no correlation id below the minimum
// Auth: service-role key as Bearer (same as check-cost-guardrails). Never touches call handling.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { detectCostSpike, correlationShortfall } from "../_shared/economics/anomaly.ts";

const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!key || req.headers.get("Authorization") !== `Bearer ${key}`) return json({ error: "Unauthorized" }, 401);
  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", key, { auth: { persistSession: false } });

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const alerts: { kind: string; severity: string; dedupe_key: string; details: unknown }[] = [];

  try {
    // 1) cost-per-call spike
    const { data: daily, error: dErr } = await admin.rpc("economics_daily_cost_per_call", { p_days: 30 });
    if (dErr) throw dErr;
    const days = (daily ?? []) as { day: string; calls_with_cost: number; micro_per_call: number }[];
    const todayRow = days.find((d) => d.day === today);
    const hist = days.filter((d) => d.day < today && Number(d.calls_with_cost) >= 5).map((d) => Number(d.micro_per_call));
    const spike = detectCostSpike(hist, todayRow && Number(todayRow.calls_with_cost) >= 5 ? Number(todayRow.micro_per_call) : null);
    if (spike.spike) alerts.push({ kind: "cost_per_call_spike", severity: "warning", dedupe_key: `spike:${today}`, details: { todayMicro: todayRow?.micro_per_call, ...spike } });

    // 2) reconciliation variance for the previous full month
    const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 10);
    const { data: rec, error: rErr } = await admin.rpc("economics_reconciliation_core", { p_month: prev });
    if (rErr) throw rErr;
    for (const r of (rec ?? []) as { provider: string; status: string; variance_pct: number | null; variance_micro: number | null }[]) {
      if (r.status === "over_threshold") alerts.push({ kind: "reconciliation_variance", severity: "critical", dedupe_key: `recon:${prev}:${r.provider}`, details: r });
    }

    // 3) correlation coverage over the last 24h
    const start = new Date(now.getTime() - 24 * 3600_000).toISOString();
    const { data: cov, error: cErr } = await admin.rpc("economics_coverage_core", { p_start: start, p_end: now.toISOString() });
    if (cErr) throw cErr;
    const rows = (cov ?? []) as { events: number; with_correlation: number }[];
    const total = rows.reduce((s, r) => s + Number(r.events), 0);
    const withC = rows.reduce((s, r) => s + Number(r.with_correlation), 0);
    const sf = correlationShortfall(withC, total, 90);
    if (total >= 20 && sf.alert) alerts.push({ kind: "missing_correlation", severity: "warning", dedupe_key: `corr:${today}`, details: { events: total, withCorrelation: withC, pct: sf.pct } });

    let inserted = 0;
    for (const a of alerts) {
      const { error } = await admin.from("economics_alerts").upsert(a, { onConflict: "dedupe_key", ignoreDuplicates: true });
      if (error) console.error("[economics-sweep] alert not stored:", error.message); else inserted++;
    }
    console.warn("[economics-sweep]", JSON.stringify({ evaluated: true, alerts: alerts.length, spike: spike.reason }));
    return json({ ok: true, alerts: alerts.length, stored: inserted, spike: spike.reason, correlationPct: sf.pct });
  } catch (e) {
    console.error("[economics-sweep] failed:", e);
    return json({ ok: false, error: "sweep_failed" }, 500);
  }
});
