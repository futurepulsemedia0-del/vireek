// supabase/functions/business-immune-scan/index.ts
//
// Business Immune System — deterministic anomaly scanner.
//
// Runs on a schedule (external cron, --no-verify-jwt, service role).
// For every account: computes a trailing baseline from that account's
// own history for each category, compares it against the last 24h,
// and opens/updates a business_immune_signals row when the deviation
// crosses a threshold (scaled by the account's chosen sensitivity).
//
// Deliberately deterministic — no AI call. Same idiom as
// check-margin-guardrail: a threshold is a number, and the verdict
// must be reproducible and explainable.

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendSms } from "../_shared/notify/deliver.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const SENSITIVITY_MULTIPLIER: Record<string, number> = { low: 1.5, standard: 1.0, high: 0.65 };

interface DetectorResult {
  detector: string;
  category: string;
  severity_score: number;
  title: string;
  detail: string;
  metric_snapshot: Record<string, unknown>;
  recommended_actions: string[];
}

function clampScore(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// ---------------------------------------------------------------
// Detector 1 — revenue_shock: booking volume collapse
// ---------------------------------------------------------------
async function detectRevenueShock(admin: SupabaseClient, userId: string, mult: number): Promise<DetectorResult | null> {
  const since = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
  const { data } = await admin.from("jobs").select("created_at").eq("user_id", userId).gte("created_at", since);
  if (!data || data.length < 21) return null; // not enough history to trust a baseline

  const today = startOfToday();
  const last24h = data.filter((j) => new Date(j.created_at as string) >= today).length;
  const priorDays = data.filter((j) => new Date(j.created_at as string) < today);
  const baselinePerDay = priorDays.length / 14;
  if (baselinePerDay < 2) return null; // too small an account for this detector to be meaningful

  const threshold = baselinePerDay * 0.4 * mult;
  if (last24h >= threshold) return null;

  const ratio = baselinePerDay > 0 ? last24h / baselinePerDay : 0;
  const severity = clampScore(90 - ratio * 90);

  return {
    detector: "booking_collapse",
    category: "revenue_shock",
    severity_score: severity,
    title: "Booking volume has collapsed",
    detail: `${last24h} new jobs in the last 24h vs a ${baselinePerDay.toFixed(1)}/day baseline — a ${Math.round((1 - ratio) * 100)}% drop.`,
    metric_snapshot: { last24h, baseline_per_day: Number(baselinePerDay.toFixed(2)) },
    recommended_actions: [
      "Check whether your phone lines, booking widget, or ad campaigns are actually running.",
      "Confirm the AI receptionist / call routing hasn't silently failed.",
      "Review recent marketing spend changes or seasonal factors before assuming something is broken.",
    ],
  };
}

// ---------------------------------------------------------------
// Detector 2 — reputation_threat: negative sentiment / critical
// service-recovery pileup
// ---------------------------------------------------------------
async function detectReputationThreat(admin: SupabaseClient, userId: string, mult: number): Promise<DetectorResult | null> {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const since15d = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();

  const { data: recentCalls } = await admin.from("calls").select("sentiment, call_datetime").eq("user_id", userId).gte("call_datetime", since15d);
  const { count: criticalOpen } = await admin
    .from("service_recovery_signals")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("severity_score", 85)
    .in("status", ["open", "playbook_enrolled", "escalated"])
    .gte("detected_at", since24h);

  const criticalThreshold = Math.ceil(3 * mult);

  if (!recentCalls || recentCalls.length < 14) {
    if ((criticalOpen ?? 0) >= criticalThreshold) {
      return {
        detector: "critical_recovery_pileup",
        category: "reputation_threat",
        severity_score: 80,
        title: "Multiple critical service-recovery signals are unresolved",
        detail: `${criticalOpen} critical, unresolved service-recovery signal(s) in the last 24 hours.`,
        metric_snapshot: { critical_open_24h: criticalOpen },
        recommended_actions: [
          "Open Service Recovery and work the critical queue first.",
          "Consider a personal call from the owner for the highest-value accounts.",
        ],
      };
    }
    return null;
  }

  const today = startOfToday();
  const last24 = recentCalls.filter((c) => new Date(c.call_datetime as string) >= today);
  const prior = recentCalls.filter((c) => new Date(c.call_datetime as string) < today);
  const negRate = (arr: typeof recentCalls) => (arr.length ? arr.filter((c) => c.sentiment === "negative").length / arr.length : 0);
  const todayRate = negRate(last24);
  const baselineRate = negRate(prior) || 0.05;
  const spiked = last24.length >= 3 && todayRate >= baselineRate * (2.5 * mult);

  if (!spiked && (criticalOpen ?? 0) < criticalThreshold) return null;

  const severity = clampScore(50 + todayRate * 100 + (criticalOpen ?? 0) * 8);
  return {
    detector: "negative_sentiment_spike",
    category: "reputation_threat",
    severity_score: severity,
    title: "Negative call sentiment is spiking",
    detail: `${Math.round(todayRate * 100)}% of today's calls came back negative vs a ${Math.round(baselineRate * 100)}% baseline, with ${criticalOpen ?? 0} critical service-recovery signal(s) still open.`,
    metric_snapshot: { today_negative_rate: Number(todayRate.toFixed(2)), baseline_negative_rate: Number(baselineRate.toFixed(2)), critical_open_24h: criticalOpen },
    recommended_actions: [
      "Review the negative-sentiment calls in Call Intelligence for a common root cause.",
      "Work the Service Recovery queue before it becomes public reviews.",
    ],
  };
}

// ---------------------------------------------------------------
// Detector 3 — operational_overload: missed-call surge
// ---------------------------------------------------------------
async function detectOperationalOverload(admin: SupabaseClient, userId: string, mult: number): Promise<DetectorResult | null> {
  const since15d = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
  const { data } = await admin.from("calls").select("status, call_datetime").eq("user_id", userId).gte("call_datetime", since15d);
  if (!data || data.length < 14) return null;

  const today = startOfToday();
  const last24 = data.filter((c) => new Date(c.call_datetime as string) >= today);
  const prior = data.filter((c) => new Date(c.call_datetime as string) < today);
  const missedRate = (arr: typeof data) => (arr.length ? arr.filter((c) => c.status === "missed").length / arr.length : 0);
  const todayRate = missedRate(last24);
  const baselineRate = missedRate(prior) || 0.05;

  if (last24.length < 5 || todayRate < baselineRate * (2 * mult) || todayRate < 0.15) return null;

  const severity = clampScore(45 + todayRate * 100);
  return {
    detector: "missed_call_surge",
    category: "operational_overload",
    severity_score: severity,
    title: "Missed-call rate is surging",
    detail: `${Math.round(todayRate * 100)}% of today's calls were missed vs a ${Math.round(baselineRate * 100)}% baseline (${last24.length} calls today).`,
    metric_snapshot: { today_missed_rate: Number(todayRate.toFixed(2)), baseline_missed_rate: Number(baselineRate.toFixed(2)), calls_today: last24.length },
    recommended_actions: [
      "Check technician and staffing capacity for today.",
      "Confirm the AI receptionist / call routing is actually answering.",
      "Consider activating Surge Mode or after-hours coverage.",
    ],
  };
}

// ---------------------------------------------------------------
// Detector 4 — financial_irregularity: margin-floor override spike
// ---------------------------------------------------------------
async function detectFinancialIrregularity(admin: SupabaseClient, userId: string, mult: number): Promise<DetectorResult | null> {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const since15d = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
  const { data } = await admin.from("margin_guardrail_checks").select("verdict, created_at").eq("user_id", userId).gte("created_at", since15d);
  if (!data || data.length < 10) return null;

  const last24 = data.filter((c) => (c.created_at as string) >= since24h);
  const overridden = last24.filter((c) => c.verdict === "overridden").length;
  const blocked = last24.filter((c) => c.verdict === "blocked").length;
  const baselineOverridePerDay = data.filter((c) => c.verdict === "overridden").length / 15;

  if (overridden < Math.ceil(2 * mult) || overridden < baselineOverridePerDay * 3) return null;

  const severity = clampScore(55 + overridden * 8);
  return {
    detector: "margin_override_spike",
    category: "financial_irregularity",
    severity_score: severity,
    title: "Margin floor is being overridden repeatedly",
    detail: `${overridden} quote(s) sent below the margin floor with an override in the last 24h (baseline ${baselineOverridePerDay.toFixed(1)}/day), plus ${blocked} blocked attempt(s).`,
    metric_snapshot: { overridden_24h: overridden, blocked_24h: blocked, baseline_overridden_per_day: Number(baselineOverridePerDay.toFixed(2)) },
    recommended_actions: [
      "Review who is issuing the overrides and why.",
      "Consider tightening who has override permission in Settings.",
      "Check whether pricing itself needs adjusting rather than repeated overrides.",
    ],
  };
}

// ---------------------------------------------------------------
// Detector 5 — integration_failure: a connection is in `error`
// ---------------------------------------------------------------
async function detectIntegrationFailure(admin: SupabaseClient, userId: string): Promise<DetectorResult[]> {
  const { data } = await admin.from("integrations").select("id, integration_type, status").eq("user_id", userId).eq("status", "error");
  if (!data || data.length === 0) return [];
  return data.map((row) => ({
    detector: `integration_error_${row.id}`,
    category: "integration_failure",
    severity_score: 70,
    title: `${row.integration_type} integration is in an error state`,
    detail: `The ${row.integration_type} connection is reporting an error and may be silently failing to sync data.`,
    metric_snapshot: { integration_id: row.id, integration_type: row.integration_type },
    recommended_actions: [
      `Reconnect ${row.integration_type} from Integrations settings.`,
      "Check for any data created since it failed that may need a manual re-sync.",
    ],
  }));
}

// ---------------------------------------------------------------
// Persistence + notification
// ---------------------------------------------------------------
async function upsertSignal(admin: SupabaseClient, userId: string, r: DetectorResult): Promise<{ id: string; isNew: boolean } | null> {
  const { data: existing } = await admin
    .from("business_immune_signals")
    .select("id")
    .eq("user_id", userId)
    .eq("detector", r.detector)
    .eq("status", "active")
    .maybeSingle();
  if (existing) return { id: existing.id as string, isNew: false };

  const { data: inserted, error } = await admin
    .from("business_immune_signals")
    .insert({
      user_id: userId,
      category: r.category,
      detector: r.detector,
      severity_score: r.severity_score,
      title: r.title,
      detail: r.detail,
      metric_snapshot: r.metric_snapshot,
      recommended_actions: r.recommended_actions,
    })
    .select("id")
    .single();
  if (error || !inserted) return null;
  return { id: inserted.id as string, isNew: true };
}

async function notify(
  admin: SupabaseClient,
  userId: string,
  signalId: string,
  r: DetectorResult,
  settings: { notify_critical_via_sms: boolean } | null,
): Promise<void> {
  const { data: profile } = await admin.from("profiles").select("company_name, escalation_enabled, escalation_phone").eq("id", userId).maybeSingle();

  await admin.from("notifications").insert({
    user_id: userId,
    type: "business_immune_signal",
    title: `${r.severity_score >= 85 ? "🔴 " : ""}Immune alert: ${r.title}`,
    message: r.detail,
    action_url: "/dashboard/immune-system",
    business_immune_signal_id: signalId,
  });
  await admin.from("business_immune_actions").insert({
    user_id: userId,
    signal_id: signalId,
    action_type: "notified_owner",
    actor: "system",
    detail: "In-app notification created",
  });

  if (r.severity_score >= 85 && (settings?.notify_critical_via_sms ?? true) && profile?.escalation_enabled && profile?.escalation_phone) {
    const res = await sendSms(profile.escalation_phone, `⚠️ ${profile.company_name ?? "Your business"}: ${r.title}. ${r.detail}`);
    await admin.from("business_immune_actions").insert({
      user_id: userId,
      signal_id: signalId,
      action_type: "paged_owner_sms",
      actor: "system",
      detail: res.ok ? "SMS sent" : `SMS failed: ${res.error}`,
    });
  }

  await admin.rpc("append_activity_event", {
    p_aggregate_type: "business_immune_signal",
    p_aggregate_id: signalId,
    p_event_type: "immune.signal_detected",
    p_event_data: { category: r.category, detector: r.detector, severity_score: r.severity_score, title: r.title },
    p_actor_type: "system",
    p_user_id: userId,
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

    const { data: settingsRows } = await admin
      .from("business_immune_settings")
      .select("user_id, enabled, sensitivity, notify_critical_via_sms, muted_categories");
    const { data: profiles } = await admin.from("profiles").select("id");
    const settingsByUser = new Map((settingsRows ?? []).map((s) => [s.user_id as string, s]));

    let scanned = 0;
    let created = 0;

    for (const p of profiles ?? []) {
      const userId = p.id as string;
      const settings = settingsByUser.get(userId) ?? null;
      if (settings && settings.enabled === false) continue;

      const mult = SENSITIVITY_MULTIPLIER[settings?.sensitivity ?? "standard"] ?? 1.0;
      const muted = new Set<string>(settings?.muted_categories ?? []);
      scanned++;

      const [rev, rep, ops, fin, integ] = await Promise.all([
        detectRevenueShock(admin, userId, mult),
        detectReputationThreat(admin, userId, mult),
        detectOperationalOverload(admin, userId, mult),
        detectFinancialIrregularity(admin, userId, mult),
        detectIntegrationFailure(admin, userId),
      ]);

      const results: DetectorResult[] = [rev, rep, ops, fin].filter((r): r is DetectorResult => r !== null);
      results.push(...integ);

      for (const r of results) {
        if (muted.has(r.category)) continue;
        const outcome = await upsertSignal(admin, userId, r);
        if (outcome?.isNew) {
          created++;
          await notify(admin, userId, outcome.id, r, settings);
        }
      }
    }

    return new Response(JSON.stringify({ scanned, created }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
