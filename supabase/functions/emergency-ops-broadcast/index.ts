// supabase/functions/emergency-ops-broadcast/index.ts
//
// مخابرات جمعی: پیامک به مشتریانِ کارهای باز، به کل تیم، یا فقط on-call
// فعلی. فقط توسط کاربر لاگین‌شده (صاحب/عضو تیم) صدا زده می‌شود؛ نوشتن در
// جدول لاگ emergency_broadcasts فقط با service_role است.
//
// Deploy: supabase functions deploy emergency-ops-broadcast

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendSms } from "../_shared/notify/deliver.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const MAX_RECIPIENTS = 300; // سقف امنیتی برای جلوگیری از هزینه‌ی ناخواسته

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

interface Payload {
  message?: string;
  audience?: "customers" | "team" | "on_call";
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

  const message = payload.message?.trim();
  const audience = payload.audience;
  if (!message || !audience || !["customers", "team", "on_call"].includes(audience)) {
    return jsonResponse({ error: "message and a valid audience are required" }, 400);
  }

  let phones: string[] = [];

  if (audience === "on_call") {
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
        const { data: member } = await admin.from("team_members").select("member_phone").eq("id", memberId).maybeSingle();
        if (member?.member_phone) phones = [member.member_phone];
      }
    }
  } else if (audience === "team") {
    const [{ data: members }, { data: owner }] = await Promise.all([
      admin.from("team_members").select("member_phone").eq("account_owner_id", userId).not("member_phone", "is", null),
      admin.from("profiles").select("phone").eq("id", userId).maybeSingle(),
    ]);
    phones = [...(members ?? []).map((m) => m.member_phone as string), ...(owner?.phone ? [owner.phone] : [])];
  } else {
    // customers: مشتریان با کارِ باز در ۷۲ ساعت آینده
    const { data: jobs } = await admin
      .from("jobs")
      .select("customer_name, lead_id")
      .eq("user_id", userId)
      .not("job_status", "in", "(completed,cancelled)")
      .lte("scheduled_datetime", new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString());
    const leadIds = (jobs ?? []).map((j) => j.lead_id).filter((id): id is string => !!id);
    if (leadIds.length > 0) {
      const { data: leads } = await admin.from("leads").select("phone").in("id", leadIds).not("phone", "is", null);
      phones = (leads ?? []).map((l) => l.phone as string);
    }
  }

  phones = [...new Set(phones)].filter(Boolean).slice(0, MAX_RECIPIENTS);
  const targeted = phones.length;
  let sent = 0;

  for (const phone of phones) {
    try {
      const result = await sendSms(phone, message);
      if (result.ok) sent += 1;
    } catch (err) {
      console.error(JSON.stringify({ event: "emergency_broadcast_sms_failed", user_id: userId, error: err instanceof Error ? err.message : String(err) }));
    }
  }

  await admin.from("emergency_broadcasts").insert({
    user_id: userId,
    message,
    audience,
    recipients_targeted: targeted,
    recipients_sent: sent,
    triggered_by: "manual",
  });

  return jsonResponse({ targeted, sent });
});
