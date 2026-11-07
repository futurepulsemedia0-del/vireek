// supabase/functions/_shared/fraud/alerts.ts
//
// Routes Vireek-INTERNAL fraud alerts to whoever is on call, reusing the existing on-call rotation
// (get_current_on_call + team_members) and the existing senders in ../notify/deliver.ts.
// These messages go to Vireek staff, not customers, so they intentionally bypass customer messaging gates.
//
// Env:
//   FRAUD_ONCALL_SCHEDULE_ID   on_call_schedules.id of Vireek's own rotation (optional)
//   FRAUD_ALERT_SLACK_WEBHOOK  incoming-webhook URL (optional)
//   FRAUD_ALERT_EMAIL          fallback mailbox (optional)
// With none configured the alert is still persisted by the caller (fraud_events) and logged.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendEmail, sendSms } from "../notify/deliver.ts";

export type AlertLevel = "info" | "warn" | "page";

export interface AlertResult {
  delivered: string[];
  failed: string[];
}

export async function routeFraudAlert(admin: SupabaseClient, level: AlertLevel, subject: string, body: string): Promise<AlertResult> {
  const out: AlertResult = { delivered: [], failed: [] };
  const text = `[Vireek fraud:${level}] ${subject}\n${body}`.slice(0, 1500);
  console.log(JSON.stringify({ event: "fraud_alert", level, subject }));

  const slack = Deno.env.get("FRAUD_ALERT_SLACK_WEBHOOK");
  if (slack) {
    try {
      const r = await fetch(slack, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
      (r.ok ? out.delivered : out.failed).push("slack");
    } catch {
      out.failed.push("slack");
    }
  }

  const scheduleId = Deno.env.get("FRAUD_ONCALL_SCHEDULE_ID");
  if (scheduleId && level !== "info") {
    try {
      const { data: memberId } = await admin.rpc("get_current_on_call", { p_schedule_id: scheduleId });
      if (memberId) {
        const { data: member } = await admin.from("team_members").select("member_phone, member_email").eq("id", memberId).maybeSingle();
        if (member?.member_phone && level === "page") {
          const r = await sendSms(member.member_phone, text.slice(0, 480));
          (r.ok ? out.delivered : out.failed).push("oncall_sms");
        }
        if (member?.member_email) {
          const r = await sendEmail(member.member_email, `Vireek fraud: ${subject}`.slice(0, 120), `<pre>${escapeHtml(text)}</pre>`, text);
          (r.ok ? out.delivered : out.failed).push("oncall_email");
        }
      }
    } catch {
      out.failed.push("oncall");
    }
  }

  const fallback = Deno.env.get("FRAUD_ALERT_EMAIL");
  if (fallback && out.delivered.length === 0) {
    const r = await sendEmail(fallback, `Vireek fraud: ${subject}`.slice(0, 120), `<pre>${escapeHtml(text)}</pre>`, text);
    (r.ok ? out.delivered : out.failed).push("email");
  }
  return out;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
