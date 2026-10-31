import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { pickAlertCandidates } from "../_shared/warranty/claimDeadlines.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

// A claim gets a "due_soon" alert WARNING_WINDOW_DAYS before claim_deadline and a separate,
// one-time "overdue" alert once the deadline has passed. Each stage fires at most once per
// claim, same pattern as check-warranty-alerts / reset_equipment_warranty_alert_stage.
// The stage rules live in ../_shared/warranty/claimDeadlines.ts (unit tested).

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const cronSecret = Deno.env.get("WARRANTY_CLAIM_CRON_SECRET") ?? "";
  const provided = req.headers.get("X-Cron-Secret") ?? "";
  if (!cronSecret || provided !== cronSecret) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    });

    const { data: claims, error: claimsError } = await supabase
      .from("warranty_claims")
      .select("id, user_id, customer_name, manufacturer, claim_deadline, deadline_alert_stage, status")
      .not("claim_deadline", "is", null)
      .in("status", ["needs_review", "ready", "eligible", "packet_pending"]);

    if (claimsError) throw claimsError;

    const candidates = pickAlertCandidates(claims ?? []);

    if (candidates.length === 0) {
      return new Response(
        JSON.stringify({ alertsCreated: 0, checked: claims?.length ?? 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const userIds = Array.from(new Set(candidates.map((x) => x.c.user_id as string)));
    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, notify_warranty_claim_deadline")
      .in("id", userIds);

    const notifyByUser = new Map(
      (profiles ?? []).map((p) => [p.id as string, p.notify_warranty_claim_deadline !== false]),
    );

    let alertsCreated = 0;

    for (const { c, stage, days } of candidates) {
      if (notifyByUser.get(c.user_id as string) === false) continue;

      const label = (c.manufacturer as string) || "this unit";
      const title = stage === "overdue" ? "Warranty claim deadline missed" : "Warranty claim deadline approaching";
      const message =
        stage === "overdue"
          ? `The manufacturer warranty claim for ${c.customer_name} (${label}) missed its filing deadline ${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} ago.`
          : `The manufacturer warranty claim for ${c.customer_name} (${label}) must be submitted within ${days} day${days === 1 ? "" : "s"}.`;

      const { error: insertError } = await supabase.from("notifications").insert({
        user_id: c.user_id,
        type: "warranty_claim_deadline",
        title,
        message,
        action_url: "/dashboard/warranty-claims",
        warranty_claim_id: c.id,
      });

      if (insertError) continue;

      await supabase
        .from("warranty_claims")
        .update({ deadline_alert_stage: stage, deadline_alert_sent_at: new Date().toISOString() })
        .eq("id", c.id);

      alertsCreated++;
    }

    return new Response(
      JSON.stringify({ alertsCreated, checked: claims?.length ?? 0 }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
