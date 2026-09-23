// supabase/functions/franchise-royalty-issue/index.ts
//
// دکمه‌ی "Generate & Notify" در Franchise Governance این را صدا می‌زند:
// generate_royalty_statements را اجرا می‌کند و به هر شعبه‌ای که صورت‌حساب
// تازه صادر شده، پیامک اطلاع‌رسانی می‌فرستد.
//
// Deploy: supabase functions deploy franchise-royalty-issue

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendSms } from "../_shared/notify/deliver.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

interface Payload {
  group_id?: string;
  period_start?: string;
  period_end?: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResponse({ error: "Unauthorized" }, 401);

  // Use the caller's own JWT for the RPC so franchise_groups ownership is
  // checked exactly as it would be from the dashboard directly.
  const callerClient = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false },
    global: { headers: { Authorization: authHeader } },
  });

  let payload: Payload;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }
  if (!payload.group_id || !payload.period_start || !payload.period_end) {
    return jsonResponse({ error: "group_id, period_start, period_end are required" }, 400);
  }

  const { data: statements, error } = await callerClient.rpc("generate_royalty_statements", {
    p_group_id: payload.group_id,
    p_period_start: payload.period_start,
    p_period_end: payload.period_end,
  });
  if (error) return jsonResponse({ error: error.message }, 400);

  let notified = 0;
  const siteUrl = (Deno.env.get("SITE_URL") ?? "https://app.vireek.com").replace(/\/$/, "");

  for (const stmt of statements ?? []) {
    try {
      const { data: location } = await admin
        .from("franchise_locations")
        .select("location_profile_id")
        .eq("id", stmt.location_id)
        .maybeSingle();
      if (!location?.location_profile_id) continue;
      const { data: profile } = await admin.from("profiles").select("phone").eq("id", location.location_profile_id).maybeSingle();
      if (profile?.phone) {
        const amount = (stmt.royalty_amount_cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 });
        const result = await sendSms(profile.phone, `Vireek: A new royalty statement ($${amount}) has been issued for ${payload.period_start}–${payload.period_end}. View: ${siteUrl}/dashboard/franchise/governance`);
        if (result.ok) notified += 1;
      }
    } catch (err) {
      console.error(JSON.stringify({ event: "royalty_notify_failed", statement_id: stmt.id, error: err instanceof Error ? err.message : String(err) }));
    }
  }

  return jsonResponse({ issued: (statements ?? []).length, notified });
});
