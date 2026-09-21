// Cron-triggered sweep. All the "who qualifies" logic lives in the
// find_seasonal_maintenance_candidates() SQL function (set-based, and
// already filtered to businesses with this automation active) — this
// function just sends the texts and records that it did.
//
// Deploy:
//   supabase functions deploy automation-seasonal-maintenance-reminder --no-verify-jwt
//   supabase secrets set SEASONAL_REMINDER_CRON_SECRET=<random-string>

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendCompliantSms } from "../_shared/messaging/sendSms.ts";

Deno.serve(async (req: Request) => {
  const cronSecret = Deno.env.get("SEASONAL_REMINDER_CRON_SECRET");
  if (cronSecret && req.headers.get("X-Cron-Secret") !== cronSecret) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  const { data: candidates, error } = await admin.rpc("find_seasonal_maintenance_candidates");
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

  let sent = 0, failed = 0;

  for (const c of candidates ?? []) {
    const body = `Hi ${c.customer_name}, it's been about a year since your last ${c.service_type} service. Call or text us back to schedule your seasonal maintenance.`;
    const result = await sendCompliantSms(admin, c.user_id, c.customer_phone, body);

    if (result.ok) {
      await admin.from("seasonal_maintenance_reminders").upsert(
        { user_id: c.user_id, customer_phone: c.customer_phone, service_type: c.service_type, last_reminded_at: new Date().toISOString() },
        { onConflict: "user_id,customer_phone,service_type" },
      );
      sent += 1;
    } else {
      console.error(JSON.stringify({ event: "seasonal_reminder_failed", user_id: c.user_id, reason: result.reason }));
      failed += 1;
    }
  }

  return new Response(JSON.stringify({ sent, failed }), { headers: { "Content-Type": "application/json" } });
});
