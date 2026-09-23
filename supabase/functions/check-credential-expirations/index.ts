import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

// Same alert-once-per-stage pattern as check-warranty-alerts: a
// "expiring_soon" alert this many days before expires_at, a separate
// "expired" alert the day it actually lapses.
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

    const { data: credentials, error: credError } = await supabase
      .from("technician_credentials")
      .select("id, user_id, technician_id, credential_type, credential_name, expires_at, expiry_alert_stage")
      .eq("status", "active")
      .not("expires_at", "is", null);

    if (credError) throw credError;

    const candidates = (credentials ?? [])
      .map((cred) => {
        const days = daysUntil(cred.expires_at as string);
        const stage = days < 0 ? "expired" : days <= WARNING_WINDOW_DAYS ? "expiring_soon" : null;
        return { cred, stage, days };
      })
      .filter((x) => x.stage !== null && x.stage !== x.cred.expiry_alert_stage);

    if (candidates.length === 0) {
      return new Response(
        JSON.stringify({ alertsCreated: 0, checked: credentials?.length ?? 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const userIds = Array.from(new Set(candidates.map((x) => x.cred.user_id as string)));
    const technicianIds = Array.from(new Set(candidates.map((x) => x.cred.technician_id as string)));

    const [{ data: profiles }, { data: technicians }] = await Promise.all([
      supabase.from("profiles").select("id, notify_credential_expiry").in("id", userIds),
      supabase.from("team_members").select("id, member_name").in("id", technicianIds),
    ]);

    const notifyByUser = new Map((profiles ?? []).map((p) => [p.id as string, p.notify_credential_expiry !== false]));
    const nameByTech = new Map((technicians ?? []).map((t) => [t.id as string, t.member_name as string]));

    let alertsCreated = 0;

    for (const { cred, stage, days } of candidates) {
      if (notifyByUser.get(cred.user_id as string) === false) continue;

      const techName = nameByTech.get(cred.technician_id as string) ?? "A technician";
      const label = (cred.credential_name as string) || (cred.credential_type as string);

      const title = stage === "expired" ? "Technician credential expired" : "Technician credential expiring soon";
      const message =
        stage === "expired"
          ? `${techName}'s ${label} expired ${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} ago — they may now be blocked from dispatch on jobs that require it.`
          : `${techName}'s ${label} expires in ${days} day${days === 1 ? "" : "s"} — renew it to avoid a dispatch hold.`;

      const { error: insertError } = await supabase.from("notifications").insert({
        user_id: cred.user_id,
        type: "credential_expiry",
        title,
        message,
        action_url: "/dashboard/compliance",
        credential_id: cred.id,
      });

      if (insertError) continue;

      await supabase
        .from("technician_credentials")
        .update({ expiry_alert_stage: stage, expiry_alert_sent_at: new Date().toISOString() })
        .eq("id", cred.id);

      alertsCreated++;
    }

    return new Response(
      JSON.stringify({ alertsCreated, checked: credentials?.length ?? 0 }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
