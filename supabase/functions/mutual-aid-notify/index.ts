// supabase/functions/mutual-aid-notify/index.ts
//
// Fires the two SMS side-effects for the Disaster Mutual-Aid Network.
// The actual DB writes (insert offer / accept offer) happen client-side
// in src/pages/MutualAidPage.tsx under normal RLS — this function is
// called right after, purely for the notification. Kept isolated so a
// Twilio hiccup never blocks the write itself, same principle as
// escalate-emergency's SMS step.
//
// Deploy: supabase functions deploy mutual-aid-notify

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendSms } from "../_shared/notify/deliver.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface Payload {
  request_id?: string;
  offer_id?: string;
  event?: "new_offer" | "offer_accepted";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: corsHeaders });
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );
  const siteUrl = (Deno.env.get("SITE_URL") ?? "https://app.vireek.com").replace(/\/$/, "");

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders });
  const { data: userData, error: userError } = await admin.auth.getUser(authHeader.replace(/^Bearer\s+/i, ""));
  if (userError || !userData?.user) return new Response(JSON.stringify({ error: "Invalid session" }), { status: 401, headers: corsHeaders });

  let payload: Payload;
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: corsHeaders });
  }
  if (!payload.request_id || !payload.offer_id || !payload.event) {
    return new Response(JSON.stringify({ error: "Missing fields" }), { status: 400, headers: corsHeaders });
  }

  const { data: request } = await admin
    .from("mutual_aid_requests")
    .select("id, user_id")
    .eq("id", payload.request_id)
    .maybeSingle();
  const { data: offer } = await admin
    .from("mutual_aid_offers")
    .select("id, offering_user_id, offer_type")
    .eq("id", payload.offer_id)
    .maybeSingle();

  if (!request || !offer) return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: corsHeaders });

  const callerId = userData.user.id;
  if (callerId !== request.user_id && callerId !== offer.offering_user_id) {
    return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: corsHeaders });
  }

  if (payload.event === "new_offer") {
    const [{ data: requesterProfile }, { data: offeringProfile }] = await Promise.all([
      admin.from("profiles").select("phone").eq("id", request.user_id).maybeSingle(),
      admin.from("profiles").select("company_name").eq("id", offer.offering_user_id).maybeSingle(),
    ]);
    if (requesterProfile?.phone) {
      await sendSms(
        requesterProfile.phone,
        `Vireek Mutual Aid: ${offeringProfile?.company_name ?? "A nearby business"} offered help (${offer.offer_type}). Review it: ${siteUrl}/dashboard/mutual-aid`,
      );
    }
  }

  if (payload.event === "offer_accepted") {
    const [{ data: offeringBiz }, { data: requesterBiz }, { data: offeringProfile }, { data: requesterProfile }] = await Promise.all([
      admin.from("business_profile").select("mutual_aid_contact_phone").eq("user_id", offer.offering_user_id).maybeSingle(),
      admin.from("business_profile").select("mutual_aid_contact_phone").eq("user_id", request.user_id).maybeSingle(),
      admin.from("profiles").select("phone").eq("id", offer.offering_user_id).maybeSingle(),
      admin.from("profiles").select("phone, company_name").eq("id", request.user_id).maybeSingle(),
    ]);
    const offeringPhone = offeringBiz?.mutual_aid_contact_phone || offeringProfile?.phone;
    const requesterPhone = requesterBiz?.mutual_aid_contact_phone || requesterProfile?.phone;
    if (offeringPhone) {
      await sendSms(
        offeringPhone,
        `Vireek Mutual Aid: ${requesterProfile?.company_name ?? "The requesting business"} accepted your offer! Contact: ${requesterPhone ?? "check the dashboard"}`,
      );
    }
  }

  return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
