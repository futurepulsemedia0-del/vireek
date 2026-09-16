import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendSms, sendEmail } from "../_shared/notify/deliver.ts";

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, X-Cron-Secret" };

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

const MAX_REMINDERS = 3;
const REMINDER_INTERVAL_DAYS = 3;
const OVERDUE_AFTER_DAYS = 14;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  const cronSecret = Deno.env.get("PAYMENT_REMINDER_CRON_SECRET");
  if (cronSecret && req.headers.get("X-Cron-Secret") !== cronSecret) return jsonResponse({ error: "Unauthorized." }, 401);

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

  try {
    const cutoff = new Date(Date.now() - REMINDER_INTERVAL_DAYS * 86400000).toISOString();
    const overdueCutoff = new Date(Date.now() - OVERDUE_AFTER_DAYS * 86400000).toISOString();

    const { data: due, error } = await admin
      .from("payment_requests")
      .select("id, customer_name, customer_email, customer_phone, amount, payment_link_url, reminder_count, created_at, status")
      .in("status", ["sent", "overdue"])
      .lt("last_reminder_sent_at", cutoff)
      .lt("reminder_count", MAX_REMINDERS);
    if (error) throw error;

    let sent = 0;
    for (const request of due ?? []) {
      const amountLabel = `$${Number(request.amount).toFixed(2)}`;
      if (request.customer_phone) {
        await sendSms(request.customer_phone, `Reminder: your ${amountLabel} invoice is still open. Pay here: ${request.payment_link_url}`);
      }
      if (request.customer_email) {
        await sendEmail(
          request.customer_email,
          `Reminder: ${amountLabel} invoice still open`,
          `<p>Hi ${request.customer_name}, a friendly reminder that your ${amountLabel} invoice hasn't been paid yet.</p><p><a href="${request.payment_link_url}">Pay ${amountLabel} now</a></p>`,
          `Reminder: your ${amountLabel} invoice is still open. Pay here: ${request.payment_link_url}`,
        );
      }
      const isOverdue = request.created_at < overdueCutoff;
      await admin
        .from("payment_requests")
        .update({ reminder_count: request.reminder_count + 1, last_reminder_sent_at: new Date().toISOString(), status: isOverdue ? "overdue" : request.status })
        .eq("id", request.id);
      sent += 1;
    }

    return jsonResponse({ reminders_sent: sent });
  } catch (error) {
    console.error(JSON.stringify({ event: "send_payment_reminders_failed", error: error instanceof Error ? error.message : String(error) }));
    return jsonResponse({ error: "Reminder run failed." }, 500);
  }
});
