// supabase/functions/escalate-emergency/index.ts
//
// Records that an emergency call is being escalated to a technician/contact
// (sets calls.escalated_at + calls.escalated_to) and logs the event so a
// future step can plug in a real Twilio SMS / voice call or a Vapi outbound
// call. Intended to be called from your emergency-call workflow (Vapi tool
// call, Zapier step, or the dashboard) right after a call is flagged
// is_emergency = true — see src/pages/CallsPage.tsx.
//
// Optional secret (recommended — locks the endpoint down so only your own
// automations can trigger an escalation):
//   supabase secrets set ESCALATION_WEBHOOK_SECRET=some-long-random-string
// If set, callers must send it back as: X-Webhook-Secret: some-long-random-string
// If not set, the check is skipped (endpoint stays open, as it is today) so
// this won't break anything already wired up in Vapi/Zapier.
//
// Deploy:
//   supabase functions deploy escalate-emergency

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Webhook-Secret",
};

interface EmergencyPayload {
  call_id?: string;
  user_id?: string;
  caller_phone?: string;
  caller_name?: string;
  summary?: string;
  contact_phone?: string;
  caller_language?: string;
  address?: string;
  issue_description?: string;
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  const requestId = crypto.randomUUID();

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ success: false, error: "Method not allowed", requestId }, 405);
  }

  try {
    // Optional shared-secret check. Only enforced if you've set
    // ESCALATION_WEBHOOK_SECRET, so existing no-code setups keep working
    // until you choose to lock it down.
    const expectedSecret = Deno.env.get("ESCALATION_WEBHOOK_SECRET");
    if (expectedSecret) {
      const providedSecret = req.headers.get("X-Webhook-Secret");
      if (providedSecret !== expectedSecret) {
        console.error(JSON.stringify({ event: "emergency_escalation_unauthorized", requestId }));
        return jsonResponse({ success: false, error: "Unauthorized", requestId }, 401);
      }
    }

    let payload: EmergencyPayload;
    try {
      payload = (await req.json()) as EmergencyPayload;
    } catch {
      return jsonResponse({ success: false, error: "Invalid JSON body", requestId }, 400);
    }

    console.log(JSON.stringify({ event: "emergency_escalation_received", requestId, payload }));

    if (!payload.call_id) {
      return jsonResponse({ success: false, error: "Missing call_id", requestId }, 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceKey) {
      console.error("Missing Supabase environment variables");
      return jsonResponse({ success: false, error: "Server configuration error", requestId }, 500);
    }

    const supabase = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    /*
      Resolve which phone number this escalation should actually go to.
      If the caller's language was detected and an active technician
      lists that language, route straight to that technician's own
      number instead of the generic contact_phone the caller sent — this
      is what lets a Spanish call go directly to a Spanish-speaking
      technician instead of just being answered in Spanish. Falls back
      to payload.contact_phone (today's behavior) whenever there's no
      language match, so nothing changes for accounts that haven't set
      languages on their technicians yet.
    */
    const { data: existingCall, error: fetchError } = await supabase
      .from("calls")
      .select("id, user_id")
      .eq("id", payload.call_id)
      .maybeSingle();

    if (fetchError) {
      console.error("Database lookup failed", fetchError);
      return jsonResponse({ success: false, error: "Failed looking up call", requestId }, 500);
    }

    if (!existingCall) {
      return jsonResponse({ success: false, error: "Call not found", requestId }, 404);
    }

    let resolvedContactPhone = payload.contact_phone ?? null;
    let routedTechnician: { name: string | null; phone: string } | null = null;

    if (payload.caller_language) {
      const normalizedLanguage = payload.caller_language.trim().toLowerCase();
      const { data: technicians, error: techError } = await supabase
        .from("team_members")
        .select("member_name, member_phone, languages")
        .eq("account_owner_id", existingCall.user_id)
        .eq("role", "technician")
        .eq("dispatch_enabled", true)
        .not("member_phone", "is", null);

      if (techError) {
        console.error("Technician lookup failed", techError);
      } else {
        const match = (technicians ?? []).find((t) =>
          (t.languages ?? []).some((lang: string) => lang.trim().toLowerCase() === normalizedLanguage)
        );
        if (match?.member_phone) {
          resolvedContactPhone = match.member_phone;
          routedTechnician = { name: match.member_name, phone: match.member_phone };
        }
      }
    }

    const { data: updatedCall, error: updateError } = await supabase
      .from("calls")
      .update({
        escalated_at: new Date().toISOString(),
        escalated_to: resolvedContactPhone,
        detected_language: payload.caller_language ?? null,
      })
      .eq("id", payload.call_id)
      .select("id, user_id")
      .maybeSingle();

    if (updateError) {
      console.error("Database update failed", updateError);
      return jsonResponse({ success: false, error: "Failed updating call escalation", requestId }, 500);
    }

    if (!updatedCall) {
      // .update().eq() matches zero rows silently instead of throwing, so
      // this check is what actually catches a bad/unknown call_id.
      return jsonResponse({ success: false, error: "Call not found", requestId }, 404);
    }

    if (payload.user_id && updatedCall.user_id !== payload.user_id) {
      // Defensive check only — the row is already updated at this point
      // since service-role writes bypass RLS. Surfacing a mismatch here
      // just makes a wrong call_id/user_id pairing visible in the logs.
      console.error(
        JSON.stringify({
          event: "emergency_escalation_user_mismatch",
          requestId,
          call_id: payload.call_id,
          expected_user_id: payload.user_id,
          actual_user_id: updatedCall.user_id,
        }),
      );
    }

    /*
      Future production integration:

      1. Twilio SMS
      2. Twilio Voice call
      3. Vapi outbound emergency call

      This section intentionally stays isolated so external providers
      cannot break the emergency database workflow above.
    */
    console.log(
      JSON.stringify({
        event: "emergency_ready_for_provider",
        requestId,
        technician: resolvedContactPhone,
        routed_by_language: routedTechnician ? payload.caller_language : null,
        customer: payload.caller_phone,
        issue: payload.issue_description ?? payload.summary,
      }),
    );

    return jsonResponse({
      success: true,
      requestId,
      message: "Emergency escalation processed",
      escalation: {
        call_id: payload.call_id,
        technician: resolvedContactPhone,
        routed_technician_name: routedTechnician?.name ?? null,
        matched_by_language: routedTechnician ? payload.caller_language ?? null : null,
      },
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "emergency_function_error",
        requestId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return jsonResponse({ success: false, error: "Internal server error", requestId }, 500);
  }
});
