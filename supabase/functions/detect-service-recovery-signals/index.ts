// supabase/functions/detect-service-recovery-signals/index.ts
//
// Service Recovery & Complaint Prevention Agent — detection half.
//
// Cron-driven scanner, same shape as estimate-recovery-agent: reads real
// columns that already exist in this project (jobs.eta_minutes/eta_set_at,
// promises.due_at/status, calls.sentiment, review_requests.rating) and
// opens a service_recovery_signals row for anything that looks like it's
// about to turn into a bad review or a lost customer. Nothing here calls
// an LLM or invents data — same "AI only reasons over real numbers"
// philosophy as business-decision-engine.
//
// IMPORTANT DIFFERENCE from estimate-recovery-agent's upsert-and-always-
// enroll pattern: that function re-fires its workflow enrollment on every
// cron tick for as long as a risk stays open, which would mean re-sending
// an apology text every 15–30 minutes here. Instead this function inserts
// with plain `.insert()` and only notifies/enrolls a workflow when the
// insert actually succeeds (a 23505 unique-violation means the signal was
// already raised, so it's silently skipped) — one signal, one notification,
// one workflow run, ever, per underlying record.
//
// DEPLOYMENT: supabase functions deploy detect-service-recovery-signals
// --no-verify-jwt, then point cron at it every 15-30 minutes with the same
// X-Cron-Secret / CRON_SECRET header already used by workflow-engine-executor.

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendSms } from "../_shared/notify/deliver.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Cron-Secret",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

const ETA_GRACE_MINUTES = 10; // don't flag until this far past the promised ETA
type Severity = "low" | "medium" | "high" | "critical";
type Channel = "sms" | "email" | "call";

interface SignalRow {
  user_id: string;
  job_id?: string | null;
  call_id?: string | null;
  promise_id?: string | null;
  review_request_id?: string | null;
  customer_id?: string | null;
  customer_name: string;
  customer_phone: string | null;
  customer_email?: string | null;
  signal_type: string;
  source_table: "jobs" | "calls" | "promises" | "review_requests";
  source_id: string;
  severity: Severity;
  signal_excerpt: string;
  recommended_channel: Channel;
  recommended_message: string;
}

function severityForMinutesLate(minutesLate: number): Severity {
  if (minutesLate >= 60) return "critical";
  if (minutesLate >= 30) return "high";
  return "medium";
}

// Inserts the signal; returns the new row's id if (and only if) this is a
// brand-new signal, or null if it already existed / failed for another
// reason (logged, never thrown — one bad row should never stop the scan).
async function insertSignal(admin: SupabaseClient, row: SignalRow): Promise<string | null> {
  const { data, error } = await admin.from("service_recovery_signals").insert(row).select("id").single();
  if (error) {
    if (error.code !== "23505") console.error(`insert failed (${row.signal_type}/${row.source_id}):`, error.message);
    return null;
  }
  return data?.id ?? null;
}

