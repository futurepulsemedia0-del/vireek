import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

// A unit gets its first alert this many days before warranty_expires_at.
// It gets a second, separate alert the day it actually lapses. Each stage
// fires at most once per unit — see reset_equipment_warranty_alert_stage()
// in 20260928000000_warranty_intelligence.sql for how a unit re-enters the
// pool if its date is later corrected or extended.
const WARNING_WINDOW_DAYS = 30;

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

    const { data: equipment, error: equipmentError } = await supabase
      .from("equipment")
      .select("id, user_id, customer_id, equipment_type, make, model, warranty_expires_at, warranty_alert_stage")
      .eq("status", "active")
      .not("warranty_expires_at", "is", null);

    if (equipmentError) throw equipmentError;

    // Every unit currently sitting at expiring_soon or expired, with the
    // stage its date actually implies right now — filtered against the
    // stage already on record so nothing gets alerted twice.
    const candidates = (equipment ?? [])
      .map((eq) => {
        const days = daysUntil(eq.warranty_expires_at as string);
        const stage = days < 0 ? "expired" : days <= WARNING_WINDOW_DAYS ? "expiring_soon" : null;
        return { eq, stage, days };
      })
      .filter((c) => c.stage !== null && c.stage !== c.eq.warranty_alert_stage);

    if (candidates.length === 0) {
      return new Response(
        JSON.stringify({ alertsCreated: 0, checked: equipment?.length ?? 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const userIds = Array.from(new Set(candidates.map((c) => c.eq.user_id as string)));
    const customerIds = Array.from(new Set(candidates.map((c) => c.eq.customer_id as string)));

    const [{ data: profiles }, { data: customers }] = await Promise.all([
      supabase.from("profiles").select("id, notify_warranty_alert").in("id", userIds),
      supabase.from("customers").select("id, name").in("id", customerIds),
    ]);

    const notifyByUser = new Map((profiles ?? []).map((p) => [p.id as string, p.notify_warranty_alert !== false]));
    const nameByCustomer = new Map((customers ?? []).map((c) => [c.id as string, c.name as string]));

    let alertsCreated = 0;

    for (const { eq, stage, days } of candidates) {
      if (notifyByUser.get(eq.user_id as string) === false) continue;

      const label = [eq.make, eq.model].filter(Boolean).join(" ") || (eq.equipment_type as string);
      const customerName = nameByCustomer.get(eq.customer_id as string) ?? "a customer";

      const title = stage === "expired" ? "Equipment warranty expired" : "Equipment warranty expiring soon";
      const message =
        stage === "expired"
          ? `The warranty on ${label} for ${customerName} expired ${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} ago.`
          : `The warranty on ${label} for ${customerName} expires in ${days} day${days === 1 ? "" : "s"} — good time for a check-in or an extended-coverage offer.`;

      const { error: insertError } = await supabase.from("notifications").insert({
        user_id: eq.user_id,
        type: "warranty_alert",
        title,
        message,
        action_url: `/dashboard/customers/${eq.customer_id}`,
        equipment_id: eq.id,
      });

      if (insertError) continue;

      await supabase
        .from("equipment")
        .update({ warranty_alert_stage: stage, warranty_alert_sent_at: new Date().toISOString() })
        .eq("id", eq.id);

      alertsCreated++;
    }

    return new Response(
      JSON.stringify({ alertsCreated, checked: equipment?.length ?? 0 }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
