import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

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

    const { data: contracts, error: contractsError } = await supabase
      .from("commercial_contracts")
      .select("id, user_id, customer_id, contract_name, end_date, renewal_notice_days, auto_renew, status, renewal_alert_stage")
      .in("status", ["active", "expiring_soon"])
      .not("end_date", "is", null);

    if (contractsError) throw contractsError;

    // Each contract uses its OWN renewal_notice_days as the warning
    // window (unlike warranty's fixed 30-day window) — that field exists
    // specifically so different contracts can have different notice
    // periods. Filtered against the stage already on record so nothing
    // gets alerted twice.
    const candidates = (contracts ?? [])
      .map((c) => {
        const days = daysUntil(c.end_date as string);
        const window = (c.renewal_notice_days as number) ?? 30;
        const stage = days < 0 ? "expired" : days <= window ? "expiring_soon" : null;
        return { c, stage, days };
      })
      .filter((x) => x.stage !== null && x.stage !== x.c.renewal_alert_stage);

    if (candidates.length === 0) {
      return new Response(
        JSON.stringify({ alertsCreated: 0, checked: contracts?.length ?? 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const userIds = Array.from(new Set(candidates.map((x) => x.c.user_id as string)));

    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, notify_contract_renewal")
      .in("id", userIds);

    const notifyByUser = new Map((profiles ?? []).map((p) => [p.id as string, p.notify_contract_renewal !== false]));

    let alertsCreated = 0;

    for (const { c, stage, days } of candidates) {
      if (notifyByUser.get(c.user_id as string) === false) continue;

      const name = c.contract_name as string;
      const autoRenewNote = c.auto_renew ? " It's set to auto-renew." : " It is NOT set to auto-renew.";

      const title = stage === "expired" ? "Contract expired" : "Contract renewal coming up";
      const message =
        stage === "expired"
          ? `"${name}" expired ${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} ago.${autoRenewNote}`
          : `"${name}" is due for renewal in ${days} day${days === 1 ? "" : "s"}.${autoRenewNote}`;

      const { error: insertError } = await supabase.from("notifications").insert({
        user_id: c.user_id,
        type: "contract_renewal_alert",
        title,
        message,
        action_url: "/dashboard/contracts",
        contract_id: c.id,
      });

      if (insertError) continue;

      // Reflect the stage in status too — 'active' -> 'expiring_soon' ->
      // 'expired' — but never override a status a human already set to
      // something else ('terminated', 'renewed', 'draft').
      const nextStatus =
        stage === "expired" && c.status !== "expired" ? "expired" : stage === "expiring_soon" && c.status === "active" ? "expiring_soon" : null;

      const update: Record<string, unknown> = {
        renewal_alert_stage: stage,
        renewal_alert_sent_at: new Date().toISOString(),
      };
      if (nextStatus) update.status = nextStatus;

      await supabase.from("commercial_contracts").update(update).eq("id", c.id);

      alertsCreated++;
    }

    return new Response(
      JSON.stringify({ alertsCreated, checked: contracts?.length ?? 0 }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
