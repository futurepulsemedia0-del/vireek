import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    });

    // Find all profiles where usage >= 80% of included minutes
    const { data: profiles, error } = await supabase
      .from("profiles")
      .select("id, minutes_used_this_month, minutes_included")
      .gte("minutes_used_this_month", 0);

    if (error) throw error;

    let alertsCreated = 0;

    for (const profile of profiles ?? []) {
      const pct = profile.minutes_included > 0
        ? (profile.minutes_used_this_month / profile.minutes_included) * 100
        : 0;

      if (pct < 80) continue;

      // Check if an active alert already exists
      const { data: existing } = await supabase
        .from("ai_insights")
        .select("id")
        .eq("user_id", profile.id)
        .ilike("title", "%included minutes%")
        .order("created_at", { ascending: false })
        .limit(1);

      if (existing && existing.length > 0) continue;

      const isCritical = pct >= 90;
      await supabase.from("ai_insights").insert({
        user_id: profile.id,
        insight_type: "alert",
        title: isCritical
          ? "Minutes usage near plan limit"
          : "Minutes usage approaching plan limit",
        description: `You've used ${Math.round(pct)}% of your included minutes this month (${profile.minutes_used_this_month} of ${profile.minutes_included}). Consider upgrading to avoid overage charges.`,
      });
      alertsCreated++;
    }

    return new Response(
      JSON.stringify({ alertsCreated, checked: profiles?.length ?? 0 }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
