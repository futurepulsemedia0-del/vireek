// supabase/functions/followup-agent-dispatcher/index.ts
//
// Replaces outbound-dialer. Runs on the same kind of schedule (every few
// minutes). For every active enrollment whose next_action_at has arrived:
//
//   1. Re-check DNC suppression (a STOP could have landed since enrollment).
//   2. Re-check the business stop condition for that campaign_type — this
//      is the actual "agent" behavior: the sequence ends itself the moment
//      it's no longer needed, it doesn't blindly run N steps regardless of
//      what happened in between.
//   3. Look up the next step from followup_agent_steps. If the business
//      never configured any steps for this campaign_type, fall back to
//      the legacy single-call behavior (exactly what outbound-dialer used
//      to do) so nothing breaks for existing setups.
//   4. Send it — call via Vapi, or text via the existing compliant SMS
//      sender — and log the attempt in outbound_calls / outbound_sms
//      (both tables OutboundCampaignsPage.tsx's activity log already
//      reads from, extended to read outbound_sms too — see the frontend
//      edit notes).
//   5. Schedule the next step, or mark the enrollment completed.
//
// DEPLOYMENT NOTE: point your external cron (whatever calls
// outbound-queue-builder / outbound-dialer today, e.g. cron-job.org,
// GitHub Actions, Vercel Cron) at followup-agent-enroller and
// followup-agent-dispatcher instead, using the same CRON_SECRET header.
// Once confirmed working you can delete the outbound-queue-builder and
// outbound-dialer function folders — they're superseded, not required
// alongside this.

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { isDncSuppressed } from "../_shared/compliance/dncCheck.ts";
import { sendCompliantSms } from "../_shared/messaging/sendSms.ts";

const BATCH_SIZE = 20;
const MAX_ATTEMPTS_PER_STEP = 3;
const VAPI_CALL_URL = "https://api.vapi.ai/call";

type CampaignType = "quote_followup" | "appointment_reminder" | "review_request_call";

interface Enrollment {
  id: string;
  user_id: string;
  campaign_type: CampaignType;
  lead_id: string | null;
  job_id: string | null;
  customer_name: string;
  customer_phone: string | null;
  current_step: number;
  attempt_count: number;
}

interface Step {
  step_number: number;
  channel: "call" | "sms";
  delay_hours: number;
  sms_body: string | null;
  call_context: string | null;
}

const CAMPAIGN_CONTEXT: Record<CampaignType, string> = {
  quote_followup: "quote_followup",
  appointment_reminder: "appointment_reminder",
  review_request_call: "review_request_call",
};

// ---------------------------------------------------------------------
// Stop conditions — the part that makes this an "agent" and not a timer.
// Returns a reason string if the sequence should end now, or null if it
// should keep going.
// ---------------------------------------------------------------------
async function computeStopReason(admin: SupabaseClient, enrollment: Enrollment): Promise<string | null> {
  if (enrollment.campaign_type === "quote_followup") {
    if (!enrollment.lead_id) return "lead_deleted";
    const { data: lead } = await admin.from("leads").select("stage").eq("id", enrollment.lead_id).maybeSingle();
    if (!lead) return "lead_deleted";
    if (lead.stage !== "quoted") return "lead_progressed";
    return null;
  }

  if (enrollment.campaign_type === "appointment_reminder") {
    if (!enrollment.job_id) return "job_deleted";
    const { data: job } = await admin.from("jobs").select("job_status, scheduled_datetime").eq("id", enrollment.job_id).maybeSingle();
    if (!job) return "job_deleted";
    if (job.job_status !== "scheduled") return "appointment_changed";
    if (job.scheduled_datetime && new Date(job.scheduled_datetime).getTime() < Date.now() - 3600_000) return "appointment_passed";
    return null;
  }

  // review_request_call
  if (!enrollment.job_id) return "job_deleted";
  const { data: review } = await admin
    .from("review_requests")
    .select("status")
    .eq("job_id", enrollment.job_id)
    .eq("status", "completed")
    .maybeSingle();
  if (review) return "review_already_left";
  return null;
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key: string) => vars[key] ?? "");
}

async function buildTemplateVars(admin: SupabaseClient, enrollment: Enrollment): Promise<Record<string, string>> {
  const vars: Record<string, string> = { customer_name: enrollment.customer_name, business_name: "our team" };

  const { data: profile } = await admin.from("profiles").select("company_name").eq("id", enrollment.user_id).maybeSingle();
  if (profile?.company_name) vars.business_name = profile.company_name;

  if (enrollment.campaign_type === "quote_followup" && enrollment.lead_id) {
    const { data: lead } = await admin.from("leads").select("quote_amount").eq("id", enrollment.lead_id).maybeSingle();
    vars.quote_amount = lead?.quote_amount != null ? `$${lead.quote_amount}` : "your quote";
  }

  if (enrollment.campaign_type === "appointment_reminder" && enrollment.job_id) {
    const { data: job } = await admin.from("jobs").select("scheduled_datetime").eq("id", enrollment.job_id).maybeSingle();
    vars.appointment_time = job?.scheduled_datetime
      ? new Date(job.scheduled_datetime).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
      : "your upcoming appointment";
  }

  if (enrollment.campaign_type === "review_request_call") {
    const { data: bp } = await admin.from("business_profile").select("google_review_url").eq("user_id", enrollment.user_id).maybeSingle();
    vars.review_link = bp?.google_review_url ?? "";
  }

  return vars;
}

