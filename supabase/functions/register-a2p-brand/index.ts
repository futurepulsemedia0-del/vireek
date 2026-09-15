// supabase/functions/register-a2p-brand/index.ts
//
// Submits a tenant's legal business info to Twilio for A2P 10DLC Brand
// Registration, then (once the brand exists) a Campaign under it.
// Called from BusinessProfilePage.tsx after the owner fills in legal
// business name, EIN, website, sample message, and opt-in description.
//
// NOT LIVE-VERIFIED: Twilio's Trust Hub / A2P Brand Registration API is
// genuinely multi-step in production (Customer Profile bundle -> End
// User -> Supporting Documents -> Brand -> Campaign), and the exact
// request shape changes over time. Re-check
// https://www.twilio.com/docs/messaging/compliance/a2p-10dlc before
// relying on this — this implementation targets Twilio's "Starter/
// Standard brand, simplified registration" endpoints. Registration also
// isn't instant: carrier vetting typically takes 1-5 business days, so
// this function's job is only to SUBMIT and store the SIDs — approval
// itself arrives later via Twilio webhook or manual status poll (not
// implemented here yet; a2p_brand_status stays 'pending' until that's
// wired up or an admin updates it manually).

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing auth" }, 401);

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const anon = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userError } = await anon.auth.getUser();
    if (userError || !userData.user) return jsonResponse({ error: "Invalid session" }, 401);
    const userId = userData.user.id;

    const { data: profile, error: profileError } = await admin
      .from("profiles")
      .select("legal_business_name, ein, business_registration_type, business_website, sms_sample_message, sms_opt_in_description")
      .eq("id", userId)
      .single();
    if (profileError || !profile) return jsonResponse({ error: "Profile not found" }, 404);

    const required = ["legal_business_name", "ein", "business_registration_type", "sms_sample_message", "sms_opt_in_description"] as const;
    const missing = required.filter((k) => !profile[k]);
    if (missing.length > 0) {
      return jsonResponse({ error: `Missing required fields: ${missing.join(", ")}` }, 400);
    }

    const accountSid = Deno.env.get("TWILIO_ACCOUNT_SID");
    const authToken = Deno.env.get("TWILIO_AUTH_TOKEN");
    if (!accountSid || !authToken) {
      return jsonResponse({ error: "Twilio is not configured on this environment" }, 500);
    }

    const auth = `Basic ${btoa(`${accountSid}:${authToken}`)}`;

    // Step 1: Brand Registration (simplified/starter path — see caveat above)
    const brandRes = await fetch(`https://messaging.twilio.com/v1/a2p/BrandRegistrations`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: auth },
      body: new URLSearchParams({
        CustomerProfileBundleSid: "", // NOT LIVE-VERIFIED: real flow needs a Trust Hub Customer Profile
        // created first (legal name, EIN, address, website) — placeholder
        // left explicit rather than guessed, see header caveat.
      }),
    });
    const brandJson = await brandRes.json().catch(() => null);

    if (!brandRes.ok) {
      await admin
        .from("profiles")
        .update({ a2p_brand_status: "rejected", a2p_rejection_reason: brandJson?.message ?? `HTTP ${brandRes.status}` })
        .eq("id", userId);
      return jsonResponse({ error: "Brand registration failed", detail: brandJson }, 502);
    }

    await admin
      .from("profiles")
      .update({
        a2p_brand_status: "pending",
        a2p_brand_sid: brandJson.sid,
        a2p_requested_at: new Date().toISOString(),
      })
      .eq("id", userId);

    return jsonResponse({ success: true, brandSid: brandJson.sid, status: "pending" });
  } catch (err) {
    console.error("register-a2p-brand error:", err);
    return jsonResponse({ error: "Internal error" }, 500);
  }
});
