import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

// A claim gets a "due_soon" alert this many days before claim_deadline.
// It gets a separate, one-time "overdue" alert the day the deadline
// actually passes. Each stage fires at most once per claim, same pattern
// as check-warranty-alerts / reset_equipment_warranty_alert_stage.
const WARNING_WINDOW_DAYS = 7;

function daysUntil(dateIso: string): number {
  const ms = new Date(dateIso).getTime() - Date.now();
  return Math.ceil(ms / (1000 * 60 * 60 * 24));
}

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

    const { data: claims, error: claimsError } = await supabase
      .from("warranty_claims")
      .select("id, user_id, customer_name, manufacturer, claim_deadline, deadline_alert_stage, status")
      .not("claim_deadline", "is", null)
      .not("status", "in", "(denied,closed,credit_received)");

    if (claimsError) throw claimsError;

    const candidates = (claims ?? [])
      .map((c) => {
        const days = daysUntil(c.claim_deadline as string);
        const stage = days < 0 ? "overdue" : days <= WARNING_WINDOW_DAYS ? "due_soon" : null;
        return { c, stage, days };
      })
      .filter((x) => x.stage !== null && x.stage !== x.c.deadline_alert_stage);

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