async function loadNextStep(admin: SupabaseClient, enrollment: Enrollment): Promise<Step | "legacy_call" | null> {
  const { data } = await admin
    .from("followup_agent_steps")
    .select("step_number, channel, delay_hours, sms_body, call_context")
    .eq("user_id", enrollment.user_id)
    .eq("campaign_type", enrollment.campaign_type)
    .eq("step_number", enrollment.current_step + 1)
    .maybeSingle();

  if (data) return data as Step;

  // No steps configured at all for this campaign_type -> legacy
  // single-call behavior, exactly like the old outbound-dialer, but only
  // ever as "step 1". If current_step is already >= 1 there's nothing
  // more to do (sequence finished).
  if (enrollment.current_step === 0) {
    const { count } = await admin
      .from("followup_agent_steps")
      .select("id", { count: "exact", head: true })
      .eq("user_id", enrollment.user_id)
      .eq("campaign_type", enrollment.campaign_type);
    if (!count) return "legacy_call";
  }

  return null;
}

async function scheduleNext(admin: SupabaseClient, enrollment: Enrollment, justRanStepNumber: number) {
  const { data: nextStep } = await admin
    .from("followup_agent_steps")
    .select("delay_hours")
    .eq("user_id", enrollment.user_id)
    .eq("campaign_type", enrollment.campaign_type)
    .eq("step_number", justRanStepNumber + 1)
    .maybeSingle();

  if (nextStep) {
    await admin.from("followup_agent_enrollments").update({
      current_step: justRanStepNumber,
      attempt_count: 0,
      next_action_at: new Date(Date.now() + nextStep.delay_hours * 3600_000).toISOString(),
    }).eq("id", enrollment.id);
  } else {
    await admin.from("followup_agent_enrollments").update({
      current_step: justRanStepNumber,
      status: "completed",
      stop_reason: "sequence_finished",
    }).eq("id", enrollment.id);
  }
}

