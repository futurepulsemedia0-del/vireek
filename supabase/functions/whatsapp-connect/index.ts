import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

interface RequestBody {
  phone_number_id?: string;
  access_token?: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) return jsonResponse({ error: "Missing Authorization header." }, 401);

    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
    const { data: userData, error: userError } = await admin.auth.getUser(jwt);
    if (userError || !userData?.user) return jsonResponse({ error: "Invalid or expired session." }, 401);

    const body = (await req.json()) as RequestBody;
    const phoneNumberId = (body.phone_number_id ?? "").trim();
    const accessToken = (body.access_token ?? "").trim();
    if (!phoneNumberId || !accessToken) return jsonResponse({ error: "Phone Number ID and access token are required." }, 400);

    // Verify the credentials actually work before saving them.
    const verifyRes = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}?fields=display_phone_number`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!verifyRes.ok) {
      return jsonResponse({ error: "Could not verify that Phone Number ID / access token with Meta. Double-check them." }, 400);
    }

    await admin.from("dm_channel_connections").upsert(
      { user_id: userData.user.id, channel: "whatsapp", external_account_id: phoneNumberId, access_token: accessToken, status: "connected", last_error: null },
      { onConflict: "channel,external_account_id" },
    );

    return jsonResponse({ success: true });
  } catch (error) {
    console.error(JSON.stringify({ event: "whatsapp_connect_failed", error: error instanceof Error ? error.message : String(error) }));
    return jsonResponse({ error: "Something went wrong connecting WhatsApp." }, 500);
  }
});
