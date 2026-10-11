// supabase/functions/deferred-message-dispatcher/index.ts
//
// Schedule every 5 minutes (same X-Cron-Secret pattern as outbound-dialer). Claims due rows
// from deferred_messages and sends them. Before every send the gate is RE-RUN, so a holiday
// added while the message waited, a changed customer timezone, or an opt-out is respected.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendEmail, sendSms } from "../_shared/notify/deliver.ts";
import { sendCompliantSms } from "../_shared/messaging/sendSms.ts";
import { gateOutbound } from "../_shared/messaging/quietHours.ts";

const BATCH = 50;
const MAX_ATTEMPTS = 5;

interface Row {
  id: string;
  user_id: string;
  channel: "sms" | "email" | "call";
  transport: "a2p" | "plain";
  purpose: "marketing" | "service" | "emergency";
  to_address: string;
  subject: string | null;
  body_text: string;
  body_html: string | null;
  customer_id: string | null;
  attempts: number;
  override_reason: string | null;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  const cronSecret = Deno.env.get("CRON_SECRET");
  if (cronSecret && req.headers.get("X-Cron-Secret") !== cronSecret) return json({ error: "Unauthorized" }, 401);

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

  const { data, error } = await admin.rpc("claim_due_deferred_messages", { p_limit: BATCH });
  if (error) return json({ error: error.message }, 500);

  let sent = 0, rescheduled = 0, failed = 0, retried = 0;

  for (const row of (data ?? []) as Row[]) {
    try {
      if (row.channel === "call") {
        await finish(admin, row, "failed", "Deferred calls are not supported; calls reschedule via outbound_calls.");
        failed++;
        continue;
      }

      // Re-run the gate with the freshest settings / timezone / holidays.
      const outcome = await gateOutbound(admin, row.user_id, {
        channel: row.channel,
        to: row.to_address,
        purpose: row.purpose,
        customerId: row.customer_id,
        override: row.override_reason ? { reason: row.override_reason } : null,
        source: "deferred-message-dispatcher",
      });
      if (!outcome.proceed) {
        // Still held: push back and give the attempt back (waiting is not a failure).
        await admin.from("deferred_messages").update({
          status: "queued", send_after: outcome.sendAt, attempts: Math.max(0, row.attempts - 1), defer_reason: outcome.decision.reason,
        }).eq("id", row.id);
        rescheduled++;
        continue;
      }

      let ok = false;
      let terminal = false;
      let detail = "";
      let ref: string | null = null;

      if (row.channel === "sms" && row.transport === "a2p") {
        const r = await sendCompliantSms(admin, row.user_id, row.to_address, row.body_text, { skipQuietHours: true, purpose: row.purpose, source: "deferred-message-dispatcher" });
        if (r.ok) { ok = true; ref = r.sid; }
        else {
          detail = `${r.reason}${r.detail ? `: ${r.detail}` : ""}`;
          terminal = r.reason === "A2P_NOT_APPROVED" || r.reason === "OPTED_OUT" || r.reason === "NOT_CONFIGURED";
        }
      } else if (row.channel === "sms") {
        const r = await sendSms(row.to_address, row.body_text);
        ok = r.ok; detail = r.error ?? "";
      } else {
        const r = await sendEmail(row.to_address, row.subject ?? "(no subject)", row.body_html ?? `<p>${row.body_text}</p>`, row.body_text);
        ok = r.ok; detail = r.error ?? "";
      }

      if (ok) {
        await admin.from("deferred_messages").update({ status: "sent", sent_at: new Date().toISOString(), provider_ref: ref, last_error: null }).eq("id", row.id);
        sent++;
      } else if (terminal || row.attempts >= MAX_ATTEMPTS) {
        await finish(admin, row, "failed", detail);
        failed++;
      } else {
        const backoffMin = 10 * row.attempts;
        await admin.from("deferred_messages").update({
          status: "queued", send_after: new Date(Date.now() + backoffMin * 60_000).toISOString(), last_error: detail.slice(0, 500),
        }).eq("id", row.id);
        retried++;
      }
    } catch (e) {
      console.error(JSON.stringify({ event: "deferred_dispatch_row_failed", id: row.id, error: String(e) }));
      await admin.from("deferred_messages").update({ status: row.attempts >= MAX_ATTEMPTS ? "failed" : "queued", last_error: String(e).slice(0, 500) }).eq("id", row.id);
      failed++;
    }
  }

  return json({ ok: true, claimed: data?.length ?? 0, sent, rescheduled, retried, failed });
});

// deno-lint-ignore no-explicit-any
async function finish(admin: any, row: Row, status: "failed", detail: string) {
  await admin.from("deferred_messages").update({ status, last_error: detail.slice(0, 500) }).eq("id", row.id);
}