async function runCallStep(admin: SupabaseClient, enrollment: Enrollment, step: Step | "legacy_call", vapiKey: string) {
  const { data: business } = await admin
    .from("business_profile")
    .select("vapi_assistant_id, vapi_phone_number_id")
    .eq("user_id", enrollment.user_id)
    .maybeSingle();

  const stepNumber = step === "legacy_call" ? 1 : step.step_number;

  if (!business?.vapi_assistant_id || !business?.vapi_phone_number_id) {
    await admin.from("outbound_calls").insert({
      user_id: enrollment.user_id, campaign_type: enrollment.campaign_type, enrollment_id: enrollment.id,
      step_number: stepNumber, lead_id: enrollment.lead_id, job_id: enrollment.job_id,
      customer_name: enrollment.customer_name, customer_phone: enrollment.customer_phone,
      status: "failed", outcome_notes: "No Vapi assistant/phone number configured for this business.",
    });
    return false;
  }

  const variableValues: Record<string, string> = {
    customer_name: enrollment.customer_name,
    call_purpose: CAMPAIGN_CONTEXT[enrollment.campaign_type],
  };
  if (step !== "legacy_call" && step.call_context) variableValues.followup_context = step.call_context;

  try {
    const res = await fetch(VAPI_CALL_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${vapiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        assistantId: business.vapi_assistant_id,
        phoneNumberId: business.vapi_phone_number_id,
        customer: { number: enrollment.customer_phone },
        assistantOverrides: { variableValues },
      }),
    });

    if (!res.ok) {
      const bodyText = await res.text();
      await admin.from("outbound_calls").insert({
        user_id: enrollment.user_id, campaign_type: enrollment.campaign_type, enrollment_id: enrollment.id,
        step_number: stepNumber, lead_id: enrollment.lead_id, job_id: enrollment.job_id,
        customer_name: enrollment.customer_name, customer_phone: enrollment.customer_phone,
        status: "failed", outcome_notes: `Vapi error ${res.status}: ${bodyText.slice(0, 300)}`,
      });
      return false;
    }

    const json = await res.json();
    await admin.from("outbound_calls").insert({
      user_id: enrollment.user_id, campaign_type: enrollment.campaign_type, enrollment_id: enrollment.id,
      step_number: stepNumber, lead_id: enrollment.lead_id, job_id: enrollment.job_id,
      customer_name: enrollment.customer_name, customer_phone: enrollment.customer_phone,
      status: "calling", vapi_call_id: json.id ?? null, called_at: new Date().toISOString(),
    });
    return true;
  } catch (err) {
    await admin.from("outbound_calls").insert({
      user_id: enrollment.user_id, campaign_type: enrollment.campaign_type, enrollment_id: enrollment.id,
      step_number: stepNumber, lead_id: enrollment.lead_id, job_id: enrollment.job_id,
      customer_name: enrollment.customer_name, customer_phone: enrollment.customer_phone,
      status: "failed", outcome_notes: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

async function runSmsStep(admin: SupabaseClient, enrollment: Enrollment, step: Step) {
  const vars = await buildTemplateVars(admin, enrollment);
  const body = renderTemplate(step.sms_body ?? "", vars);

  if (!enrollment.customer_phone) {
    await admin.from("outbound_sms").insert({
      user_id: enrollment.user_id, campaign_type: enrollment.campaign_type, enrollment_id: enrollment.id,
      step_number: step.step_number, lead_id: enrollment.lead_id, job_id: enrollment.job_id,
      customer_name: enrollment.customer_name, customer_phone: null, body,
      status: "failed", outcome_notes: "No phone number on file.",
    });
    return false;
  }

  const result = await sendCompliantSms(admin, enrollment.user_id, enrollment.customer_phone, body);

  if (result.ok) {
    await admin.from("outbound_sms").insert({
      user_id: enrollment.user_id, campaign_type: enrollment.campaign_type, enrollment_id: enrollment.id,
      step_number: step.step_number, lead_id: enrollment.lead_id, job_id: enrollment.job_id,
      customer_name: enrollment.customer_name, customer_phone: enrollment.customer_phone, body,
      status: "sent", twilio_sid: result.sid, sent_at: new Date().toISOString(),
    });
    return true;
  }

  await admin.from("outbound_sms").insert({
    user_id: enrollment.user_id, campaign_type: enrollment.campaign_type, enrollment_id: enrollment.id,
    step_number: step.step_number, lead_id: enrollment.lead_id, job_id: enrollment.job_id,
    customer_name: enrollment.customer_name, customer_phone: enrollment.customer_phone, body,
    status: result.reason === "OPTED_OUT" ? "opted_out" : "failed", outcome_notes: result.detail ?? result.reason,
  });
  return false;
}

Deno.serve(async (req: Request) => {
  const cronSecret = Deno.env.get("CRON_SECRET");
  if (cronSecret && req.headers.get("X-Cron-Secret") !== cronSecret) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  const vapiKey = Deno.env.get("VAPI_PRIVATE_KEY");
  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  const { data: enrollments, error } = await admin
    .from("followup_agent_enrollments")
    .select("id, user_id, campaign_type, lead_id, job_id, customer_name, customer_phone, current_step, attempt_count")
    .eq("status", "active")
    .lte("next_action_at", new Date().toISOString())
    .order("next_action_at", { ascending: true })
    .limit(BATCH_SIZE);

  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  if (!enrollments || enrollments.length === 0) {
    return new Response(JSON.stringify({ processed: 0 }), { headers: { "Content-Type": "application/json" } });
  }

  let sent = 0, stopped = 0, failed = 0;

  for (const enrollment of enrollments as Enrollment[]) {
    // 1. DNC re-check — a STOP could have arrived after enrollment.
    if (enrollment.customer_phone && (await isDncSuppressed(admin, enrollment.user_id, enrollment.customer_phone))) {
      await admin.from("followup_agent_enrollments").update({ status: "opted_out", stop_reason: "customer_opted_out" }).eq("id", enrollment.id);
      stopped += 1;
      continue;
    }

    // 2. Business stop condition — the actual "agent" judgment call.
    const stopReason = await computeStopReason(admin, enrollment);
    if (stopReason) {
      await admin.from("followup_agent_enrollments").update({ status: "completed", stop_reason: stopReason }).eq("id", enrollment.id);
      stopped += 1;
      continue;
    }

    // 3. Figure out what to send next.
    const step = await loadNextStep(admin, enrollment);
    if (!step) {
      await admin.from("followup_agent_enrollments").update({ status: "completed", stop_reason: "sequence_finished" }).eq("id", enrollment.id);
      stopped += 1;
      continue;
    }

    const channel = step === "legacy_call" ? "call" : step.channel;
    const stepNumber = step === "legacy_call" ? 1 : step.step_number;

    let ok: boolean;
    if (channel === "call") {
      if (!vapiKey) {
        await admin.from("followup_agent_enrollments").update({ status: "completed", stop_reason: "vapi_not_configured" }).eq("id", enrollment.id);
        stopped += 1;
        continue;
      }
      ok = await runCallStep(admin, enrollment, step, vapiKey);
    } else {
      ok = await runSmsStep(admin, enrollment, step as Step);
    }

    if (ok) {
      sent += 1;
      await scheduleNext(admin, enrollment, stepNumber);
    } else {
      failed += 1;
      const attempts = enrollment.attempt_count + 1;
      if (attempts >= MAX_ATTEMPTS_PER_STEP) {
        // Give up on this step and move on to the next one rather than
        // stalling the whole sequence on one bad attempt.
        await scheduleNext(admin, enrollment, stepNumber);
      } else {
        await admin.from("followup_agent_enrollments").update({
          attempt_count: attempts,
          next_action_at: new Date(Date.now() + 30 * 60_000).toISOString(),
        }).eq("id", enrollment.id);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  return new Response(JSON.stringify({ processed: enrollments.length, sent, stopped, failed }), { headers: { "Content-Type": "application/json" } });
});
