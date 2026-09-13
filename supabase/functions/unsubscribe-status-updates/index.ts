// supabase/functions/unsubscribe-status-updates/index.ts
//
// Removes a row from `status_subscribers` given its unsubscribe_token.
// Called from src/pages/StatusUnsubscribePage.tsx when someone clicks
// the unsubscribe link in a status-update email (built in
// notify-status-subscribers/index.ts).
//
// This exists as an edge function (service role) rather than a public
// RLS DELETE policy on the table on purpose: a public DELETE policy
// would need `USING (true)` to work for anonymous requests, which lets
// any anonymous request attempt a delete against the table — safe only
// if every caller is well-behaved. Routing through a function that
// requires an exact token match keeps that boundary server-side.
//
// Deploy:
//   supabase functions deploy unsubscribe-status-updates

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface UnsubscribePayload {
  token?: string;
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ success: false, error: "Method not allowed" }, 405);
  }

  let payload: UnsubscribePayload;
  try {
    payload = (await req.json()) as UnsubscribePayload;
  } catch {
    return jsonResponse({ success: false, error: "Invalid JSON body" }, 400);
  }

  const token = (payload.token ?? "").trim();
  if (!token) {
    return jsonResponse({ success: false, error: "token is required" }, 400);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return jsonResponse({ success: false, error: "Server configuration error" }, 500);
  }

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const { data, error } = await admin
    .from("status_subscribers")
    .delete()
    .eq("unsubscribe_token", token)
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("Unsubscribe failed:", error);
    return jsonResponse({ success: false, error: "Failed to unsubscribe" }, 500);
  }

  if (!data) {
    // Already unsubscribed, or a bad/expired link — not an error the
    // visitor needs to see as a failure.
    return jsonResponse({ success: true, alreadyUnsubscribed: true });
  }

  return jsonResponse({ success: true, alreadyUnsubscribed: false });
});
