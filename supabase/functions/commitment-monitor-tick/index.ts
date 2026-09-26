// supabase/functions/commitment-monitor-tick/index.ts
//
// Scans open commitments (from the Commitment Graph — calls, SMS, chat,
// quotes, technician notes, manual) with a deadline and staged-alerts
// whoever owns them, same pattern as check-contract-renewals:
//
//   due_soon  — deadline within 3 hours   -> in-app notification to owner
//   overdue   — deadline has passed       -> in-app notification to owner
//   escalated — 6+ hours overdue          -> in-app notification + SMS
//               straight to the account owner (the human escalation)
//
// escalation_stage on the row makes this idempotent — a commitment is
// only alerted once per stage, and 20261126000000_commitment_monitoring_
// and_chat_source.sql resets the stage if the deadline changes or the
// commitment is reopened. Run every 10-15 min — see the cron.schedule()
// comment at the bottom of that migration.
//
// Deploy: supabase functions deploy commitment-monitor-tick

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendSms } from "../_shared/notify/deliver.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Cron-Secret",
};

type Stage = "due_soon" | "overdue" | "escalated";

function stageFor(deadlineIso: string): Stage | null {
  const hoursUntil = (new Date(deadlineIso).getTime() - Date.now()) / 3_600_000;
  if (hoursUntil <= -6) return "escalated";
  if (hoursUntil <= 0) return "overdue";
  if (hoursUntil <= 3) return "due_soon";
  return null;
}

const STAGE_TITLE: Record<Stage, string> = {
  due_soon: "Commitment due soon",
  overdue: "Commitment overdue",
  escalated: "Commitment escalated",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const cronSecret = Deno.env.get("CRON_SECRET");
  if (cronSecret && req.headers.get("X-Cron-Secret") !== cronSecret) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

    const { data: commitments, error: fetchError } = await admin
      .from("commitments")
      .select("id, user_id, owner_name, customer_name, commitment_text, deadline_at, escalation_stage, source_type")
      .eq("status", "open")
      .not("deadline_at", "is", null)
      .limit(500);

    if (fetchError) throw fetchError;

    const candidates = (commitments ?? [])
      .map((c) => ({ c, stage: stageFor(c.deadline_at as string) }))
      .filter((x): x is { c: NonNullable<typeof commitments>[number]; stage: Stage } =>
        x.stage !== null && x.stage !== x.c.escalation_stage,
      );

    if (candidates.length === 0) {
      return new Response(
        JSON.stringify({ alertsCreated: 0, checked: commitments?.length ?? 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const userIds = Array.from(new Set(candidates.map((x) => x.c.user_id as string)));
    const { data: profiles } = await admin.from("profiles").select("id, phone, notify_commitment_escalation").in("id", userIds);
    const profileById = new Map((profiles ?? []).map((p) => [p.id as string, p]));

    let alertsCreated = 0;
    let smsSent = 0;

    for (const { c, stage } of candidates) {
      const profile = profileById.get(c.user_id as string);
      if (profile?.notify_commitment_escalation === false) continue;

      const who = (c.owner_name as string) ?? "The assigned owner";
      const customer = (c.customer_name as string) ?? "a customer";
      const text = (c.commitment_text as string).slice(0, 140);

      const message =
        stage === "due_soon"
          ? `${who}'s commitment to ${customer} is due within 3 hours: "${text}"`
          : stage === "overdue"
            ? `${who}'s commitment to ${customer} is now overdue: "${text}"`
            : `Escalation: ${who}'s commitment to ${customer} has been overdue 6+ hours with no resolution: "${text}"`;

      const { error: insertError } = await admin.from("notifications").insert({
        user_id: c.user_id,
        type: "commitment_escalation",
        title: STAGE_TITLE[stage],
        message,
        action_url: "/dashboard/commitments",
        commitment_id: c.id,
      });
      if (insertError) continue;

      if (stage === "escalated" && profile?.phone) {
        const smsResult = await sendSms(profile.phone as string, `Vireek: ${message}`);
        if (smsResult.ok) smsSent++;
      }

      await admin
        .from("commitments")
        .update({ escalation_stage: stage, escalation_alert_sent_at: new Date().toISOString() })
        .eq("id", c.id);

      alertsCreated++;
    }

    return new Response(
      JSON.stringify({ alertsCreated, smsSent, checked: commitments?.length ?? 0 }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
