// Cron-triggered (same pattern as weather-surge-check): every few minutes,
// finds jobs marked "no_show" that haven't been texted yet, and sends the
// customer their existing self-reschedule link (jobs.reschedule_token /
// /reschedule/:token — already built, just never wired to an automatic text).
//
// Deploy:
//   supabase functions deploy automation-no-show-reschedule --no-verify-jwt
//   supabase secrets set NO_SHOW_CRON_SECRET=<random-string>
// Point a scheduler at this URL every 10-15 minutes with header
// X-Cron-Secret: <that value>.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendCompliantSms } from "../_shared/messaging/sendSms.ts";
import { isAutomationEnabled } from "../_shared/automation/gate.ts";

Deno.serve(async (req: Request) => {
  const cronSecret = Deno.env.get("NO_SHOW_CRON_SECRET");
  if (cronSecret && req.headers.get("X-Cron-Secret") !== cronSecret) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  const { data: jobs, error } = await admin
    .from("jobs")
    .select("id, user_id, customer_name, customer_phone, reschedule_token")
    .eq("job_status", "no_show")
    .is("no_show_text_sent_at", null)
    .not("customer_phone", "is", null);

  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

  const siteUrl = (Deno.env.get("SITE_URL") ?? "https://app.vireek.com").replace(/\/$/, "");
  let sent = 0, skipped = 0, failed = 0;

  for (const job of jobs ?? []) {
    if (!(await isAutomationEnabled(admin, job.user_id, "no-show-reschedule"))) {
      skipped += 1;
      continue;
    }

    const link = `${siteUrl}/reschedule/${job.reschedule_token}`;
    const body = `Hi ${job.customer_name}, we missed you for your scheduled appointment. Pick a new time here: ${link}`;

    const result = await sendCompliantSms(admin, job.user_id, job.customer_phone as string, body);

    if (result.ok) {
      await admin.from("jobs").update({ no_show_text_sent_at: new Date().toISOString() }).eq("id", job.id);
      sent += 1;
    } else {
      console.error(JSON.stringify({ event: "no_show_text_failed", job_id: job.id, reason: result.reason }));
      failed += 1;
    }
  }

  return new Response(JSON.stringify({ sent, skipped, failed }), { headers: { "Content-Type": "application/json" } });
});
