// supabase/functions/service-recovery-agent/index.ts
//
// Service Recovery & Complaint Prevention Agent
//
// Cron-driven scanner that watches four early-warning signs of an
// unhappy customer — missed ETA, a technician who hasn't left yet,
// AI-detected negative call sentiment, and a staff-flagged dispute —
// and, for each new one, opens a row in service_recovery_signals and
// appends a business_activity_events row so the matching playbook in
// src/lib/workflowPlaybooks.ts auto-enrolls (apology SMS, manager call,
// escalation) BEFORE the customer leaves a bad review or churns.
//
// Same "detection is deterministic, never hallucinated" philosophy as
// estimate-recovery-agent: thresholds below, not an LLM guess.
//
// DEPLOYMENT: supabase functions deploy service-recovery-agent
// --no-verify-jwt, then point your existing cron at it every 10-15
// minutes, same X-Cron-Secret header / CRON_SECRET already used by
// workflow-engine-executor / estimate-recovery-agent.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Cron-Secret",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// Thresholds — tune freely, nothing else in the system depends on these exact numbers.
const ETA_GRACE_MINUTES = 15;          // how late past the promised ETA before it's a signal
const TECH_DELAY_GRACE_MINUTES = 20;   // how late past scheduled_datetime, still not en_route
const LOOKBACK_HOURS = 48;             // don't re-scan ancient rows every run

function severity(base: number, minutesLate: number): number {
  return Math.min(100, base + Math.round(minutesLate / 2));
}

async function upsertSignal(admin: ReturnType<typeof createClient>, row: Record<string, unknown>) {
  // Idempotent by (source_table, source_id, signal_type) — the unique
  // constraint on service_recovery_signals. ignoreDuplicates leaves a
  // signal a human already triaged (escalated/resolved/ignored) alone.
  await admin.from("service_recovery_signals").upsert(row, {
    onConflict: "source_table,source_id,signal_type",
    ignoreDuplicates: true,
  });
}

