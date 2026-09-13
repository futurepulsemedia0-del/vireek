import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";

interface CampaignRow {
  user_id: string;
  campaign_type: "quote_followup" | "appointment_reminder" | "review_request_call";
  trigger_after_hours: number;
}

async function queueQuoteFollowups(admin: SupabaseClient, campaign: CampaignRow) {
  const cutoff = new Date(Date.now() - campaign.trigger_after_hours * 3600_000).toISOString();
  const { data: leads } = await admin
    .from("leads")
    .select("id, name, phone")
    .eq("user_id", campaign.user_id)
    .eq("stage", "quoted")
    .lte("stage_updated_at", cutoff)
    .not("phone", "is", null);

  let queued = 0, skipped = 0;
  for (const lead of leads ?? []) {
    const { error } = await admin.from("outbound_calls").insert({
      user_id: campaign.user_id, campaign_type: "quote_followup", lead_id: lead.id,
      customer_name: lead.name, customer_phone: lead.phone, status: "queued",
    });
    if (!error) queued += 1; else skipped += 1; // already queued (dedupe index) or blocked for missing consent
  }
  return { queued, skipped };
}

async function queueAppointmentReminders(admin: SupabaseClient, campaign: CampaignRow) {
  const windowStart = new Date().toISOString();
  const windowEnd = new Date(Date.now() + campaign.trigger_after_hours * 3600_000).toISOString();
  const { data: jobs } = await admin
    .from("jobs")
    .select("id, customer_name, customer_phone, scheduled_datetime")
    .eq("user_id", campaign.user_id)
    .eq("job_status", "scheduled")
    .gte("scheduled_datetime", windowStart)
    .lte("scheduled_datetime", windowEnd)
    .not("customer_phone", "is", null);

  let queued = 0, skipped = 0;
  for (const job of jobs ?? []) {
    const { error } = await admin.from("outbound_calls").insert({
      user_id: campaign.user_id, campaign_type: "appointment_reminder", job_id: job.id,
      customer_name: job.customer_name, customer_phone: job.customer_phone, status: "queued",
    });
    if (!error) queued += 1; else skipped += 1;
  }
  return { queued, skipped };
}

async function queueReviewRequestCalls(admin: SupabaseClient, campaign: CampaignRow) {
  const cutoff = new Date(Date.now() - campaign.trigger_after_hours * 3600_000).toISOString();
  const { data: jobs } = await admin
    .from("jobs")
    .select("id, customer_name, customer_phone, completed_at")
    .eq("user_id", campaign.user_id)
    .eq("job_status", "completed")
    .lte("completed_at", cutoff)
    .not("customer_phone", "is", null);

  let queued = 0, skipped = 0;
  for (const job of jobs ?? []) {
    const { error } = await admin.from("outbound_calls").insert({
      user_id: campaign.user_id, campaign_type: "review_request_call", job_id: job.id,
      customer_name: job.customer_name, customer_phone: job.customer_phone, status: "queued",
    });
    if (!error) queued += 1; else skipped += 1;
  }
  return { queued, skipped };
}

Deno.serve(async (req: Request) => {
  const cronSecret = Deno.env.get("CRON_SECRET");
  if (cronSecret && req.headers.get("X-Cron-Secret") !== cronSecret) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

  const { data: campaigns, error } = await admin.from("outbound_campaigns").select("user_id, campaign_type, trigger_after_hours").eq("enabled", true);
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

  const results = { quote_followup: { queued: 0, skipped: 0 }, appointment_reminder: { queued: 0, skipped: 0 }, review_request_call: { queued: 0, skipped: 0 } };

  for (const campaign of (campaigns as CampaignRow[]) ?? []) {
    let outcome;
    if (campaign.campaign_type === "quote_followup") outcome = await queueQuoteFollowups(admin, campaign);
    else if (campaign.campaign_type === "appointment_reminder") outcome = await queueAppointmentReminders(admin, campaign);
    else outcome = await queueReviewRequestCalls(admin, campaign);

    results[campaign.campaign_type].queued += outcome.queued;
    results[campaign.campaign_type].skipped += outcome.skipped;
  }

  return new Response(JSON.stringify({ results }), { headers: { "Content-Type": "application/json" } });
});
