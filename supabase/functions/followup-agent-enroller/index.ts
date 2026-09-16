// supabase/functions/followup-agent-enroller/index.ts
//
// Replaces outbound-queue-builder as the thing an external cron hits on a
// schedule (e.g. every 15 minutes). Same three trigger sources as before
// (quoted leads, upcoming appointments, completed+paid jobs), but instead
// of inserting one outbound_calls row per lead/job, it creates one
// followup_agent_enrollments row — the multi-step sequence then plays out
// via followup-agent-dispatcher, which is the function that actually
// checks followup_agent_steps and sends calls/texts.
//
// This function's ONLY job is "should this lead/job start a sequence, and
// if so, when should step 1 fire". It never sends anything itself.
//
// Point your scheduler at this function AND followup-agent-dispatcher.
// You can safely delete/disable the old outbound-queue-builder +
// outbound-dialer cron jobs once this is live — see the deployment note
// at the end of this file's companion, followup-agent-dispatcher.

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { isDncSuppressed } from "../_shared/compliance/dncCheck.ts";

type CampaignType = "quote_followup" | "appointment_reminder" | "review_request_call";

interface CampaignRow {
  user_id: string;
  campaign_type: CampaignType;
  trigger_after_hours: number;
}

interface Candidate {
  lead_id?: string;
  job_id?: string;
  customer_name: string;
  customer_phone: string | null;
}

// Step 1's delay is whatever the business configured for step 1 in
// followup_agent_steps; if they never touched the new Agent step editor,
// fall back to the legacy outbound_campaigns.trigger_after_hours value so
// nothing changes for businesses that only ever used the simple toggle.
async function resolveStep1DelayHours(
  admin: SupabaseClient,
  campaign: CampaignRow,
): Promise<number> {
  const { data } = await admin
    .from("followup_agent_steps")
    .select("delay_hours")
    .eq("user_id", campaign.user_id)
    .eq("campaign_type", campaign.campaign_type)
    .eq("step_number", 1)
    .maybeSingle();
  return data?.delay_hours ?? campaign.trigger_after_hours;
}

async function findQuoteFollowupCandidates(admin: SupabaseClient, campaign: CampaignRow, cutoffHours: number): Promise<Candidate[]> {
  const cutoff = new Date(Date.now() - cutoffHours * 3600_000).toISOString();
  const { data } = await admin
    .from("leads")
    .select("id, name, phone")
    .eq("user_id", campaign.user_id)
    .eq("stage", "quoted")
    .lte("stage_updated_at", cutoff)
    .not("phone", "is", null);

  return (data ?? []).map((lead) => ({ lead_id: lead.id, customer_name: lead.name, customer_phone: lead.phone }));
}

async function findAppointmentReminderCandidates(admin: SupabaseClient, campaign: CampaignRow, windowHours: number): Promise<Candidate[]> {
  const windowStart = new Date().toISOString();
  const windowEnd = new Date(Date.now() + windowHours * 3600_000).toISOString();
  const { data } = await admin
    .from("jobs")
    .select("id, customer_name, customer_phone, scheduled_datetime")
    .eq("user_id", campaign.user_id)
    .eq("job_status", "scheduled")
    .gte("scheduled_datetime", windowStart)
    .lte("scheduled_datetime", windowEnd)
    .not("customer_phone", "is", null);

  return (data ?? []).map((job) => ({ job_id: job.id, customer_name: job.customer_name, customer_phone: job.customer_phone }));
}

async function findReviewRequestCandidates(admin: SupabaseClient, campaign: CampaignRow, cutoffHours: number): Promise<Candidate[]> {
  const cutoff = new Date(Date.now() - cutoffHours * 3600_000).toISOString();
  const { data } = await admin
    .from("jobs")
    .select("id, customer_name, customer_phone, completed_at")
    .eq("user_id", campaign.user_id)
    .eq("job_status", "completed")
    .eq("invoice_status", "paid")
    .lte("completed_at", cutoff)
    .not("customer_phone", "is", null);

  return (data ?? []).map((job) => ({ job_id: job.id, customer_name: job.customer_name, customer_phone: job.customer_phone }));
}

async function enrollCandidates(
  admin: SupabaseClient,
  campaign: CampaignRow,
  candidates: Candidate[],
): Promise<{ enrolled: number; opted_out: number }> {
  let enrolled = 0, optedOut = 0;

  for (const candidate of candidates) {
    const suppressed = candidate.customer_phone
      ? await isDncSuppressed(admin, campaign.user_id, candidate.customer_phone)
      : false;

    const { error } = await admin.from("followup_agent_enrollments").insert({
      user_id: campaign.user_id,
      campaign_type: campaign.campaign_type,
      lead_id: candidate.lead_id ?? null,
      job_id: candidate.job_id ?? null,
      customer_name: candidate.customer_name,
      customer_phone: candidate.customer_phone,
      status: suppressed ? "opted_out" : "active",
      stop_reason: suppressed ? "customer_opted_out" : null,
      next_action_at: new Date().toISOString(),
    });

    // ON CONFLICT is implicit via the dedupe unique indexes — a duplicate
    // insert just errors and is silently skipped, same as the old system.
    if (!error) {
      if (suppressed) optedOut += 1; else enrolled += 1;
    }
  }

  return { enrolled, opted_out: optedOut };
}

Deno.serve(async (req: Request) => {
  const cronSecret = Deno.env.get("CRON_SECRET");
  if (cronSecret && req.headers.get("X-Cron-Secret") !== cronSecret) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  const { data: campaigns, error } = await admin
    .from("outbound_campaigns")
    .select("user_id, campaign_type, trigger_after_hours")
    .eq("enabled", true);

  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

  const results: Record<CampaignType, { enrolled: number; opted_out: number }> = {
    quote_followup: { enrolled: 0, opted_out: 0 },
    appointment_reminder: { enrolled: 0, opted_out: 0 },
    review_request_call: { enrolled: 0, opted_out: 0 },
  };

  for (const campaign of (campaigns as CampaignRow[]) ?? []) {
    const delayHours = await resolveStep1DelayHours(admin, campaign);

    let candidates: Candidate[];
    if (campaign.campaign_type === "quote_followup") candidates = await findQuoteFollowupCandidates(admin, campaign, delayHours);
    else if (campaign.campaign_type === "appointment_reminder") candidates = await findAppointmentReminderCandidates(admin, campaign, delayHours);
    else candidates = await findReviewRequestCandidates(admin, campaign, delayHours);

    const outcome = await enrollCandidates(admin, campaign, candidates);
    results[campaign.campaign_type].enrolled += outcome.enrolled;
    results[campaign.campaign_type].opted_out += outcome.opted_out;
  }

  return new Response(JSON.stringify({ results }), { headers: { "Content-Type": "application/json" } });
});
