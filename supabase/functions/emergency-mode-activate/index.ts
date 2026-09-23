// supabase/functions/emergency-mode-activate/index.ts
//
// دکمه‌ی "Activate/Deactivate Emergency Mode" در داشبورد این را صدا می‌زند.
// فعال‌سازی: activate_emergency_mode -> rebuild_emergency_triage_queue ->
// پیامک به on-call فعلی (اگر رول فعالی وجود داشته باشد).
//
// Deploy: supabase functions deploy emergency-mode-activate

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
  action?: "activate" | "deactivate";
  headline?: string;
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
  const { data: userData, error: userError } = await admin.auth.getUser(authHeader.replace(/^Bearer\s+/i, ""));
  if (userError || !userData?.user) return jsonResponse({ error: "Invalid session" }, 401);
  const userId = userData.user.id;

  let payload: Payload;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  if (payload.action === "deactivate") {
    const { error } = await admin.rpc("deactivate_emergency_mode", { p_user_id: userId });
    if (error) return jsonResponse({ error: error.message }, 400);
    return jsonResponse({ deactivated: true });
  }

  // action === "activate" (default)
  const headline = payload.headline?.trim() || "Emergency Operations Mode manually declared.";
  const { data: activated, error: activateError } = await admin.rpc("activate_emergency_mode", {
    p_user_id: userId,
    p_source: "manual",
    p_headline: headline,
  });
  if (activateError) return jsonResponse({ error: activateError.message }, 400);

  if (!activated) {
    return jsonResponse({ activated: false, note: "Already active or blocked by an existing state." });
  }

  const { data: triageCount } = await admin.rpc("rebuild_emergency_triage_queue", { p_user_id: userId });

  let onCallNotified = false;
  try {
    const { data: schedule } = await admin
      .from("on_call_schedules")
      .select("id")
      .eq("user_id", userId)
      .eq("is_active", true)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (schedule?.id) {
      const { data: memberId } = await admin.rpc("get_current_on_call", { p_schedule_id: schedule.id });
      if (memberId) {
        const { data: member } = await admin
          .from("team_members")
          .select("member_phone, member_name")
          .eq("id", memberId)
          .maybeSingle();
        if (member?.member_phone) {
          const siteUrl = (Deno.env.get("SITE_URL") ?? "https://app.vireek.com").replace(/\/$/, "");
          const smsResult = await sendSms(
            member.member_phone,
            `Vireek: Emergency Operations Mode is now ACTIVE. ${headline} Check the triage queue: ${siteUrl}/dashboard/emergency-ops`,
          );
          onCallNotified = smsResult.ok;
        }
      }
    }
  } catch (err) {
    console.error(JSON.stringify({ event: "emergency_oncall_notify_failed", user_id: userId, error: err instanceof Error ? err.message : String(err) }));
  }

  return jsonResponse({ activated: true, triage_count: triageCount ?? 0, on_call_notified: onCallNotified });
});
