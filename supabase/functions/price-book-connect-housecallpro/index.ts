import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { verifyHousecallProKey } from "../_shared/price-book/housecallpro.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

interface RequestBody {
  api_key?: string;
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
    const userId = userData.user.id;

    const body = (await req.json()) as RequestBody;
    const apiKey = (body.api_key ?? "").trim();
    if (!apiKey) return jsonResponse({ error: "API key is required." }, 400);

    try {
      await verifyHousecallProKey(apiKey);
    } catch (error) {
      await admin.from("price_book_connections").upsert(
        { user_id: userId, provider: "housecall_pro", status: "error", hcp_api_key: apiKey, last_sync_error: error instanceof Error ? error.message : String(error) },
        { onConflict: "user_id,provider" },
      );
      return jsonResponse({ error: "Could not verify that Housecall Pro API key. Double-check it and try again." }, 400);
    }

    await admin.from("price_book_connections").upsert(
      {
        user_id: userId,
        provider: "housecall_pro",
        status: "connected",
        hcp_api_key: apiKey,
        last_synced_at: new Date().toISOString(),
        last_sync_error: null,
      },
      { onConflict: "user_id,provider" },
    );

    return jsonResponse({ success: true });
  } catch (error) {
    console.error(JSON.stringify({ event: "price_book_connect_housecallpro_failed", error: error instanceof Error ? error.message : String(error) }));
    return jsonResponse({ error: "Something went wrong connecting Housecall Pro." }, 500);
  }
});
