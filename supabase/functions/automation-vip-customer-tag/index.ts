// Thin wrapper around the apply_vip_customer_tags() SQL sweep — logic lives
// in the DB as a set-based operation (much cheaper than looping every
// customer of every business in JS). Cron-triggered like the other sweeps.
//
// Deploy:
//   supabase functions deploy automation-vip-customer-tag --no-verify-jwt
//   supabase secrets set VIP_TAG_CRON_SECRET=<random-string>

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

Deno.serve(async (req: Request) => {
  const cronSecret = Deno.env.get("VIP_TAG_CRON_SECRET");
  if (cronSecret && req.headers.get("X-Cron-Secret") !== cronSecret) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  const { data, error } = await admin.rpc("apply_vip_customer_tags");
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

  return new Response(JSON.stringify({ results: data }), { headers: { "Content-Type": "application/json" } });
});
