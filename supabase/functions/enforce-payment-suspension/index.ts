// supabase/functions/enforce-payment-suspension/index.ts
//
// The actual "cut off service" half of dunning. `stripe-webhook` reacts to
// Stripe *events* (a failed charge, a canceled subscription) — but the
// grace-period deadline itself is just the passage of time, which no
// webhook fires for. This function is meant to run on a schedule (e.g.
// hourly) and suspends any account whose grace period has quietly expired
// with the card still unfixed.
//
// Required secrets: none beyond the Supabase service role, which Edge
// Functions already have access to via SUPABASE_SERVICE_ROLE_KEY.
//
// Deploy:
//   supabase functions deploy enforce-payment-suspension
//
// Schedule it (pick one):
//   - Supabase Dashboard -> Edge Functions -> enforce-payment-suspension ->
//     "Add a cron schedule" -> e.g. "0 * * * *" (hourly). This is the
//     simplest option and needs no extra SQL.
//   - Or, if your project already has the pg_cron + pg_net extensions
//     enabled, schedule it from SQL instead:
//       select cron.schedule(
//         'enforce-payment-suspension-hourly',
//         '0 * * * *',
//         $$
//         select net.http_post(
//           url := 'https://<project-ref>.supabase.co/functions/v1/enforce-payment-suspension',
//           headers := jsonb_build_object('Authorization', 'Bearer <service-role-key>')
//         );
//         $$
//       );

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

Deno.serve(async (_req: Request) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  const nowIso = new Date().toISOString();

  // Anyone still `past_due` whose grace period is in the past gets
  // suspended. `status` is flipped alongside `subscription_status` so any
  // access-gating code that already checks `profiles.status` (or gets
  // added later) suspends these accounts too, with no extra wiring.
  const { data: suspended, error } = await admin
    .from("profiles")
    .update({ subscription_status: "suspended", status: "suspended" })
    .eq("subscription_status", "past_due")
    .lt("payment_grace_period_ends_at", nowIso)
    .select("id, email");

  if (error) {
    console.error("enforce-payment-suspension failed:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(
    JSON.stringify({ suspended_count: suspended?.length ?? 0, suspended_ids: (suspended ?? []).map((p) => p.id) }),
    { headers: { "Content-Type": "application/json" } },
  );
});
