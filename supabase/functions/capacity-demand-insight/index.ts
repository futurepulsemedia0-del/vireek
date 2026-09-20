// supabase/functions/capacity-demand-insight/index.ts
//
// Mirrors regional-demand-insight/index.ts's shape. Runs the deterministic
// decision (run_capacity_demand_control, SECURITY DEFINER, scoped to the
// caller's own account via get_account_owner_id() — no data is passed in
// from the client, so there is nothing here for a caller to spoof) and
// hands the result to the AI narrative layer for a plain-language summary.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { analyzeCapacityDemand } from "../_shared/ai-core/capacityDemandNarrative.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

    const authClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await authClient.auth.getUser();
    if (!user) return new Response(JSON.stringify({ error: "Not authenticated." }), { status: 401, headers: jsonHeaders });

    let body: { date?: string } = {};
    try {
      body = await req.json();
    } catch {
      // no body is fine — defaults to today server-side
    }

    // Runs AS the authenticated user (not the service role) so
    // get_account_owner_id() inside the RPC resolves correctly and RLS
    // still applies — this function has no elevated access at all.
    const { data: status, error } = await authClient.rpc("run_capacity_demand_control", {
      p_date: body.date ?? new Date().toISOString().slice(0, 10),
    });
    if (error) throw error;

    const insights = await analyzeCapacityDemand(status as Record<string, unknown>);

    return new Response(JSON.stringify({ status, insights }), { status: 200, headers: jsonHeaders });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }),
      { status: 500, headers: jsonHeaders },
    );
  }
});