async function enroll(
  admin: ReturnType<typeof createClient>,
  args: {
    aggregateType: string; aggregateId: string; eventType: string; userId: string;
    customerName: string | null; customerPhone: string | null;
    extra: Record<string, unknown>;
  },
) {
  await admin.rpc("append_activity_event", {
    p_aggregate_type: args.aggregateType,
    p_aggregate_id: args.aggregateId,
    p_event_type: args.eventType,
    p_event_data: {
      customer_name: args.customerName,
      customer_phone: args.customerPhone,
      ...args.extra,
    },
    p_actor_type: "ai",
    p_user_id: args.userId,
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
  const lookbackCutoff = new Date(now - LOOKBACK_HOURS * 3600_000).toISOString();
  const counts = { eta_missed: 0, technician_delayed: 0, negative_sentiment: 0, customer_dispute: 0 };

  // -----------------------------------------------------------------
  // 1. ETA MISSED — job en_route, promised ETA window has passed
  // -----------------------------------------------------------------
  {
    const { data: jobs } = await admin
      .from("jobs")
      .select("id, user_id, lead_id, customer_name, customer_phone, eta_minutes, eta_set_at")
      .eq("job_status", "en_route")
      .not("eta_minutes", "is", null)
      .not("eta_set_at", "is", null)
      .gte("eta_set_at", lookbackCutoff);

    for (const j of jobs ?? []) {
      const promisedArrival = new Date(j.eta_set_at).getTime() + Number(j.eta_minutes) * 60_000;
      const minutesLate = (now - promisedArrival) / 60_000;
      if (minutesLate < ETA_GRACE_MINUTES) continue;

      await upsertSignal(admin, {
        user_id: j.user_id, signal_type: "eta_missed", source_table: "jobs", source_id: j.id,
        job_id: j.id, lead_id: j.lead_id, customer_name: j.customer_name, customer_phone: j.customer_phone,
        severity_score: severity(40, minutesLate),
        detail: `Technician is ${Math.round(minutesLate)} min past the promised ETA.`,
      });
      await enroll(admin, {
        aggregateType: "job", aggregateId: j.id, eventType: "job.eta_missed", userId: j.user_id,
        customerName: j.customer_name, customerPhone: j.customer_phone,
        extra: { minutes_late: Math.round(minutesLate) },
      });
      counts.eta_missed++;
    }
  }

  // -----------------------------------------------------------------
  // 2. TECHNICIAN DELAYED — still 'scheduled', well past scheduled_datetime
  // -----------------------------------------------------------------
  {
    const cutoff = new Date(now - TECH_DELAY_GRACE_MINUTES * 60_000).toISOString();
    const { data: jobs } = await admin
      .from("jobs")
      .select("id, user_id, lead_id, customer_name, customer_phone, scheduled_datetime")
      .eq("job_status", "scheduled")
      .not("scheduled_datetime", "is", null)
      .lte("scheduled_datetime", cutoff)
      .gte("scheduled_datetime", lookbackCutoff);

    for (const j of jobs ?? []) {
      const minutesLate = (now - new Date(j.scheduled_datetime).getTime()) / 60_000;

      await upsertSignal(admin, {
        user_id: j.user_id, signal_type: "technician_delayed", source_table: "jobs", source_id: j.id,
        job_id: j.id, lead_id: j.lead_id, customer_name: j.customer_name, customer_phone: j.customer_phone,
        severity_score: severity(35, minutesLate),
        detail: `Job is ${Math.round(minutesLate)} min past its scheduled time with no technician en route yet.`,
      });
      await enroll(admin, {
        aggregateType: "job", aggregateId: j.id, eventType: "job.technician_delayed", userId: j.user_id,
        customerName: j.customer_name, customerPhone: j.customer_phone,
        extra: { minutes_late: Math.round(minutesLate) },
      });
      counts.technician_delayed++;
    }
  }

  // -----------------------------------------------------------------
  // 3. NEGATIVE SENTIMENT — AI-scored call sentiment, linked to a job
  // -----------------------------------------------------------------
  {
    const { data: calls } = await admin
      .from("calls")
      .select("id, user_id, lead_id, customer_name, customer_phone, sentiment, created_at")
      .eq("sentiment", "negative")
      .gte("created_at", lookbackCutoff);

    for (const c of calls ?? []) {
      const { data: relatedJob } = await admin
        .from("jobs")
        .select("id")
        .eq("call_id", c.id)
        .maybeSingle();

      await upsertSignal(admin, {
        user_id: c.user_id, signal_type: "negative_sentiment", source_table: "calls", source_id: c.id,
        job_id: relatedJob?.id ?? null, lead_id: c.lead_id, customer_name: c.customer_name, customer_phone: c.customer_phone,
        severity_score: 65,
        detail: "AI call analysis detected negative customer sentiment.",
      });
      await enroll(admin, {
        aggregateType: "call", aggregateId: c.id, eventType: "call.negative_sentiment", userId: c.user_id,
        customerName: c.customer_name, customerPhone: c.customer_phone,
        extra: { job_id: relatedJob?.id ?? null },
      });
      counts.negative_sentiment++;
    }
  }

  // -----------------------------------------------------------------
  // 4. CUSTOMER DISPUTE — staff-flagged, highest priority
  // -----------------------------------------------------------------
  {
    const { data: jobs } = await admin
      .from("jobs")
      .select("id, user_id, lead_id, customer_name, customer_phone, customer_disputed_at")
      .eq("customer_disputed", true);

    for (const j of jobs ?? []) {
      await upsertSignal(admin, {
        user_id: j.user_id, signal_type: "customer_dispute", source_table: "jobs", source_id: j.id,
        job_id: j.id, lead_id: j.lead_id, customer_name: j.customer_name, customer_phone: j.customer_phone,
        severity_score: 90,
        detail: "Staff flagged this job as disputed.",
      });
      await enroll(admin, {
        aggregateType: "job", aggregateId: j.id, eventType: "job.customer_disputed", userId: j.user_id,
        customerName: j.customer_name, customerPhone: j.customer_phone,
        extra: {},
      });
      counts.customer_dispute++;
    }
  }

  return json({ ok: true, counts });
});
