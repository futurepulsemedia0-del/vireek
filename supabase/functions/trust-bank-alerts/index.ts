// supabase/functions/trust-bank-alerts/index.ts
//
// Reads get_trust_erosion_alerts() (real ledger data, RLS-scoped to the
// caller) and, only for the handful of customers that already crossed the
// erosion threshold, asks the AI router for one specific, personal
// intervention each. Cheap by construction: at most ~8 short rows in, a
// few short sentences out — no quota table needed, no photos, no bulk scan.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { suggestTrustInterventions, type TrustErosionAlert } from "../_shared/ai-core/trustBank.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: jsonHeaders });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

    const callerClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { auth: { persistSession: false }, global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user } } = await callerClient.auth.getUser();
    if (!user) return json({ error: "Not authenticated." }, 401);

    const { data, error } = await callerClient.rpc("get_trust_erosion_alerts", { p_limit: 8 });
    if (error) throw error;

    const alerts = (data ?? []) as TrustErosionAlert[];
    if (alerts.length === 0) return json({ alerts: [] });

    const interventions = await suggestTrustInterventions(alerts);
    const byId = new Map(interventions.map((i) => [i.customer_id, i]));

    const merged = alerts.map((a) => ({
      ...a,
      headline: byId.get(a.customer_id)?.headline ?? `Trust dropping for ${a.customer_name}`,
      intervention: byId.get(a.customer_id)?.intervention ?? "Reach out personally to check in before this slips further.",
    }));

    return json({ alerts: merged });
  } catch (err) {
    console.error("[trust-bank-alerts] unhandled error", err);
    return json({ error: err instanceof Error ? err.message : "Could not load trust alerts." }, 500);
  }
});
