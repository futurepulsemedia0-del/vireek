// supabase/functions/fraud-sweep/index.ts
//
// Cron-driven. Body {"task":"sweep"} (every 5 minutes) detects anomalies and throttles/suspends;
// {"task":"weekly_report"} (Mondays) builds and routes the weekly report.
// Requires header X-Cron-Secret = CRON_SECRET (FAILS CLOSED when CRON_SECRET is unset).
//
// Schedule (Dashboard > Edge Functions > Cron, or pg_cron + pg_net like enforce-payment-suspension):
//   */5 * * * *   {"task":"sweep"}
//   0 14 * * 1    {"task":"weekly_report"}

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { detectAnomalies, type CallEvent } from "../_shared/fraud/anomaly.ts";
import { effectiveCaps, normalizePlan } from "../_shared/fraud/planLimits.ts";
import { applyOrgStatus } from "../_shared/fraud/enforcement.ts";
import { routeFraudAlert } from "../_shared/fraud/alerts.ts";
import { buildWeeklyReport } from "../_shared/fraud/report.ts";

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
const HOUR = 3_600_000;

Deno.serve(async (req: Request) => {
  const secret = Deno.env.get("CRON_SECRET");
  if (!secret || req.headers.get("X-Cron-Secret") !== secret) return json({ error: "Unauthorized" }, 401);
  const body = (await req.json().catch(() => ({}))) as { task?: string };
  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

  try {
    if (body.task === "weekly_report") return json(await weekly(admin));
    return json(await sweep(admin));
  } catch (e) {
    console.error(JSON.stringify({ event: "fraud_sweep_failed", error: e instanceof Error ? e.message : String(e) }));
    return json({ error: "sweep_failed" }, 500);
  }
});

// deno-lint-ignore no-explicit-any
async function sweep(admin: any) {
  const now = Date.now();
  const since = new Date(now - HOUR).toISOString();
  const { data: recent, error } = await admin.from("fraud_call_events").select("user_id, at, country, international, prefix, cost_cents, duration_seconds").gte("at", since).limit(20000);
  if (error) throw new Error(error.message);
  const byUser = new Map<string, CallEvent[]>();
  for (const r of recent ?? []) {
    const list = byUser.get(r.user_id) ?? [];
    list.push({ at: Date.parse(r.at), country: r.country, international: r.international, durationSeconds: r.duration_seconds, prefix: r.prefix, costCents: r.cost_cents });
    byUser.set(r.user_id, list);
  }

  let flagged = 0, throttled = 0, suspended = 0;
  for (const [userId, events] of byUser) {
    const { data: ctx } = await admin.rpc("fraud_guard_context", { p_user: userId });
    const { data: org } = await admin.from("fraud_org_state").select("tz_offset_minutes").eq("user_id", userId).maybeSingle();
    if (!ctx) continue;
    const { data: hist } = await admin.from("fraud_call_events").select("international").eq("user_id", userId).lt("at", since).gte("at", new Date(now - 30 * 86_400_000).toISOString()).limit(5000);
    const total = hist?.length ?? 0;
    const intl = (hist ?? []).filter((h: { international: boolean }) => h.international).length;
    const caps = effectiveCaps(normalizePlan(ctx.plan), Number(ctx.account_age_days));

    const result = detectAnomalies({ now, events, tzOffsetMinutes: org?.tz_offset_minutes ?? 0, dailyCostCap: caps.dailyCostCents, baselineInternationalShare: total ? intl / total : 0 });
    if (!result.action) continue;
    flagged++;
    await admin.from("fraud_events").insert({ user_id: userId, kind: "anomaly", code: result.action.toUpperCase(), source: "fraud-sweep", detail: { signals: result.signals } });

    const reason = result.signals.map((s) => s.detail).join("; ");
    if (result.action === "suspend" && ctx.status !== "suspended") {
      await applyOrgStatus(admin, { userId, status: "suspended", reason, source: "fraud-sweep", severity: "high", signals: result.signals });
      suspended++;
      await routeFraudAlert(admin, "page", `Account auto-suspended ${userId}`, reason);
    } else if (result.action === "throttle" && ctx.status === "active") {
      await applyOrgStatus(admin, { userId, status: "throttled", reason, until: new Date(now + 24 * HOUR), source: "fraud-sweep", severity: "medium", signals: result.signals });
      throttled++;
      await routeFraudAlert(admin, "warn", `Account throttled ${userId}`, reason);
    }
  }
  return { checkedAccounts: byUser.size, flagged, throttled, suspended };
}

// deno-lint-ignore no-explicit-any
async function weekly(admin: any) {
  const to = new Date();
  const from = new Date(to.getTime() - 7 * 86_400_000);
  const q = (kind: string) => admin.from("fraud_events").select("code, country").eq("kind", kind).gte("created_at", from.toISOString()).limit(50000);
  const [denied, anomalies, otp, signup, changes, cases, susp, usage] = await Promise.all([
    q("denied"), q("anomaly"), q("otp_blocked"), q("signup_blocked"), q("status_change"),
    admin.from("fraud_cases").select("id", { count: "exact", head: true }).neq("status", "resolved"),
    admin.from("fraud_org_state").select("user_id", { count: "exact", head: true }).eq("status", "suspended"),
    admin.from("fraud_call_events").select("cost_cents").gte("at", from.toISOString()).limit(100000),
  ]);
  const text = buildWeeklyReport({
    from: from.toISOString(), to: to.toISOString(), denied: denied.data ?? [], anomalies: anomalies.data ?? [],
    otpBlocked: (otp.data ?? []).length, signupBlocked: (signup.data ?? []).length, statusChanges: changes.data ?? [],
    openCases: cases.count ?? 0, suspendedOrgs: susp.count ?? 0,
    reservedCents: (usage.data ?? []).reduce((s: number, r: { cost_cents: number }) => s + r.cost_cents, 0),
  });
  const res = await routeFraudAlert(admin, "info", "Weekly fraud & abuse report", text);
  return { delivered: res.delivered, failed: res.failed };
}
