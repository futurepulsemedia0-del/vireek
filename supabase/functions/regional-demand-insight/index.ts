import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { analyzeRegionalDemand } from "../_shared/ai-core/regionalDemandNarrative.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

interface MyLocalMetrics {
  current_week_calls: number;
  prior_week_calls: number;
  current_week_leads: number;
  top_localities: { name: string; count: number }[];
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    const authClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await authClient.auth.getUser();
    if (!user) return new Response(JSON.stringify({ error: "Not authenticated." }), { status: 401, headers: jsonHeaders });

    const { my_metrics } = (await req.json()) as { my_metrics: MyLocalMetrics };
    if (!my_metrics) return new Response(JSON.stringify({ error: "my_metrics is required." }), { status: 400, headers: jsonHeaders });

    const db = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

    // Never trust a region/industry from the client for the CROSS-TENANT
    // side — always re-derive it from the caller's own profile, then let
    // RLS's sample_size >= 5 floor decide whether they're allowed to see it.
    const { data: profile } = await db
      .from("business_profile")
      .select("service_area, primary_industry")
      .eq("user_id", user.id)
      .maybeSingle();

    let regionRow: Record<string, unknown> | null = null;
    if (profile?.service_area && profile?.primary_industry) {
      const { data: region } = await db
        .from("regional_demand_snapshots")
        .select("*")
        .eq("industry", profile.primary_industry)
        .eq("region_key", profile.service_area.trim().toLowerCase())
        .gte("sample_size", 5)
        .maybeSingle();
      regionRow = region;
    }

    const metrics = { my_local: my_metrics, region: regionRow };
    const insights = await analyzeRegionalDemand(metrics);

    return new Response(JSON.stringify({ insights, region: regionRow }), { status: 200, headers: jsonHeaders });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }),
      { status: 500, headers: jsonHeaders },
    );
  }
});
