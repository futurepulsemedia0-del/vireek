// supabase/functions/marketing-campaign-dispatcher/index.ts
//
// Runs on a schedule (suggested: every 15 minutes). Sends the next due
// step for every active enrollment, reusing this project's existing
// senders — sendEmail (Resend) from _shared/notify/deliver.ts and
// sendCompliantSms (Twilio + A2P + opt-out gates) from
// _shared/messaging/sendSms.ts — instead of talking to providers directly.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendEmail } from "../_shared/notify/deliver.ts";
import { sendCompliantSms } from "../_shared/messaging/sendSms.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/{{\s*(\w+)\s*}}/g, (_, key) => vars[key] ?? "");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
      auth: { persistSession: false },
    });

    const nowIso = new Date().toISOString();
    const { data: due, error: dueError } = await admin
      .from("marketing_campaign_enrollments")
      .select("id, campaign_id, user_id, customer_id, lead_id, contact_email, contact_phone, current_step")
      .eq("status", "active")
      .lte("next_send_at", nowIso)
      .limit(200);
    if (dueError) throw dueError;

    let sent = 0;
    let failed = 0;
    let completed = 0;

    for (const enrollment of due ?? []) {
      const nextStepOrder = enrollment.current_step + 1;
      const { data: step } = await admin
        .from("marketing_campaign_steps")
        .select("id, step_order, delay_hours, channel, subject, body")
        .eq("campaign_id", enrollment.campaign_id)
        .eq("step_order", nextStepOrder)
        .maybeSingle();

      if (!step) {
        await admin.from("marketing_campaign_enrollments").update({ status: "completed", next_send_at: null }).eq("id", enrollment.id);
        completed += 1;
        continue;
      }

      const name = await resolveContactName(admin, enrollment);
      const vars = { name: name ?? "there" };
      const body = fillTemplate(step.body, vars);

      let sendResult: { ok: boolean; error?: string } | { ok: true; sid: string } | { ok: false; reason: string; detail?: string };

      if (step.channel === "email" && enrollment.contact_email) {
        sendResult = await sendEmail(enrollment.contact_email, fillTemplate(step.subject ?? "", vars), `<p>${body}</p>`, body);
      } else if (step.channel === "sms" && enrollment.contact_phone) {
        sendResult = await sendCompliantSms(admin, enrollment.user_id, enrollment.contact_phone, body);
      } else {
        sendResult = { ok: false, error: `No ${step.channel} contact info on this enrollment` };
      }

      await admin.from("marketing_campaign_sends").insert({
        enrollment_id: enrollment.id,
        step_id: step.id,
        user_id: enrollment.user_id,
        channel: step.channel,
        status: sendResult.ok ? "sent" : "failed",
        provider_ref: "sid" in sendResult ? sendResult.sid : null,
        error: sendResult.ok ? null : ("error" in sendResult ? sendResult.error : sendResult.detail) ?? "unknown",
      });

      if (sendResult.ok) sent += 1;
      else failed += 1;

      const { data: followingStep } = await admin
        .from("marketing_campaign_steps")
        .select("delay_hours")
        .eq("campaign_id", enrollment.campaign_id)
        .eq("step_order", nextStepOrder + 1)
        .maybeSingle();

      if (followingStep) {
        await admin
          .from("marketing_campaign_enrollments")
          .update({ current_step: nextStepOrder, next_send_at: new Date(Date.now() + followingStep.delay_hours * 3_600_000).toISOString() })
          .eq("id", enrollment.id);
      } else {
        await admin
          .from("marketing_campaign_enrollments")
          .update({ current_step: nextStepOrder, status: "completed", next_send_at: null })
          .eq("id", enrollment.id);
        completed += 1;
      }
    }

    return new Response(JSON.stringify({ ok: true, processed: due?.length ?? 0, sent, failed, completed }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("marketing-campaign-dispatcher error", err);
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

// deno-lint-ignore no-explicit-any
async function resolveContactName(admin: any, enrollment: { customer_id: string | null; lead_id: string | null }): Promise<string | null> {
  if (enrollment.customer_id) {
    const { data } = await admin.from("customers").select("name").eq("id", enrollment.customer_id).maybeSingle();
    return data?.name ?? null;
  }
  if (enrollment.lead_id) {
    const { data } = await admin.from("leads").select("name").eq("id", enrollment.lead_id).maybeSingle();
    return data?.name ?? null;
  }
  return null;
}