// FIX: this now receives the fully-built `SignalRow` (the same object that
// was inserted), not the raw jobs/calls/promises/review_requests record —
// the raw record has neither `severity`/`signal_excerpt`/`recommended_message`
// nor a consistent `customer_name`/`customer_phone` (calls uses
// `caller_name`/`caller_phone`), so every field read below used to be
// `undefined`: notifications silently failed to insert (NOT NULL violation
// on `message`), the critical-severity SMS to the owner never fired, and
// the workflow-engine context (signal_type/severity/recommended_message)
// that an installed playbook's {{...}} template relies on was empty.
async function notifyAndEnroll(
  admin: SupabaseClient,
  signalId: string,
  row: SignalRow,
): Promise<void> {
  const { data: profile } = await admin
    .from("profiles")
    .select("notify_service_recovery_signal, escalation_enabled, escalation_phone, company_name")
    .eq("id", row.user_id)
    .maybeSingle();

  if (profile?.notify_service_recovery_signal !== false) {
    await admin.from("notifications").insert({
      user_id: row.user_id,
      type: "service_recovery_signal",
      title: `${row.severity === "critical" ? "🔴 " : ""}Service recovery: ${row.customer_name || "a customer"}`,
      message: row.signal_excerpt,
      action_url: "/dashboard/service-recovery",
      service_recovery_signal_id: signalId,
    });
  }

  // Critical risks also page the business owner directly, reusing the
  // existing live-escalation phone number they already configured in
  // Settings — separate from any customer-facing message.
  if (row.severity === "critical" && profile?.escalation_enabled && profile?.escalation_phone) {
    await sendSms(
      profile.escalation_phone,
      `Heads up: ${row.customer_name || "a customer"} — ${row.signal_excerpt}. Review it: your dashboard → Service Recovery.`,
    );
  }

  await admin.rpc("append_activity_event", {
    p_aggregate_type: row.source_table === "jobs" ? "job" : row.source_table === "calls" ? "call" : row.source_table === "promises" ? "promise" : "review_request",
    p_aggregate_id: row.source_id,
    p_event_type: "service_recovery.signal_detected",
    p_event_data: {
      customer_name: row.customer_name,
      customer_phone: row.customer_phone,
      customer_email: row.customer_email ?? null,
      signal_id: signalId,
      signal_type: row.signal_type,
      severity: row.severity,
      recommended_message: row.recommended_message,
    },
    p_actor_type: "ai",
    p_user_id: row.user_id,
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  const cronSecret = Deno.env.get("CRON_SECRET");
  if (cronSecret && req.headers.get("X-Cron-Secret") !== cronSecret) {
    return json({ error: "Unauthorized" }, 401);
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  const now = Date.now();
  const counts = { eta_missed: 0, technician_delay: 0, broken_promise: 0, negative_sentiment: 0, negative_review: 0 };

  // -----------------------------------------------------------------
  // 1. ETA MISSED — job still scheduled/en route, past the technician's
  //    own ETA + grace window.
  // -----------------------------------------------------------------
  {
    const { data: jobs } = await admin
      .from("jobs")
      .select("id, user_id, customer_id, customer_name, customer_phone, service_type, job_status, eta_minutes, eta_set_at")
      .in("job_status", ["scheduled", "en_route"])
      .not("eta_minutes", "is", null)
      .not("eta_set_at", "is", null);

    for (const j of jobs ?? []) {
      const etaAt = new Date(j.eta_set_at).getTime() + j.eta_minutes * 60_000;
      const minutesLate = Math.floor((now - etaAt) / 60_000);
      if (minutesLate < ETA_GRACE_MINUTES) continue;

      const severity = severityForMinutesLate(minutesLate);
      const signal: SignalRow = {
        user_id: j.user_id, job_id: j.id, customer_id: j.customer_id ?? null,
        customer_name: j.customer_name, customer_phone: j.customer_phone,
        signal_type: "eta_missed", source_table: "jobs", source_id: j.id, severity,
        signal_excerpt: `ETA missed by ${minutesLate} min for ${j.service_type ?? "the scheduled job"}`,
        recommended_channel: "sms",
        recommended_message: `Hi ${j.customer_name.split(" ")[0] || "there"}, we're sorry — we're running behind on your appointment. We're on our way and will update you the moment we have a new arrival time. Thanks for your patience.`,
      };
      const id = await insertSignal(admin, signal);
      if (id) { await notifyAndEnroll(admin, id, signal); counts.eta_missed++; }
    }
  }

  // -----------------------------------------------------------------
  // 2. BROKEN / OVERDUE PROMISES — extracted by the AI from a call
  //    (src/lib/promises.ts) and never fulfilled in time.
  // -----------------------------------------------------------------
  {
    const { data: promises } = await admin
      .from("promises")
      .select("id, user_id, call_id, customer_name, customer_phone, promise_text, category, due_at, status")
      .or(`status.eq.broken,and(status.eq.pending,due_at.lt.${new Date(now).toISOString()})`);

    for (const p of promises ?? []) {
      const isArrival = p.category === "arrival_time";
      const hoursLate = p.due_at ? Math.max(0, Math.floor((now - new Date(p.due_at).getTime()) / 3_600_000)) : 0;
      const severity: Severity = p.status === "broken" ? "high" : hoursLate >= 24 ? "high" : "medium";
      const signalType = isArrival ? "technician_delay" : "broken_promise";

      const signal: SignalRow = {
        user_id: p.user_id, call_id: p.call_id ?? null, promise_id: p.id,
        customer_name: p.customer_name ?? "", customer_phone: p.customer_phone,
        signal_type: signalType, source_table: "promises", source_id: p.id, severity,
        signal_excerpt: `${p.status === "broken" ? "Broken promise" : "Overdue promise"}: "${p.promise_text}"`,
        recommended_channel: "sms",
        recommended_message: `Hi ${(p.customer_name ?? "").split(" ")[0] || "there"}, following up on what we told you — we know we're behind and we're sorry. Here's where things stand, and we're making this right.`,
      };
      const id = await insertSignal(admin, signal);
      if (id) { await notifyAndEnroll(admin, id, signal); counts[isArrival ? "technician_delay" : "broken_promise"]++; }
    }
  }

  // -----------------------------------------------------------------
  // 3. NEGATIVE SENTIMENT CALLS — already scored by the call-analysis
  //    pipeline, never acted on.
  // -----------------------------------------------------------------
  {
    const { data: calls } = await admin
      .from("calls")
      .select("id, user_id, caller_name, caller_phone, is_emergency, escalated_to, objections_resolved, summary")
      .eq("sentiment", "negative");

    for (const c of calls ?? []) {
      const severity: Severity = c.is_emergency ? "critical" : c.escalated_to ? "low" : c.objections_resolved === false ? "high" : "medium";
      const signal: SignalRow = {
        user_id: c.user_id, call_id: c.id,
        customer_name: c.caller_name ?? "", customer_phone: c.caller_phone,
        signal_type: "negative_sentiment", source_table: "calls", source_id: c.id, severity,
        signal_excerpt: c.summary ? `Negative call: ${String(c.summary).slice(0, 140)}` : "Call flagged with negative sentiment",
        recommended_channel: "sms",
        recommended_message: `Hi ${(c.caller_name ?? "").split(" ")[0] || "there"}, we wanted to personally follow up after your call — it sounded like things didn't go the way they should have. What can we do to make it right?`,
      };
      const id = await insertSignal(admin, signal);
      if (id) { await notifyAndEnroll(admin, id, signal); counts.negative_sentiment++; }
    }
  }

  // -----------------------------------------------------------------
  // 4. NEGATIVE PRIVATE REVIEWS — the biggest gap: rating <= 3 already
  //    stays out of the public review flow (submit_customer_review), but
  //    nothing has ever followed up on it until now.
  // -----------------------------------------------------------------
  {
    const { data: reviews } = await admin
      .from("review_requests")
      .select("id, user_id, customer_name, customer_phone, rating, feedback")
      .eq("status", "completed")
      .lte("rating", 3);

    for (const r of reviews ?? []) {
      const severity: Severity = r.rating <= 2 ? "critical" : "medium";
      const signal: SignalRow = {
        user_id: r.user_id, review_request_id: r.id,
        customer_name: r.customer_name, customer_phone: r.customer_phone,
        signal_type: "negative_review", source_table: "review_requests", source_id: r.id, severity,
        signal_excerpt: `Rated ${r.rating}/5${r.feedback ? `: "${String(r.feedback).slice(0, 140)}"` : ""}`,
        recommended_channel: "call",
        recommended_message: `Hi ${r.customer_name.split(" ")[0] || "there"}, thank you for your honest feedback — I'm sorry we didn't meet the mark. I'd like to personally make this right. Do you have a few minutes to talk?`,
      };
      const id = await insertSignal(admin, signal);
      if (id) { await notifyAndEnroll(admin, id, signal); counts.negative_review++; }
    }
  }

  return json({ ok: true, flagged: counts });
});
