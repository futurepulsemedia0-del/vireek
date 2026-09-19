// supabase/functions/marketing-engine-tick/index.ts
//
// Runs on a schedule (suggested: hourly). Per account:
//   1. Recompute lead_scores.
//   2. Recompute membership of every dynamic segment.
//   3. Enroll new segment members into matching active 'segment_entry' campaigns.
//   4. Drain marketing_event_queue and enroll into matching active 'event' campaigns.
// Sending itself happens in marketing-campaign-dispatcher, not here — this
// function only decides WHO should be enrolled and WHEN their first step
// is due.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { resolveSegmentMembers, SegmentFilter } from "../_shared/marketing/segments.ts";
import { scoreAccount } from "../_shared/marketing/scoring.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
      auth: { persistSession: false },
    });

    const { data: profiles, error: profilesError } = await admin.from("profiles").select("id");
    if (profilesError) throw profilesError;

    let scored = 0;
    let segmentsSynced = 0;
    let enrolled = 0;

    for (const profile of profiles ?? []) {
      const userId = profile.id as string;

      scored += await scoreAccount(admin, userId);
      enrolled += await syncSegmentsForUser(admin, userId);
      segmentsSynced += 1;
      enrolled += await processEventQueueForUser(admin, userId);
    }

    return new Response(
      JSON.stringify({ ok: true, accounts: profiles?.length ?? 0, scored, segmentsSynced, enrolled }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("marketing-engine-tick error", err);
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

// deno-lint-ignore no-explicit-any
async function syncSegmentsForUser(admin: any, userId: string): Promise<number> {
  const { data: segments } = await admin
    .from("marketing_segments")
    .select("id, filter, is_dynamic")
    .eq("user_id", userId)
    .eq("is_dynamic", true);

  let enrolledCount = 0;

  for (const segment of segments ?? []) {
    const members = await resolveSegmentMembers(admin, userId, (segment.filter ?? {}) as SegmentFilter);

    const { data: existing } = await admin
      .from("marketing_segment_members")
      .select("customer_id, lead_id")
      .eq("segment_id", segment.id);
    const existingCustomerIds = new Set((existing ?? []).map((m: { customer_id: string | null }) => m.customer_id).filter(Boolean));
    const existingLeadIds = new Set((existing ?? []).map((m: { lead_id: string | null }) => m.lead_id).filter(Boolean));

    const newMembers = members.filter(
      (m) => (m.customer_id && !existingCustomerIds.has(m.customer_id)) || (m.lead_id && !existingLeadIds.has(m.lead_id)),
    );

    if (newMembers.length) {
      await admin.from("marketing_segment_members").insert(
        newMembers.map((m) => ({ segment_id: segment.id, user_id: userId, customer_id: m.customer_id ?? null, lead_id: m.lead_id ?? null })),
      );
    }

    await admin.from("marketing_segments").update({ member_count: members.length, updated_at: new Date().toISOString() }).eq("id", segment.id);

    if (newMembers.length === 0) continue;

    const { data: campaigns } = await admin
      .from("marketing_campaigns")
      .select("id")
      .eq("user_id", userId)
      .eq("segment_id", segment.id)
      .eq("trigger_type", "segment_entry")
      .eq("status", "active");

    for (const campaign of campaigns ?? []) {
      for (const member of newMembers) {
        const ok = await enrollContact(admin, userId, campaign.id, member);
        if (ok) enrolledCount += 1;
      }
    }
  }

  return enrolledCount;
}

// deno-lint-ignore no-explicit-any
async function processEventQueueForUser(admin: any, userId: string): Promise<number> {
  const { data: events } = await admin
    .from("marketing_event_queue")
    .select("id, event_type, customer_id, lead_id, payload")
    .eq("user_id", userId)
    .eq("processed", false)
    .limit(200);

  if (!events?.length) return 0;

  const { data: campaigns } = await admin
    .from("marketing_campaigns")
    .select("id, trigger_event")
    .eq("user_id", userId)
    .eq("trigger_type", "event")
    .eq("status", "active");

  let enrolledCount = 0;

  for (const event of events) {
    const matches = (campaigns ?? []).filter((c: { trigger_event: string }) => c.trigger_event === event.event_type);
    for (const campaign of matches) {
      const ok = await enrollContact(admin, userId, campaign.id, {
        customer_id: event.customer_id ?? undefined,
        lead_id: event.lead_id ?? undefined,
        email: (event.payload?.email as string) ?? null,
        phone: (event.payload?.phone as string) ?? null,
        name: null,
      });
      if (ok) enrolledCount += 1;
    }
    await admin.from("marketing_event_queue").update({ processed: true }).eq("id", event.id);
  }

  return enrolledCount;
}

// deno-lint-ignore no-explicit-any
async function enrollContact(
  admin: any,
  userId: string,
  campaignId: string,
  member: { customer_id?: string; lead_id?: string; email: string | null; phone: string | null; name: string | null },
): Promise<boolean> {
  // Look up contact details from the source table when the caller didn't
  // already have them (event-queue path only carries what was on the row).
  let email = member.email;
  let phone = member.phone;
  if ((!email && !phone) && member.customer_id) {
    const { data } = await admin.from("customers").select("email, phone").eq("id", member.customer_id).maybeSingle();
    email = data?.email ?? null;
    phone = data?.phone ?? null;
  }
  if ((!email && !phone) && member.lead_id) {
    const { data } = await admin.from("leads").select("email, phone").eq("id", member.lead_id).maybeSingle();
    email = data?.email ?? null;
    phone = data?.phone ?? null;
  }
  if (!email && !phone) return false; // nothing to send to

  const { data: firstStep } = await admin
    .from("marketing_campaign_steps")
    .select("delay_hours")
    .eq("campaign_id", campaignId)
    .order("step_order", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!firstStep) return false; // campaign has no steps yet

  const nextSendAt = new Date(Date.now() + (firstStep.delay_hours ?? 0) * 3_600_000).toISOString();

  const { error } = await admin.from("marketing_campaign_enrollments").insert({
    campaign_id: campaignId,
    user_id: userId,
    customer_id: member.customer_id ?? null,
    lead_id: member.lead_id ?? null,
    contact_email: email,
    contact_phone: phone,
    current_step: 0,
    status: "active",
    next_send_at: nextSendAt,
  });
  // Unique index on (campaign_id, customer_id)/(campaign_id, lead_id) means
  // a duplicate enrollment attempt fails silently here — that's expected
  // and not an error worth surfacing.
  return !error;
}
